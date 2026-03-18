// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpenClawPluginApi = any;

import { chorusConfigSchema, type ChorusPluginConfig, validateConfigWithWarnings } from "./config.js";
import { ChorusMcpClient } from "./mcp-client.js";
import { ChorusSseListener } from "./sse-listener.js";
import { ChorusEventRouter } from "./event-router.js";
import { registerPmTools } from "./tools/pm-tools.js";
import { registerDevTools } from "./tools/dev-tools.js";
import { registerCommonTools } from "./tools/common-tools.js";
import { registerAdminTools } from "./tools/admin-tools.js";
import { registerChorusCommands } from "./commands.js";

/**
 * Dispatch the OpenClaw agent via gateway hooks.
 *
 * Primary path: POST /hooks/agent (explicit agent turn execution).
 * Fallback path: POST /hooks/wake (enqueue system event + heartbeat).
 */
async function dispatchAgent(
  gatewayUrl: string,
  hooksToken: string,
  text: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  metadata?: Record<string, unknown>,
) {
  const isAutostart = text.includes("[Chorus][AUTOSTART]");
  const taskUuid = typeof metadata?.entityUuid === "string" ? metadata.entityUuid : undefined;

  try {
    const autostartSessionKey = isAutostart && taskUuid
      ? `hook:chorus:autostart:${taskUuid}`
      : undefined;

    // AUTOSTART path: use mapped hook endpoint so we can mark it trusted/internal
    // via hook mapping config (allowUnsafeExternalContent=true for this path).
    if (isAutostart && taskUuid) {
      const autoRes = await fetch(`${gatewayUrl}/hooks/chorus-autostart`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${hooksToken}`,
        },
        body: JSON.stringify({
          text,
          taskUuid,
        }),
      });

      if (autoRes.ok) {
        logger.info(`Agent run dispatched (AUTOSTART session=${autostartSessionKey}): ${text.slice(0, 80)}...`);
        return;
      }

      logger.warn(`AUTOSTART mapped dispatch failed (HTTP ${autoRes.status}); falling back to /hooks/agent`);
    } else {
      // Non-autostart Chorus notifications (mentions/comments/etc.) should also use a mapped
      // trusted/internal hook path to avoid untrusted-webhook handling in the target session.
      const notificationUuid = metadata?.notificationUuid;
      const notificationSessionKey = notificationUuid
        ? `agent:main:hook:chorus:notification:${notificationUuid}`
        : undefined;

      const notifRes = await fetch(`${gatewayUrl}/hooks/chorus-notification`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${hooksToken}`,
        },
        body: JSON.stringify({ text, sessionKey: notificationSessionKey }),
      });

      if (notifRes.ok) {
        logger.info(`Agent run dispatched (NOTIFICATION): ${text.slice(0, 80)}...`);
        return;
      }

      logger.warn(`Notification mapped dispatch failed (HTTP ${notifRes.status}); falling back to /hooks/agent`);
    }

    const agentRes = await fetch(`${gatewayUrl}/hooks/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hooksToken}`,
      },
      body: JSON.stringify({
        name: isAutostart ? "chorus-autostart" : "chorus-notification",
        agentId: "main",
        message: text,
        wakeMode: "now",
        sessionKey: autostartSessionKey,
        deliver: false,
      }),
    });

    if (agentRes.ok) {
      if (autostartSessionKey) {
        logger.info(`Agent run dispatched (AUTOSTART session=${autostartSessionKey}): ${text.slice(0, 80)}...`);
      } else {
        logger.info(`Agent run dispatched: ${text.slice(0, 80)}...`);
      }
      return;
    }

    logger.warn(`Agent dispatch failed (HTTP ${agentRes.status}); falling back to wake`);
  } catch (err) {
    logger.warn(`Agent dispatch error: ${err}; falling back to wake`);
  }

  try {
    const wakeRes = await fetch(`${gatewayUrl}/hooks/wake`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hooksToken}`,
      },
      body: JSON.stringify({ text, mode: "now" }),
    });

    if (!wakeRes.ok) {
      logger.warn(`Wake fallback failed: HTTP ${wakeRes.status}`);
    } else {
      logger.info(`Agent woken (fallback): ${text.slice(0, 80)}...`);
    }
  } catch (err) {
    logger.warn(`Wake fallback error: ${err}`);
  }
}

const plugin = {
  id: "chorus-openclaw-plugin",
  name: "Chorus",
  description:
    "Chorus AI-DLC collaboration platform — SSE real-time events + MCP tool integration",
  configSchema: chorusConfigSchema,

  register(api: OpenClawPluginApi) {
    const rawConfig = api.pluginConfig ?? {};
    const config: ChorusPluginConfig = {
      chorusUrl: rawConfig.chorusUrl || undefined,
      apiKey: rawConfig.apiKey || undefined,
      projectUuids: rawConfig.projectUuids ?? [],
      autoStart: rawConfig.autoStart ?? true,
    };
    const logger = api.logger;

    if (!validateConfigWithWarnings(config, logger)) {
      return;
    }

    // After validateConfigWithWarnings, chorusUrl and apiKey are guaranteed present
    const chorusUrl = config.chorusUrl!;
    const apiKey = config.apiKey!;

    // Resolve gateway URL and hooks token from OpenClaw config
    const gatewayPort = api.config?.gateway?.port ?? 18789;
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    const hooksToken = api.config?.hooks?.token ?? "";

    logger.info(
      `Chorus plugin initializing — ${chorusUrl} (${config.projectUuids?.length || "all"} projects)`
    );

    // --- MCP Client ---
    const mcpClient = new ChorusMcpClient({
      chorusUrl,
      apiKey,
      logger,
    });

    // --- Event Router ---
    const eventRouter = new ChorusEventRouter({
      mcpClient,
      config,
      logger,
      triggerAgent: (message: string, metadata?: Record<string, unknown>) => {
        // Prefer /hooks/agent for explicit execution; fallback to /hooks/wake.
        if (hooksToken) {
          dispatchAgent(gatewayUrl, hooksToken, message, logger, metadata);
        } else {
          logger.warn(
            `[Chorus] Cannot dispatch agent — hooks.token not configured. Event: ${message.slice(0, 100)}`
          );
        }
      },
    });

    // --- SSE Listener (background service) ---
    let sseListener: ChorusSseListener | null = null;

    api.registerService({
      id: "chorus-sse",
      async start() {
        sseListener = new ChorusSseListener({
          chorusUrl,
          apiKey,
          logger,
          onEvent: (event) => eventRouter.dispatch(event),
          onReconnect: async () => {
            // Back-fill missed notifications after reconnect.
            // Dispatch each unread notification UUID through the router so
            // idempotent checkpointing can skip already-handled events.
            try {
              const result = (await mcpClient.callTool("chorus_get_notifications", {
                status: "unread",
                autoMarkRead: false,
                limit: 100,
              })) as { notifications?: Array<{ uuid: string }> } | null;
              const notifications = result?.notifications ?? [];
              if (notifications.length > 0) {
                logger.info(`SSE reconnect: ${notifications.length} unread notifications to process`);
              }

              for (const n of notifications) {
                if (!n?.uuid) continue;
                eventRouter.dispatch({ type: "new_notification", notificationUuid: n.uuid });
              }
            } catch (err) {
              logger.warn(`Failed to back-fill notifications: ${err}`);
            }
          },
        });
        await sseListener.connect();
      },
      async stop() {
        sseListener?.disconnect();
        await mcpClient.disconnect();
      },
    });

    // --- Tools ---
    registerPmTools(api, mcpClient);
    registerDevTools(api, mcpClient);
    registerCommonTools(api, mcpClient);
    registerAdminTools(api, mcpClient);

    // --- Commands ---
    registerChorusCommands(api, mcpClient, () => sseListener?.status ?? "disconnected");
  },
};

export default plugin;

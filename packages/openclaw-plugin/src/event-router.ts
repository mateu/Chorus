import type { ChorusMcpClient } from "./mcp-client.js";
import type { ChorusPluginConfig } from "./config.js";
import type { SseNotificationEvent } from "./sse-listener.js";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface ChorusEventRouterOptions {
  mcpClient: ChorusMcpClient;
  config: ChorusPluginConfig;
  triggerAgent: (message: string, metadata?: Record<string, unknown>) => void;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

/**
 * Notification detail returned from chorus_get_notifications.
 * Only the fields we need for routing.
 */
interface NotificationDetail {
  uuid: string;
  projectUuid: string;
  entityType: string;
  entityUuid: string;
  entityTitle: string;
  action: string;
  message: string;
  actorType: string;
  actorUuid: string;
  actorName: string;
}

interface TaskDetail {
  uuid?: string;
  status?: string;
  assigneeType?: string | null;
  assigneeUuid?: string | null;
}

interface ActiveTaskRun {
  startedAt: number;
  notificationUuid: string;
  timeoutId?: ReturnType<typeof setTimeout>;
}

export class ChorusEventRouter {
  private readonly mcpClient: ChorusMcpClient;
  private readonly config: ChorusPluginConfig;
  private readonly triggerAgent: ChorusEventRouterOptions["triggerAgent"];
  private readonly logger: ChorusEventRouterOptions["logger"];
  private readonly projectFilter: Set<string>;
  private readonly activeTaskRuns: Map<string, ActiveTaskRun> = new Map();
  private readonly runStallMs = 15 * 60 * 1000;
  private readonly handledNotifications = new Set<string>();
  private readonly handledStatePath = path.join(
    process.env.HOME || ".",
    ".openclaw",
    "state",
    "chorus",
    "handled-notifications.json"
  );
  private readonly handledReady: Promise<void>;

  constructor(opts: ChorusEventRouterOptions) {
    this.mcpClient = opts.mcpClient;
    this.config = opts.config;
    this.triggerAgent = opts.triggerAgent;
    this.logger = opts.logger;
    this.projectFilter = new Set(opts.config.projectUuids ?? []);
    this.handledReady = this.loadHandledNotifications();
  }

  /**
   * Route an incoming SSE notification event to the appropriate handler.
   * Never throws — all errors are caught and logged internally.
   */
  dispatch(event: SseNotificationEvent): void {
    // Only handle new_notification events (ignore count_update, etc.)
    if (event.type !== "new_notification") {
      this.logger.info(`SSE event type "${event.type}" ignored`);
      return;
    }

    if (!event.notificationUuid) {
      this.logger.warn("new_notification event missing notificationUuid, skipping");
      return;
    }

    // Fetch full notification details and route asynchronously
    this.fetchAndRoute(event.notificationUuid).catch((err) => {
      this.logger.error(`Failed to fetch/route notification ${event.notificationUuid}: ${err}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async fetchAndRoute(notificationUuid: string): Promise<void> {
    await this.handledReady;

    if (this.handledNotifications.has(notificationUuid)) {
      this.logger.info(`Skipping already-handled notification ${notificationUuid}`);
      return;
    }

    // Fetch notification details via MCP — use autoMarkRead=false so we don't
    // consume all unread notifications, and status=unread since we just received it.
    // Add retry/backoff for startup races ("Server not initialized").
    const result = await this.fetchNotificationsWithRetry(notificationUuid);

    const notifications = result?.notifications;
    if (!notifications || !Array.isArray(notifications)) {
      this.logger.warn(`Could not fetch notifications list`);
      return;
    }

    const notification = notifications.find((n) => n.uuid === notificationUuid);
    if (!notification) {
      this.logger.warn(`Notification ${notificationUuid} not found in unread list`);
      return;
    }

    // Project filter: if projectUuids is configured, ignore events from other projects
    if (this.projectFilter.size > 0 && !this.projectFilter.has(notification.projectUuid)) {
      this.logger.info(
        `Notification for project ${notification.projectUuid} filtered out`
      );
      return;
    }

    // Route based on action (which corresponds to notificationType)
    try {
      switch (notification.action) {
        case "task_assigned":
          await this.handleTaskAssigned(notification);
          break;
        case "mentioned":
          this.handleMentioned(notification);
          break;
        case "elaboration_requested":
          this.handleElaborationRequested(notification);
          break;
        case "elaboration_answered":
          this.handleElaborationAnswered(notification);
          break;
        case "proposal_rejected":
          this.handleProposalRejected(notification);
          break;
        case "proposal_approved":
          this.handleProposalApproved(notification);
          break;
        case "idea_claimed":
          this.handleIdeaClaimed(notification);
          break;
        case "task_verified":
          this.handleTaskVerified(notification);
          break;
        case "task_reopened":
          this.handleTaskReopened(notification);
          break;
        case "comment_added":
          this.handleCommentAdded(notification);
          break;
        default:
          this.logger.info(`Unhandled notification action: "${notification.action}"`);
          break;
      }

      await this.markNotificationHandled(notification.uuid);
    } catch (err) {
      this.logger.error(`Error handling ${notification.action} notification: ${err}`);
    }
  }

  private async loadHandledNotifications(): Promise<void> {
    try {
      const raw = await fs.readFile(this.handledStatePath, "utf8");
      const parsed = JSON.parse(raw) as { uuids?: string[] };
      for (const uuid of parsed.uuids ?? []) {
        if (typeof uuid === "string") this.handledNotifications.add(uuid);
      }
      if (this.handledNotifications.size > 0) {
        this.logger.info(`Loaded ${this.handledNotifications.size} handled Chorus notification checkpoint(s)`);
      }
    } catch {
      // First run or no checkpoint file yet.
    }
  }

  private async persistHandledNotifications(): Promise<void> {
    const dir = path.dirname(this.handledStatePath);
    await fs.mkdir(dir, { recursive: true });
    const payload = JSON.stringify({ uuids: Array.from(this.handledNotifications).slice(-2000) });
    await fs.writeFile(this.handledStatePath, payload, "utf8");
  }

  private async markNotificationHandled(notificationUuid: string): Promise<void> {
    this.handledNotifications.add(notificationUuid);
    try {
      await this.persistHandledNotifications();
    } catch (err) {
      this.logger.warn(`Failed to persist handled notification checkpoint for ${notificationUuid}: ${err}`);
    }
  }

  private async fetchNotificationsWithRetry(notificationUuid: string): Promise<{ notifications?: NotificationDetail[] } | null> {
    const maxAttempts = 8;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.mcpClient.callTool("chorus_get_notifications", {
          status: "unread",
          limit: 50,
          autoMarkRead: false,
        }) as { notifications?: NotificationDetail[] } | null;
      } catch (err) {
        const message = String(err ?? "");
        const initRace = /server not initialized/i.test(message);
        const shouldRetry = initRace && attempt < maxAttempts;

        if (!shouldRetry) {
          throw err;
        }

        const delayMs = Math.min(500 * attempt, 3000);
        this.logger.warn(
          `Notification ${notificationUuid}: MCP not initialized yet (attempt ${attempt}/${maxAttempts}); retrying in ${delayMs}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return null;
  }

  /**
   * Build @mention guidance for agent messages.
   * Instructs the agent to @mention the actor after completing work.
   */
  private buildMentionGuidance(n: NotificationDetail, entityType: string): string {
    return (
      `After completing your work, post a comment on this ${entityType} using chorus_add_comment with @mention:\n` +
      `Use this exact mention format: @[${n.actorName}](${n.actorType}:${n.actorUuid})`
    );
  }

  private async handleTaskAssigned(n: NotificationDetail): Promise<void> {
    const mentionGuidance = this.buildMentionGuidance(n, "task");

    if (this.config.autoStart) {
      const existing = this.activeTaskRuns.get(n.entityUuid);
      if (existing) {
        this.logger.info(
          `Task ${n.entityUuid} already has active autostart run (since ${new Date(existing.startedAt).toISOString()}); skipping duplicate dispatch`
        );
        return;
      }

      try {
        const task = await this.getTaskDetail(n.entityUuid);
        const status = task.status?.toLowerCase();

        if (status === "open") {
          await this.mcpClient.callTool("chorus_claim_task", { taskUuid: n.entityUuid });
          this.logger.info(`Auto-claimed open task ${n.entityUuid}`);
        } else if (status === "assigned") {
          this.logger.info(`Task ${n.entityUuid} already assigned; skipping auto-claim`);
        } else if (status) {
          this.logger.info(`Task ${n.entityUuid} in status '${status}'; skipping auto-claim`);
        } else {
          this.logger.warn(`Task ${n.entityUuid} status unavailable; attempting auto-claim as fallback`);
          await this.mcpClient.callTool("chorus_claim_task", { taskUuid: n.entityUuid });
          this.logger.info(`Auto-claimed task ${n.entityUuid} (fallback path)`);
        }
      } catch (err) {
        this.logger.warn(`Failed auto-claim preflight/claim for task ${n.entityUuid}: ${err}`);
      }

      try {
        await this.mcpClient.callTool("chorus_report_work", {
          taskUuid: n.entityUuid,
          report: "AUTOSTART accepted by plugin orchestrator; worker startup requested.",
          status: "in_progress",
        });
        this.logger.info(`Task ${n.entityUuid} marked in_progress via chorus_report_work before AUTOSTART dispatch`);
      } catch (err) {
        this.logger.warn(`Pre-dispatch chorus_report_work failed for task ${n.entityUuid}: ${err}`);
      }

      this.startTaskRunTracking(n.entityUuid, n.uuid);

      this.triggerAgent(
        `[Chorus][AUTOSTART] Plugin-orchestrated run request. ` +
        `Task UUID: ${n.entityUuid}, Project UUID: ${n.projectUuid}.\n` +
        `Do this directly in THIS session (no worker spawning): ` +
        `1) fetch task details for ${n.entityUuid}, ` +
        `2) complete the assigned work, ` +
        `3) post outcome via chorus_report_work, ` +
        `4) add mention comment only when required by task/notification.\n` +
        `Hard rule: DO NOT spawn ACP/subagent workers for this autostart task.\n` +
        `If chorus_get_task/chorus_report_work/chorus_add_comment are unavailable in this runtime, use fallback API interface directly:\n` +
        `- script: /home/hunter/.openclaw/workspace/project/chorus/Chorus/public/chorus-plugin/bin/chorus-api.sh\n` +
        `- set CHORUS_URL from plugin config (chorus-openclaw-plugin.config.chorusUrl)\n` +
        `- set CHORUS_API_KEY from plugin config (chorus-openclaw-plugin.config.apiKey)\n` +
        `Then call mcp-tool methods to complete steps 1/3/4.\n` +
        `${mentionGuidance}`,
        { notificationUuid: n.uuid, action: "task_assigned", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
      );
    } else {
      this.triggerAgent(
        `[Chorus] Task assigned: ${n.entityTitle}. Task UUID: ${n.entityUuid}, Project UUID: ${n.projectUuid}. Use chorus_get_task to review when ready.\n${mentionGuidance}`,
        { notificationUuid: n.uuid, action: "task_assigned", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
      );
    }
  }

  private async getTaskDetail(taskUuid: string): Promise<TaskDetail> {
    const result = await this.mcpClient.callTool("chorus_get_task", { taskUuid });

    if (!result || typeof result !== "object") return {};

    const asRecord = result as Record<string, unknown>;
    const taskCandidate = asRecord.task;

    if (taskCandidate && typeof taskCandidate === "object") {
      return taskCandidate as TaskDetail;
    }

    return asRecord as TaskDetail;
  }

  private startTaskRunTracking(taskUuid: string, notificationUuid: string): void {
    this.clearTaskRunTracking(taskUuid);

    const timeoutId = setTimeout(() => {
      this.handleTaskRunStall(taskUuid).catch((err) => {
        this.logger.warn(`Failed stalled-run handler for task ${taskUuid}: ${err}`);
      });
    }, this.runStallMs);

    this.activeTaskRuns.set(taskUuid, {
      startedAt: Date.now(),
      notificationUuid,
      timeoutId,
    });
  }

  private clearTaskRunTracking(taskUuid: string): void {
    const existing = this.activeTaskRuns.get(taskUuid);
    if (existing?.timeoutId) {
      clearTimeout(existing.timeoutId);
    }
    this.activeTaskRuns.delete(taskUuid);
  }

  private async handleTaskRunStall(taskUuid: string): Promise<void> {
    const run = this.activeTaskRuns.get(taskUuid);
    if (!run) return;

    const ageMin = Math.round((Date.now() - run.startedAt) / 60000);

    try {
      await this.mcpClient.callTool("chorus_report_work", {
        taskUuid,
        report: `AUTOSTART monitor: task still in progress after ${ageMin} minutes; run appears stalled or silent.`,
      });
      this.logger.warn(`Task ${taskUuid} appears stalled after ${ageMin}m; posted status note`);
    } catch (err) {
      this.logger.warn(`Failed to post stalled status for task ${taskUuid}: ${err}`);
    }

    this.clearTaskRunTracking(taskUuid);
  }

  private handleMentioned(n: NotificationDetail): void {
    // Hardening: avoid duplicate execution when both "mentioned" and
    // "comment_added" fire for the same user comment. The comment_added
    // path is now the deterministic single execution path.
    this.logger.info(
      `Skipping mentioned follow-up execution for ${n.entityType} ${n.entityUuid}; comment_added is authoritative to reduce duplicate runs`
    );
  }

  private handleElaborationRequested(n: NotificationDetail): void {
    this.triggerAgent(
      `[Chorus] Elaboration requested for idea '${n.entityTitle}' (ideaUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). Use chorus_get_elaboration to review questions.`,
      { notificationUuid: n.uuid, action: "elaboration_requested", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
    );
  }

  private handleProposalRejected(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, "proposal");

    this.triggerAgent(
      `[Chorus] Proposal '${n.entityTitle}' was REJECTED (proposalUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). Review note: "${n.message}". ` +
      `Use chorus_get_proposal to review the proposal, then fix issues with chorus_update_task_draft / chorus_update_document_draft. ` +
      `After fixing, call chorus_validate_proposal then chorus_submit_proposal to resubmit.\n` +
      mentionGuidance,
      { notificationUuid: n.uuid, action: "proposal_rejected", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
    );
  }

  private handleProposalApproved(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, "proposal");

    const reviewInfo = n.message.includes("Note: ") ? ` Review note: "${n.message.split("Note: ").pop()}"` : "";
    this.triggerAgent(
      `[Chorus] Proposal '${n.entityTitle}' was APPROVED (proposalUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid})!${reviewInfo} Documents and tasks have been created. ` +
      `Use chorus_get_available_tasks with projectUuid: "${n.projectUuid}" to see the new tasks ready for work.\n` +
      mentionGuidance,
      { notificationUuid: n.uuid, action: "proposal_approved", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
    );
  }

  private handleIdeaClaimed(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, "idea");

    this.triggerAgent(
      `[Chorus] Idea '${n.entityTitle}' has been assigned to you (ideaUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). ` +
      `Use chorus_get_idea to review the idea, then chorus_claim_idea to start elaboration.\n` +
      mentionGuidance,
      { notificationUuid: n.uuid, action: "idea_claimed", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
    );
  }

  private handleTaskVerified(n: NotificationDetail): void {
    this.clearTaskRunTracking(n.entityUuid);

    this.triggerAgent(
      `[Chorus] Task '${n.entityTitle}' has been verified and is now done (taskUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). ` +
      `Check if this unblocks other tasks: use chorus_get_unblocked_tasks with projectUuid "${n.projectUuid}" to find tasks that are now ready to start.`,
      { notificationUuid: n.uuid, action: "task_verified", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
    );
  }

  private handleTaskReopened(n: NotificationDetail): void {
    this.clearTaskRunTracking(n.entityUuid);
    const mentionGuidance = this.buildMentionGuidance(n, "task");

    this.triggerAgent(
      `[Chorus] Task '${n.entityTitle}' has been reopened and needs rework (taskUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). ` +
      `Use chorus_get_task to review the task and chorus_get_comments to see verification feedback, then fix the issues.\n${mentionGuidance}`,
      { notificationUuid: n.uuid, action: "task_reopened", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
    );
  }

  private handleElaborationAnswered(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, "idea");

    this.triggerAgent(
      `[Chorus] Elaboration answers submitted for idea '${n.entityTitle}' (ideaUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). ` +
      `Review the answers with chorus_get_elaboration, then either:\n` +
      `- Call chorus_validate_elaboration with empty issues [] to resolve and proceed to proposal creation\n` +
      `- Call chorus_validate_elaboration with issues + followUpQuestions for another round\n\n` +
      `After reviewing, @mention the answerer to ask if they have any further questions before you proceed.\n` +
      mentionGuidance,
      { notificationUuid: n.uuid, action: "elaboration_answered", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
    );
  }

  private handleCommentAdded(n: NotificationDetail): void {
    // Ignore obvious self-generated comment events to reduce reply loops/noise.
    if (n.actorType === "agent" && n.actorName.toLowerCase().includes("openclaw index")) {
      this.logger.info(`Ignoring self-authored comment_added on ${n.entityType} ${n.entityUuid}`);
      return;
    }

    const body = n.message || "";
    const mentionGuidance = this.buildMentionGuidance(n, n.entityType);

    this.logger.info(
      `Routing comment_added for ${n.entityType} ${n.entityUuid}; follow-up decision will be made from live thread context`
    );

    this.triggerAgent(
      `[Chorus] New comment added in ${n.entityType} '${n.entityTitle}' (entityUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}).\n` +
      `Comment excerpt: ${body}\n` +
      `Deterministic bounded mode (no worker spawning, no broad diagnostics):\n` +
      `1) Read full thread context via chorus_get_comments(targetType: "${n.entityType}", targetUuid: "${n.entityUuid}")\n` +
      `2) Decide if action is required: respond only if latest thread explicitly requests OpenClaw Index follow-up\n` +
      `3) If required and request is bracket health follow-up, run EXACTLY this one command and do not expand scope:\n` +
      `   timeout 25s ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 hunter@bracket.huntana.com 'echo HOST=$(hostname); echo TIME=$(date -Is); echo LOAD=$(cut -d" " -f1-3 /proc/loadavg); echo MEM_USED_TOTAL_MB=$(free -m | sed -n "2p" | tr -s " " | cut -d" " -f3,2 | tr " " "/"); echo SWAP_USED_TOTAL_MB=$(free -m | sed -n "3p" | tr -s " " | cut -d" " -f3,2 | tr " " "/"); echo DISK_USED_TOTAL_PCT=$(df -h / | sed -n "2p" | tr -s " " | cut -d" " -f3,2,5 | tr " " "/"); echo NGINX=$(sudo -n systemctl is-active nginx || true); echo APP3333=$(ss -ltn | grep -c ":3333 " || true); echo HTTPS=$(curl -s -o /dev/null -w "%{http_code}" https://bracket.huntana.com); echo LOGIN=$(curl -s -o /dev/null -w "%{http_code}" https://bracket.huntana.com/login)'\n` +
      `4) Post concise reply with chorus_add_comment on same target (include key=value outputs + one-line conclusion)\n` +
      `5) If no action is required, post no comment and exit cleanly\n` +
      `6) If work changes task state, use chorus_report_work accordingly\n` +
      `Hard rule: complete within 120s end-to-end; if blocked/timeout, post blocked comment immediately with exact error.\n` +
      `If chorus_get_comments/chorus_add_comment/chorus_report_work are unavailable in this runtime, use fallback API interface directly:\n` +
      `- script: /home/hunter/.openclaw/workspace/project/chorus/Chorus/public/chorus-plugin/bin/chorus-api.sh\n` +
      `- set CHORUS_URL from plugin config (chorus-openclaw-plugin.config.chorusUrl)\n` +
      `- set CHORUS_API_KEY from plugin config (chorus-openclaw-plugin.config.apiKey)\n` +
      `Then call mcp-tool methods to complete steps above.\n` +
      mentionGuidance,
      { notificationUuid: n.uuid, action: "comment_added", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
    );
  }
}

# GitHub Actions Policy (Fork-Only)

Repository: `mateu/Chorus`

## Intent
Keep CI/CD/workflow operations managed in the fork without creating upstream drift risk.

## Rules
1. Workflow development happens on feature branches (not directly on `main`).
2. Merge workflow updates into fork `main` via PR after checks pass.
3. Keep mutable/side-effect actions guarded to fork context (e.g., `if: github.repository == 'mateu/Chorus'`).
4. Store secrets/vars only in the fork repository settings.
5. Do not open upstream PRs for fork-ops workflows unless explicitly intended.

## Upstream Sync Practice
- `ops/github-actions-bootstrap` is the CI control branch.
- Sync by rebasing it on `origin/main` regularly.
- Resolve workflow conflicts by preserving fork safety guards unless intentionally changed.

## Automation (no-human-loop mode)
- `scripts/ci-sync-and-dispatch.sh`
  - fetches remote
  - rebases `ops/github-actions-bootstrap` onto `origin/main`
  - force-pushes with lease
  - dispatches CI workflows for open PR heads that changed
- `scripts/ci-dispatch-open-prs.sh`
  - scans open PRs to `main`
  - dispatches:
    - `.github/workflows/ci.yml`
    - `.github/workflows/test.yml`
    - `.github/workflows/docker-smoke.yml`
  - targets PR head SHA via `workflow_dispatch` input `target_ref`
  - stores last-seen PR SHA map in `.github/.ci-dispatch-state.json`

Recommended cron (every 15 min):
```cron
*/15 * * * * cd /home/hunter/.openclaw/workspace/project/chorus/Chorus && ./scripts/ci-sync-and-dispatch.sh >> /home/hunter/.openclaw/workspace/project/chorus/Chorus/note/ci-automation.log 2>&1
```

## Temporary Exception
- Lint is currently non-blocking in CI (`continue-on-error: true`) until baseline lint cleanup is completed.

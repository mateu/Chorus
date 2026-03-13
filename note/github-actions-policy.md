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
- Regularly merge/rebase `upstream/main` into fork branches.
- Resolve workflow conflicts by preserving fork safety guards unless intentionally changed.

## Temporary Exception
- Lint is currently non-blocking in CI (`continue-on-error: true`) until baseline lint cleanup is completed.

#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CONTROL_BRANCH="${CONTROL_BRANCH:-ops/github-actions-bootstrap}"
REMOTE="${REMOTE:-origin}"

cd "$REPO_DIR"

# Keep automation branch aligned with main.
git fetch "$REMOTE"
git checkout "$CONTROL_BRANCH"

if ! git rebase "$REMOTE/main"; then
  echo "Rebase conflict while syncing $CONTROL_BRANCH with $REMOTE/main" >&2
  git rebase --abort || true
  exit 2
fi

git push --force-with-lease "$REMOTE" "$CONTROL_BRANCH"

# Trigger CI workflows for open PRs with changed head SHAs.
"$REPO_DIR/scripts/ci-dispatch-open-prs.sh"

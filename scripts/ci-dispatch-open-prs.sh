#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-mateu/Chorus}"
CONTROL_REF="${CONTROL_REF:-ops/github-actions-bootstrap}"
STATE_FILE="${STATE_FILE:-.github/.ci-dispatch-state.json}"
WORKFLOWS=(
  "ci.yml"
  "test.yml"
  "docker-smoke.yml"
)

command -v gh >/dev/null || { echo "gh not found"; exit 1; }
command -v jq >/dev/null || { echo "jq not found"; exit 1; }

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$(dirname "$STATE_FILE")"
if [[ ! -f "$STATE_FILE" ]]; then
  echo '{}' > "$STATE_FILE"
fi

prs_json="$tmp_dir/prs.json"
gh api "repos/$REPO/pulls?state=open&base=main&per_page=100" > "$prs_json"

new_state="$(jq -c 'reduce .[] as $pr ({}; .[$pr.number|tostring] = $pr.head.sha)' "$prs_json")"

# Dispatch only when PR head SHA changes.
while IFS=$'\t' read -r pr_number head_sha head_ref; do
  [[ -z "$pr_number" ]] && continue

  prev_sha="$(jq -r --arg pr "$pr_number" '.[$pr] // ""' "$STATE_FILE")"
  if [[ "$prev_sha" == "$head_sha" ]]; then
    continue
  fi

  echo "Dispatching CI for PR #$pr_number ($head_ref @ $head_sha)"
  for wf in "${WORKFLOWS[@]}"; do
    gh api -X POST "repos/$REPO/actions/workflows/$wf/dispatches" \
      -f ref="$CONTROL_REF" \
      -f inputs[target_ref]="$head_sha" \
      -f inputs[pr_number]="$pr_number" \
      >/dev/null
  done
done < <(jq -r '.[] | [.number, .head.sha, .head.ref] | @tsv' "$prs_json")

printf '%s\n' "$new_state" > "$STATE_FILE"
echo "Done. tracked_prs=$(jq 'length' "$STATE_FILE")"

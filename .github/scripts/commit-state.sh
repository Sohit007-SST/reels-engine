#!/usr/bin/env bash
# Commit this workflow's OWN state files and push, with `git pull --rebase` and at most 3 tries.
# Usage: .github/scripts/commit-state.sh "<commit message>" <path> [<path> ...]
#
# Spec 8: state is partitioned (one file per reel per stage; each workflow writes only its own
# paths), so a rebase normally applies cleanly. If it cannot, we STOP (exit 1 => the workflow
# fails and the failure alert fires). Never force-push.
set -euo pipefail

msg="${1:?commit message required}"
shift
if [ "$#" -eq 0 ]; then
  echo "commit-state: no paths given" >&2
  exit 2
fi

git config user.name "reels-engine-bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# Stage only the paths this workflow owns (missing paths are fine).
existing=()
for p in "$@"; do
  if [ -e "$p" ]; then existing+=("$p"); fi
done
if [ "${#existing[@]}" -eq 0 ]; then
  echo "commit-state: nothing to commit (paths absent)"
  exit 0
fi
git add -- "${existing[@]}"

# Never commit secrets or media even if a path glob were too broad.
if git diff --cached --name-only | grep -E '(^|/)\.env($|\.)|\.(mp4|wav|mov|m4a)$' | grep -v '\.env\.example$'; then
  echo "commit-state: refusing to commit env/media files" >&2
  git reset -q
  exit 1
fi

if git diff --cached --quiet; then
  echo "commit-state: no changes"
  exit 0
fi
git commit -q -m "$msg" -m "run: ${GITHUB_RUN_ID:-local} (${GITHUB_WORKFLOW:-manual})"

branch="${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}"
for attempt in 1 2 3; do
  if git pull --rebase --quiet origin "$branch"; then
    if git push --quiet origin "HEAD:$branch"; then
      echo "commit-state: pushed on attempt $attempt"
      exit 0
    fi
  else
    git rebase --abort 2>/dev/null || true
    echo "commit-state: rebase conflict on attempt $attempt; state files are partitioned, so this needs a human" >&2
    exit 1
  fi
  sleep $((attempt * 5))
done
echo "commit-state: push failed after 3 attempts (no force-push)" >&2
exit 1

#!/usr/bin/env bash
# Notification-only Telegram alert for workflow failures (allowed in dry_run: no buttons, no writes
# to Instagram). Never fails the job and never prints the token or chat id.
# Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... .github/scripts/alert.sh "<text>"
set -uo pipefail
text="${1:-Reels Engine workflow alert}"
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  echo "alert: Telegram not configured (MISSING); alert only in the job log: $text"
  exit 0
fi
link="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --retry 2 --retry-delay 3 \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=ALERT: ${text}
${link}" 2>/dev/null || echo "000")
echo "alert: telegram responded HTTP ${code}"
exit 0

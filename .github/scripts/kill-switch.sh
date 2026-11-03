#!/usr/bin/env bash
# Workflow-level kill switch (the code re-checks data/control.json before EVERY external write).
# Writes paused=true|false and reason=... to $GITHUB_OUTPUT. Paused when:
#   - repository variable PIPELINE_PAUSED is "true" (passed in as env PIPELINE_PAUSED), or
#   - data/control.json says "paused": true, or exists but cannot be parsed (fail-safe).
set -euo pipefail
out="${GITHUB_OUTPUT:-/dev/stdout}"
paused=false
reason="running"
if [ "${PIPELINE_PAUSED:-false}" = "true" ]; then
  paused=true
  reason="PIPELINE_PAUSED variable is true"
elif [ -f data/control.json ]; then
  state=$(node -e '
    try {
      const c = JSON.parse(require("fs").readFileSync("data/control.json", "utf8"));
      process.stdout.write(c && c.paused === true ? "paused" : "running");
    } catch { process.stdout.write("unreadable"); }
  ')
  case "$state" in
    paused) paused=true; reason="paused via Telegram /pause (data/control.json)" ;;
    unreadable) paused=true; reason="data/control.json unreadable (fail-safe pause)" ;;
  esac
fi
echo "kill-switch: paused=${paused} (${reason})"
{
  echo "paused=${paused}"
  echo "reason=${reason}"
} >> "$out"

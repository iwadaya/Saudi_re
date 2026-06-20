#!/usr/bin/env bash
# scripts/run-with-alert.sh — run a scheduled job and fire a failure alert on a
# non-zero exit. Wraps the backup, restore-verification, snapshot-cleanup and
# LDF-refresh jobs so a silent cron failure can never go unnoticed.
#
# Usage:
#   scripts/run-with-alert.sh <job-name> -- <command> [args...]
#
# Config (environment):
#   ALERT_WEBHOOK_URL   Slack/Teams/Opsgenie-style incoming webhook (POST JSON).
#                       When unset, the failure is logged loudly but not delivered
#                       — set it so backup/restore drills page someone.
#   ALERT_SOURCE        Label for where the job ran (default: $RENDER_SERVICE_NAME
#                       or the hostname).
#
# Always exits with the wrapped command's exit code, so the scheduler also marks
# the run failed (belt-and-braces with the webhook).
set -uo pipefail

JOB="${1:?usage: run-with-alert.sh <job-name> -- <command...>}"; shift
[ "${1:-}" = "--" ] && shift
[ "$#" -gt 0 ] || { echo "[run-with-alert] no command given for job '$JOB'" >&2; exit 2; }

SOURCE="${ALERT_SOURCE:-${RENDER_SERVICE_NAME:-$(hostname 2>/dev/null || echo unknown)}}"
LOG="$(mktemp)"

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if "$@" >"$LOG" 2>&1; then code=0; else code=$?; fi

# Surface the job output to the scheduler's own logs regardless of outcome.
cat "$LOG"

if [ "$code" -ne 0 ]; then
  tail_lines="$(tail -n 25 "$LOG" 2>/dev/null | sed 's/[[:cntrl:]]/ /g')"
  echo "[run-with-alert] job '${JOB}' FAILED (exit ${code}) on ${SOURCE} at ${started}" >&2
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    # Minimal JSON payload understood by Slack/Teams "text" incoming webhooks.
    msg="🔴 scheduled job *${JOB}* FAILED (exit ${code}) on ${SOURCE} at ${started}"$'\n'"${tail_lines}"
    # Escape for JSON embedding.
    esc="$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}')"
    curl -fsS -m 15 -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"${esc}\"}" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 \
      || echo "[run-with-alert] WARNING: alert webhook POST failed" >&2
  else
    echo "[run-with-alert] WARNING: ALERT_WEBHOOK_URL is unset — failure NOT delivered. Configure it." >&2
  fi
fi

rm -f "$LOG"
exit "$code"

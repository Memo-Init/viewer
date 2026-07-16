#!/usr/bin/env bash
# PRD-031 (Memo 067 Phase 9, WI-8-04/05/06) — reverse-channel wait-loop building block.
#
# This is the documented SOP snippet a waiting session spawns as a BACKGROUND bash task before it
# blocks on the next user input. It costs 0 tokens while waiting: it only polls a flag file that the
# memo-view "Abschliessen" button drops via POST /api/session/<sessionId>/wake. On the button press
# the flag appears, the loop exits, the flag is removed (one-shot), and "WOKEN <id>" is printed —
# exactly one wake per press.
#
# Usage (background):   bash scripts/session-wake-arm.sh <sessionId> &
# Env:
#   WAKE_DIR                             override the flag dir (default: $TMPDIR/memo-view-wake,
#                                        matching os.tmpdir()+'/memo-view-wake' on the server side)
#   CLAUDE_CODE_DISABLE_BACKGROUND_TASKS WI-8-06 guard — if "1"/"true", NO background task is
#                                        spawned; the endpoint + flag stay usable, only auto-wake is off.
set -u

SESSION_ID="${1:-}"

if [ -z "$SESSION_ID" ]; then
    echo "usage: session-wake-arm.sh <sessionId>" >&2
    exit 2
fi

# WI-8-06 guard: respect the user's environment. Checked BEFORE any spawn/loop — graceful degradation.
if [ "${CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:-}" = "1" ] || [ "${CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:-}" = "true" ]; then
    echo "background tasks disabled — kein Auto-Wake, bitte manuell fortsetzen"
    exit 0
fi

WAKE_DIR="${WAKE_DIR:-${TMPDIR:-/tmp}/memo-view-wake}"
FLAG="$WAKE_DIR/$SESSION_ID.flag"
mkdir -p "$WAKE_DIR"

# WI-8-04 wait-loop: 0 tokens while waiting, exit on flag, one-shot cleanup.
until [ -f "$FLAG" ]; do sleep 1; done
# PRD-P3-03 (Memo 075 Phase 3, WI-010): the flag now carries a payload (the transcriptId / URL) —
# read it BEFORE the one-shot cleanup and echo it after WOKEN so the re-invoked agent knows which
# transcript to full-read without a second lookup. An empty flag keeps the historical "WOKEN <id>" form.
PAYLOAD="$( cat "$FLAG" 2>/dev/null )"
rm -f "$FLAG"
if [ -n "$PAYLOAD" ]; then
    echo "WOKEN $SESSION_ID $PAYLOAD"
else
    echo "WOKEN $SESSION_ID"
fi

#!/usr/bin/env bash
# PRD-031 (Memo 067 Phase 9, WI-8-04/05/06) — reverse-channel wait-loop building block.
#
# This is the documented SOP snippet a waiting session spawns as a BACKGROUND bash task before it
# blocks on the next user input. It costs 0 tokens while waiting: it only polls a flag file that the
# memo-view "Abschliessen" button drops via POST /api/session/<sessionId>/wake. On the button press
# the flag appears, the loop exits, the flag is removed (one-shot), and "WOKEN <id>" is printed —
# exactly one wake per press.
#
# ------------------------------------------------------------------------------------------------
# TRANSITIONAL — this file is built to be REMOVED (Memo 080 Phase 9, PRD-V10, WI-207)
#
#   Successor       PRD-V9, the long-running wait tool inside memo-view (F12=A, F31=A). That is the
#                   only road on which the answer reaches the AI IN THE TOOL RESULT instead of only
#                   in the terminal. This script delivers by PROCESS END: one watcher, one event.
#   Sunset marker   LONG_RUNNING_WAIT_LIVE = true in src/MemoView.mjs. PRD-V9 sets it AFTER its own
#                   first flight was green. Absent or false means this transition is still needed.
#   Sunset test     tests/unit/EventChannelSunsetPRDV10.test.mjs. It turns `npm test` RED on the day
#                   the marker is set while any sunset-list entry below still exists, so the
#                   transition cannot be kept silently.
#   Sunset list     what has to disappear once the marker is set:
#                     1. this file
#                     2. repos/core/skills/memo/memo-revision-execute/SKILL.md — rule 8 and workflow
#                        step 11 rewritten onto the PRD-V9 road, script references removed
#                     3. tests/unit/EventChannelSunsetPRDV10.test.mjs — the guard leaves with what
#                        it guards
#                     4. the script parts of tests/unit/ReverseChannelWakePRD031.test.mjs and
#                        tests/unit/Phase3ViewerFeatures.test.mjs — the route and flag assertions
#                        in those files stay
#                     5. the route and flag surface (/api/session/<id>/arm, /api/session/armed,
#                        /api/session/<id>/wake, writeWakeFlag, armSession, getArmedSessions,
#                        WAKE_DIR) ONLY if a full-text search shows no other caller — today the
#                        "Abschliessen" button calls them itself, so this check belongs to the
#                        removal, not to PRD-V10
# ------------------------------------------------------------------------------------------------
#
# Usage (background):   bash scripts/session-wake-arm.sh <sessionId> [transcriptId] &
#   one argument   historical behaviour, unchanged: no arming, no NEXT line, wait for the flag
#   two arguments  arm and wait are ONE action; a failing arm ends the process LOUDLY instead of
#                  waiting for a flag that can never arrive
#
# Exit codes:  0 woken (or guard) · 2 usage · 3 arming failed · 4 wait expired
#
# Env:
#   WAKE_DIR                             override the flag dir (default: $TMPDIR/memo-view-wake,
#                                        matching os.tmpdir()+'/memo-view-wake' on the server side)
#   MEMOVIEW_URL                         loopback base url of the already running server
#                                        (default: http://127.0.0.1:3333). Loopback only — this
#                                        script opens no port and starts no server.
#   WAKE_MAX_WAIT                        seconds before the wait gives up (default: 28800 = 8h).
#                                        Without a ceiling an abandoned watcher runs until reboot.
#   CLAUDE_CODE_DISABLE_BACKGROUND_TASKS WI-8-06 guard — if "1"/"true", NO background task is
#                                        spawned; the endpoint + flag stay usable, only auto-wake is off.
set -u

SESSION_ID="${1:-}"
TRANSCRIPT_ID="${2:-}"

if [ -z "$SESSION_ID" ]; then
    echo "usage: session-wake-arm.sh <sessionId> [transcriptId]" >&2
    exit 2
fi

# WI-8-06 guard: respect the user's environment. Checked BEFORE arming and BEFORE any loop —
# graceful degradation, and no network call is made on this branch.
if [ "${CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:-}" = "1" ] || [ "${CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:-}" = "true" ]; then
    echo "background tasks disabled — kein Auto-Wake, bitte manuell fortsetzen"
    exit 0
fi

WAKE_DIR="${WAKE_DIR:-${TMPDIR:-/tmp}/memo-view-wake}"
MEMOVIEW_URL="${MEMOVIEW_URL:-http://127.0.0.1:3333}"
WAKE_MAX_WAIT="${WAKE_MAX_WAIT:-28800}"
FLAG="$WAKE_DIR/$SESSION_ID.flag"
mkdir -p "$WAKE_DIR"

# ONE home for the restart line: it is emitted after WOKEN and after WAIT-EXPIRED, and it must read
# identically in both places — a second spelling would drift the moment one of them is edited.
NEXT_LINE=""

if [ -n "$TRANSCRIPT_ID" ]; then
    NEXT_LINE="NEXT: bash repos/viewer/scripts/session-wake-arm.sh $SESSION_ID $TRANSCRIPT_ID"
fi

# PRD-V10 gap 1: arming and waiting are ONE action. Starting this script without the preceding arm
# used to produce a silent forever-wait on a flag that never comes, and nothing reported it. With a
# transcriptId the script arms itself; a non-2xx answer or a server that is off ends the process.
if [ -n "$TRANSCRIPT_ID" ]; then
    if ! curl -sf -X POST "$MEMOVIEW_URL/api/session/$SESSION_ID/arm" \
        -H 'Content-Type: application/json' \
        -d "{\"transcriptId\":\"$TRANSCRIPT_ID\"}" > /dev/null; then
        echo "ARM-FAILED $SESSION_ID"
        exit 3
    fi
fi

# WI-8-04 wait-loop: 0 tokens while waiting, exit on flag, one-shot cleanup.
# PRD-V10 gap 3: the loop now has a ceiling. Without it an abandoned watcher outlives its session.
ELAPSED=0

until [ -f "$FLAG" ] || [ "$ELAPSED" -ge "$WAKE_MAX_WAIT" ]; do
    sleep 1
    ELAPSED=$(( ELAPSED + 1 ))
done

if [ ! -f "$FLAG" ]; then
    echo "WAIT-EXPIRED $SESSION_ID"
    if [ -n "$NEXT_LINE" ]; then
        echo "$NEXT_LINE"
    fi
    exit 4
fi

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

# PRD-V10 gap 2: one watcher, one event. The restart MUST live outside the process — a process that
# restarts itself never ends, and without a process end there is no notification. So the last line is
# the full restart command; the re-invoked session reads it first and the loop closes without memory.
if [ -n "$NEXT_LINE" ]; then
    echo "$NEXT_LINE"
fi

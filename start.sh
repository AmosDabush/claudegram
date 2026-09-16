#!/bin/bash
# Start Telegram bot with auto-restart and syntax checking
# Usage: ./start.sh [-s HOURS]  (e.g., ./start.sh -s 24)

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Under launchd (the waker) PATH is minimal and lacks node/homebrew — make start.sh
# self-sufficient so `node` is always found, no matter who launches it.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/bin:$PATH"
PID_FILE="$BOT_DIR/data/bot.pid"
LOCK_FILE="$BOT_DIR/data/start.lock"
LAST_ACTIVITY_FILE="$BOT_DIR/data/last_activity"
MAX_RETRIES=3

# Load IDLE_TIMEOUT_HOURS from .env (default: 24 hours)
IDLE_TIMEOUT_HOURS=24
if [ -f "$BOT_DIR/.env" ]; then
    source <(grep IDLE_TIMEOUT_HOURS "$BOT_DIR/.env" 2>/dev/null || echo "")
fi

# Parse command line arguments
while getopts "s:" opt; do
    case $opt in
        s)
            IDLE_TIMEOUT_HOURS=$OPTARG
            ;;
        \?)
            echo "Usage: $0 [-s HOURS]"
            exit 1
            ;;
    esac
done

mkdir -p "$BOT_DIR/data"

# Simple lock to prevent concurrent starts
if [ -f "$LOCK_FILE" ]; then
    LOCK_AGE=$(($(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0)))
    if [ "$LOCK_AGE" -lt 10 ]; then
        echo "⏳ Another start in progress, waiting..."
        sleep 3
    fi
fi
touch "$LOCK_FILE"

# Kill bot-related processes ONLY from this directory
PIDS=""
for PID in $(ps aux | grep -E 'node (bot|wrapper)\.js' | grep -v grep | awk '{print $2}'); do
    PID_CWD=$(lsof -p "$PID" 2>/dev/null | grep cwd | awk '{print $NF}')
    if [ "$PID_CWD" = "$BOT_DIR" ] || [ "$PID_CWD" = "/private$BOT_DIR" ]; then
        PIDS="$PIDS $PID"
    fi
done
if [ -n "$PIDS" ]; then
    echo "Killing bot processes from this dir:$PIDS"
    echo "$PIDS" | xargs kill 2>/dev/null
    sleep 2
    # Force kill any remaining
    for PID in $PIDS; do
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "Force killing: $PID"
            kill -9 "$PID" 2>/dev/null
        fi
    done
    sleep 1
fi

# Kill caffeinate processes from this directory only
for PID in $(ps aux | grep 'caffeinate.*node wrapper.js' | grep -v grep | awk '{print $2}'); do
    # caffeinate's child is wrapper.js - check if wrapper's cwd matches
    CHILD_PID=$(pgrep -P "$PID" 2>/dev/null | head -1)
    if [ -n "$CHILD_PID" ]; then
        CHILD_CWD=$(lsof -p "$CHILD_PID" 2>/dev/null | grep cwd | awk '{print $NF}')
        if [ "$CHILD_CWD" = "$BOT_DIR" ] || [ "$CHILD_CWD" = "/private$BOT_DIR" ]; then
            echo "Killing caffeinate: $PID"
            kill "$PID" 2>/dev/null
        fi
    fi
done

# Clean up PID file
rm -f "$PID_FILE"

cd "$BOT_DIR"

# Check syntax BEFORE starting
echo "🔍 Checking syntax..."
if ! node --check bot.js 2>&1; then
    echo "❌ Syntax error in bot.js! Not starting."
    rm -f "$LOCK_FILE"
    exit 1
fi

# Check all lib files
for f in lib/*.js lib/commands/*.js; do
    if [ -f "$f" ]; then
        if ! node --check "$f" 2>/dev/null; then
            echo "❌ Syntax error in $f! Not starting."
            rm -f "$LOCK_FILE"
            exit 1
        fi
    fi
done
echo "✅ Syntax OK"

# Check if we should use caffeinate based on last activity
USE_CAFFEINATE=true
if [ -f "$LAST_ACTIVITY_FILE" ]; then
    LAST_ACTIVITY=$(cat "$LAST_ACTIVITY_FILE" 2>/dev/null || echo "0")
    CURRENT_TIME=$(date +%s)000  # milliseconds
    TIME_DIFF=$(( (CURRENT_TIME - LAST_ACTIVITY) / 1000 / 60 / 60 ))  # hours

    if [ "$TIME_DIFF" -gt "$IDLE_TIMEOUT_HOURS" ]; then
        USE_CAFFEINATE=false
        echo "⏰ No activity for ${TIME_DIFF}h (threshold: ${IDLE_TIMEOUT_HOURS}h)"
        echo "   Starting without caffeinate (Mac can sleep)"
    else
        echo "⚡ Recent activity (${TIME_DIFF}h ago)"
        echo "   Starting with caffeinate (Mac stays awake for ${IDLE_TIMEOUT_HOURS}h)"
    fi
else
    echo "⚡ First run - starting with caffeinate"
fi

# Start bot with wrapper (auto-restart on crash).
#
# Detach into a NEW SESSION so the bot outlives whoever launched it. Without
# this the bot dies seconds after it starts:
#   - launchd SIGTERMs the caretaker job's whole process group when that job
#     exits, so the waker killed the very bot it had just revived, every minute
#   - a Terminal window signals its foreground group on close/Ctrl-Z
# macOS ships no setsid(1), so call POSIX::setsid via perl and exec in place.
DETACH_LOG="$BOT_DIR/data/detached.log"
if [ "$USE_CAFFEINATE" = true ]; then
    # -i = prevent system idle sleep (display/disk may still sleep)
    perl -MPOSIX -e 'setsid(); exec @ARGV or die "exec: $!"' -- \
        caffeinate -i node wrapper.js </dev/null >>"$DETACH_LOG" 2>&1 &
else
    # No caffeinate - allow Mac to sleep if idle
    perl -MPOSIX -e 'setsid(); exec @ARGV or die "exec: $!"' -- \
        node wrapper.js </dev/null >>"$DETACH_LOG" 2>&1 &
fi
disown 2>/dev/null || true

# Remove lock
rm -f "$LOCK_FILE"

# Make sure the independent waker/caretaker is running (no-op until installed)
bash "$BOT_DIR/scripts/waker-ctl.sh" ensure >/dev/null 2>&1 || true

# Wait for the detached wrapper to appear. $! is useless here (the perl shim
# execs away), and it used to report the caffeinate pid, so ask the process
# table instead.
BOT_PID=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
    BOT_PID=$(pgrep -f 'node wrapper\.js' | head -1)
    [ -n "$BOT_PID" ] && break
    sleep 1
done
if [ -n "$BOT_PID" ]; then
    echo "✅ Telegram bot started (PID: $BOT_PID)"
    if [ "$USE_CAFFEINATE" = true ]; then
        echo "☕ Mac stays awake while bot has recent activity (<${IDLE_TIMEOUT_HOURS}h idle)"
    else
        echo "💤 Mac can sleep (no recent activity, will re-activate on next message)"
    fi
else
    echo "❌ Failed to start bot. Check bot.log for errors."
    tail -20 bot.log
    exit 1
fi

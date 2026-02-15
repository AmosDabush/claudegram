#!/bin/bash
# Start Telegram bot with auto-restart and syntax checking
# Usage: ./start.sh [-s HOURS]  (e.g., ./start.sh -s 24)

BOT_DIR="$HOME/.claude/telegram-bot"
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

# Kill ALL bot-related processes (bot.js AND wrapper.js)
PIDS=$(ps aux | grep -E 'node (bot|wrapper)\.js' | grep -v grep | awk '{print $2}')
if [ -n "$PIDS" ]; then
    echo "Killing existing bot processes: $PIDS"
    echo "$PIDS" | xargs kill 2>/dev/null
    sleep 2
    # Force kill any remaining
    REMAINING=$(ps aux | grep -E 'node (bot|wrapper)\.js' | grep -v grep | awk '{print $2}')
    if [ -n "$REMAINING" ]; then
        echo "Force killing: $REMAINING"
        echo "$REMAINING" | xargs kill -9 2>/dev/null
        sleep 1
    fi
fi

# Kill caffeinate processes that might be running
CAFFEINATE_PIDS=$(ps aux | grep 'caffeinate.*node wrapper.js' | grep -v grep | awk '{print $2}')
if [ -n "$CAFFEINATE_PIDS" ]; then
    echo "Killing caffeinate processes: $CAFFEINATE_PIDS"
    echo "$CAFFEINATE_PIDS" | xargs kill 2>/dev/null
fi

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

# Start bot with wrapper (auto-restart on crash)
if [ "$USE_CAFFEINATE" = true ]; then
    # Use caffeinate to keep system awake (but allow display/disk sleep for battery efficiency)
    # -i = prevent system idle sleep (keeps bot responsive while allowing display/disk to sleep)
    caffeinate -i node wrapper.js &
    PID=$!
else
    # No caffeinate - allow Mac to sleep if idle
    node wrapper.js &
    PID=$!
fi

# Remove lock
rm -f "$LOCK_FILE"

sleep 2
if ps -p $PID > /dev/null 2>&1; then
    echo "✅ Telegram bot started (PID: $PID)"
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

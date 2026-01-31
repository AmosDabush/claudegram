#!/bin/bash
# Start Telegram bot with auto-restart and syntax checking

BOT_DIR="$HOME/.claude/telegram-bot"
PID_FILE="$BOT_DIR/data/bot.pid"
LOCK_FILE="$BOT_DIR/data/start.lock"
MAX_RETRIES=3

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

# Kill ALL bot.js processes (not just PID file)
PIDS=$(ps aux | grep 'node bot.js' | grep -v grep | awk '{print $2}')
if [ -n "$PIDS" ]; then
    echo "Killing existing bot processes: $PIDS"
    echo "$PIDS" | xargs kill 2>/dev/null
    sleep 2
    # Force kill any remaining
    REMAINING=$(ps aux | grep 'node bot.js' | grep -v grep | awk '{print $2}')
    if [ -n "$REMAINING" ]; then
        echo "Force killing: $REMAINING"
        echo "$REMAINING" | xargs kill -9 2>/dev/null
        sleep 1
    fi
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

# Start bot with wrapper (auto-restart on crash)
node wrapper.js &
PID=$!

# Remove lock
rm -f "$LOCK_FILE"

sleep 2
if ps -p $PID > /dev/null 2>&1; then
    echo "✅ Telegram bot started (PID: $PID)"
else
    echo "❌ Failed to start bot. Check bot.log for errors."
    tail -20 bot.log
    exit 1
fi

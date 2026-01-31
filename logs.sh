#!/bin/bash
# View Telegram bot logs

LOG_FILE="$HOME/.claude/telegram-bot/bot.log"

if [ "$1" == "-n" ] && [ -n "$2" ]; then
    # Show last N lines
    tail -n "$2" "$LOG_FILE"
elif [ "$1" == "-f" ] || [ -z "$1" ]; then
    # Follow logs (default)
    tail -f "$LOG_FILE"
else
    echo "Usage: logs.sh [-f] [-n N]"
    echo "  -f    Follow logs (default)"
    echo "  -n N  Show last N lines"
fi

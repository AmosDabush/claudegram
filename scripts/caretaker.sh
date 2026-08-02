#!/bin/bash
# Caretaker — the independent guardian of the Telegram bot.
#
# Runs periodically (via launchd, even waking the Mac from sleep on a schedule).
# It does NOT depend on the bot to work — that's the whole point. Each round it:
#   1. checks if the bot is actually alive
#   2. revives it via start.sh if it's dead/gone
#   3. checks for a remote "restart now" trigger (email) — [wired next]
#   4. reports to you through a notifier that's independent of the bot
#   5. decides whether the Mac should stay awake or go back to sleep — [wired next]
#
# Safe to run anytime: if the bot is healthy it does nothing but log "ok".

BOT_DIR="$HOME/.claude/telegram-bot"
STATE_DIR="$BOT_DIR/data"
LOG="$STATE_DIR/caretaker.log"
NOTIFY_TG="$HOME/.claude/scripts/send-telegram.sh"

mkdir -p "$STATE_DIR"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') | $1" >> "$LOG"; }

# ---- Is the bot alive? (a node bot/wrapper process launched from BOT_DIR) ----
bot_alive() {
  for PID in $(pgrep -f 'node (bot|wrapper)\.js' 2>/dev/null); do
    CWD=$(lsof -p "$PID" 2>/dev/null | awk '$4=="cwd"{print $NF}')
    if [ "$CWD" = "$BOT_DIR" ] || [ "$CWD" = "/private$BOT_DIR" ]; then
      return 0
    fi
  done
  return 1
}

notify() {
  [ -x "$NOTIFY_TG" ] && "$NOTIFY_TG" "$1" >/dev/null 2>&1
}

# ---- Round ----
if bot_alive; then
  log "ok — bot alive"
  exit 0
fi

log "bot DOWN — reviving via start.sh"
bash "$BOT_DIR/start.sh" >> "$LOG" 2>&1
sleep 4

if bot_alive; then
  log "revived successfully"
  notify "🩺 הבוט היה למטה — השומר החזיר אותו ($(date '+%H:%M'))"
else
  log "REVIVE FAILED — bot still down after start.sh"
  notify "⚠️ השומר ניסה להרים את הבוט ונכשל ($(date '+%H:%M')). צריך מבט ידני."
fi

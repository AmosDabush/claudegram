#!/bin/bash
# Caretaker — the independent guardian of the Telegram bot.
#
# Fires periodically (via the waker LaunchAgent) — including right after the
# Mac wakes from a scheduled wake. It does NOT depend on the bot to work.
# Each round it:
#   1. checks if the bot is healthy (alive AND breathing)
#   2. revives it via start.sh if it's dead OR stuck (frozen event loop)
#   3. reports through a notifier that's independent of the bot
#   4. schedules the NEXT wake, aligned to the clock, per the configured interval
#
# Safe to run anytime. If the bot is healthy it just logs "ok" and re-arms the wake.

BOT_DIR="$HOME/.claude/telegram-bot"
STATE_DIR="$BOT_DIR/data"
LOG="$STATE_DIR/caretaker.log"
HEARTBEAT="$STATE_DIR/heartbeat"
INTERVAL_FILE="$STATE_DIR/waker.interval"
NOTIFY_TG="$HOME/.claude/scripts/send-telegram.sh"

STALE_SECONDS=90   # heartbeat older than this => bot is stuck

mkdir -p "$STATE_DIR"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') | $1" >> "$LOG"; }
notify() { [ -x "$NOTIFY_TG" ] && "$NOTIFY_TG" "$1" >/dev/null 2>&1; }

# ---- Configured wake interval (minutes), default 15, clamped 1..60 ----
read_interval() {
  local m=15
  [ -f "$INTERVAL_FILE" ] && m=$(cat "$INTERVAL_FILE" 2>/dev/null | tr -dc '0-9')
  [ -z "$m" ] && m=15
  [ "$m" -lt 1 ] 2>/dev/null && m=1
  [ "$m" -gt 60 ] 2>/dev/null && m=60
  echo "$m"
}

# ---- Bot process alive? (node bot/wrapper launched from BOT_DIR) ----
bot_process_alive() {
  for PID in $(pgrep -f 'node (bot|wrapper)\.js' 2>/dev/null); do
    CWD=$(lsof -p "$PID" 2>/dev/null | awk '$4=="cwd"{print $NF}')
    if [ "$CWD" = "$BOT_DIR" ] || [ "$CWD" = "/private$BOT_DIR" ]; then return 0; fi
  done
  return 1
}

# ---- Heartbeat fresh? (bot writes ms epoch every 30s) ----
heartbeat_fresh() {
  [ -f "$HEARTBEAT" ] || return 1
  local hb now age
  hb=$(( $(cat "$HEARTBEAT" 2>/dev/null | tr -dc '0-9') / 1000 ))
  now=$(date +%s)
  age=$(( now - hb ))
  [ "$age" -ge 0 ] && [ "$age" -le "$STALE_SECONDS" ]
}

revive() {
  bash "$BOT_DIR/start.sh" >> "$LOG" 2>&1
  sleep 4
}

# ---- Schedule the next wake, aligned to the clock for the current interval ----
# 15 => :00/:15/:30/:45, 5 => :00/:05/.., 3 => every 3 min. Needs passwordless
# sudo for pmset (set up by 'waker-ctl install'); degrades quietly if not allowed.
schedule_next_wake() {
  local m sec now next when
  m=$(read_interval)
  sec=$(( m * 60 ))
  now=$(date +%s)
  next=$(( (now / sec + 1) * sec ))          # next clock-aligned boundary
  when=$(date -r "$next" "+%m/%d/%y %H:%M:%S")           # 2-digit year: for `pmset schedule`
  when_disp=$(date -r "$next" "+%m/%d/%Y %H:%M:%S")      # 4-digit year: how `pmset -g sched` prints it

  # Dedup: skip if a wake at that exact time is already scheduled
  if pmset -g sched 2>/dev/null | grep -q "$when_disp"; then
    return 0
  fi
  if sudo -n /usr/bin/pmset schedule wake "$when" >/dev/null 2>&1; then
    log "next wake scheduled: $when (every ${m}m)"
  else
    log "wake scheduling skipped (no passwordless pmset yet) — awake-healing still active"
  fi
}

# ================= ROUND =================
if bot_process_alive && heartbeat_fresh; then
  log "ok — bot healthy"
elif bot_process_alive; then
  log "bot STUCK (heartbeat stale) — restarting"
  revive
  if bot_process_alive && heartbeat_fresh; then
    log "recovered from stuck"; notify "🩺 הבוט נתקע — השומר איתחל אותו ($(date '+%H:%M'))"
  else
    log "restart after stuck did not recover cleanly"; notify "⚠️ השומר איתחל בוט תקוע אבל הוא עדיין לא בריא ($(date '+%H:%M'))"
  fi
else
  log "bot DOWN — reviving"
  revive
  if bot_process_alive; then
    log "revived"; notify "🩺 הבוט היה למטה — השומר החזיר אותו ($(date '+%H:%M'))"
  else
    log "REVIVE FAILED"; notify "⚠️ השומר ניסה להרים את הבוט ונכשל ($(date '+%H:%M')). צריך מבט ידני."
  fi
fi

schedule_next_wake

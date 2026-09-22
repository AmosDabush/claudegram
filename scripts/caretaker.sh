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
  rm -f "$STATE_DIR/deaf-strikes"
  bash "$BOT_DIR/start.sh" >> "$LOG" 2>&1
  sleep 4
}

# ---- Schedule the next wake, aligned to the clock for the current interval ----
# 15 => :00/:15/:30/:45, 5 => :00/:05/.., 3 => every 3 min. Needs passwordless
# sudo for pmset (set up by 'waker-ctl install'); degrades quietly if not allowed.
# The warm relay daemon backs the live-session pipe; heal it like the bot.
heal_relay_daemon() {
  local rpid="$STATE_DIR/relay-daemon.pid"
  [ -f "$STATE_DIR/attached.json" ] || return 0          # only when in use
  if [ -f "$rpid" ] && ps -p "$(cat "$rpid" 2>/dev/null)" >/dev/null 2>&1; then return 0; fi
  rm -f "$STATE_DIR/relay.sock"
  nohup python3 "$BOT_DIR/scripts/attach-relay-daemon.py" >/dev/null 2>&1 &
  log "relay daemon revived"
}

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
# One message per incident — never per-minute spam. State lives in $ALERT:
# it exists only while we're in a failing-and-already-announced state.
ALERT="$STATE_DIR/waker.alert"
REMIND_SEC=1800   # if still down, remind at most once every 30 min

# ---- Is the bot still DRAINING Telegram? ----
# heartbeat_fresh only proves the event loop spins: a setInterval keeps firing
# whether or not the getUpdates loop is still fetching. A bot can be alive,
# breathing, and completely deaf — that failure mode looked "healthy" here for
# 26 consecutive rounds. Telegram itself is the only witness: if it is holding
# updates the bot has not collected, the bot is not listening.
# Two consecutive strikes before acting, so a turn that is mid-flight (the bot
# legitimately pauses polling while it answers) is not mistaken for deafness.
DEAF_FILE="$STATE_DIR/deaf-strikes"

pending_updates() {
  [ -f "$BOT_DIR/.env" ] || { echo -1; return; }
  local token
  token=$(grep -m1 '^BOT_TOKEN=' "$BOT_DIR/.env" | cut -d= -f2- | tr -d '"'"'"' \r')
  [ -n "$token" ] || { echo -1; return; }
  curl -s --max-time 10 "https://api.telegram.org/bot${token}/getWebhookInfo" \
    | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('result',{}).get('pending_update_count',-1))
except Exception: print(-1)" 2>/dev/null || echo -1
}

not_deaf() {
  local pending strikes
  pending=$(pending_updates)
  # -1 = could not ask (offline, no token). Never punish the bot for that.
  if [ "$pending" -le 0 ] 2>/dev/null; then
    rm -f "$DEAF_FILE"
    return 0
  fi
  strikes=$(cat "$DEAF_FILE" 2>/dev/null | tr -dc '0-9')
  [ -z "$strikes" ] && strikes=0
  strikes=$((strikes + 1))
  echo "$strikes" > "$DEAF_FILE"
  log "telegram holding $pending update(s) the bot has not drained — strike $strikes/2"
  [ "$strikes" -lt 2 ]
}

healthy() { bot_process_alive && heartbeat_fresh && not_deaf; }

if healthy; then
  log "ok — bot healthy"
  if [ -f "$ALERT" ]; then
    notify "🩺 הבוט חזר לעצמו ✅ ($(date '+%H:%M'))"
    rm -f "$ALERT"
  fi
else
  if ! bot_process_alive; then
    log "bot DOWN — reviving"
  elif ! heartbeat_fresh; then
    log "bot STUCK (event loop frozen) — restarting"
  else
    log "bot DEAF (alive and breathing, but not draining Telegram) — restarting"
  fi
  revive
  if healthy; then
    log "revived"
    if [ -f "$ALERT" ]; then
      notify "🩺 הבוט חזר לעצמו ✅ ($(date '+%H:%M'))"; rm -f "$ALERT"
    else
      notify "🩺 הבוט נפל והשומר החזיר אותו ($(date '+%H:%M'))"
    fi
  else
    log "revive failed — still down"
    NOW=$(date +%s)
    if [ ! -f "$ALERT" ]; then
      notify "⚠️ הבוט למטה והשומר לא מצליח להרים ($(date '+%H:%M')). ממשיך לנסות בשקט."
      echo "$NOW" > "$ALERT"
    else
      LAST=$(cat "$ALERT" 2>/dev/null | tr -dc '0-9'); [ -z "$LAST" ] && LAST=0
      if [ $(( NOW - LAST )) -ge "$REMIND_SEC" ]; then
        notify "⚠️ הבוט עדיין למטה כבר זמן מה ($(date '+%H:%M')). עדיין מנסה."
        echo "$NOW" > "$ALERT"
      fi
    fi
  fi
fi

schedule_next_wake

heal_relay_daemon

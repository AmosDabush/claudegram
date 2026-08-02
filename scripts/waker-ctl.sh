#!/bin/bash
# waker-ctl — single control surface for the Telegram bot "waker" (caretaker).
# Called by: the Telegram bot command, a Claude Code skill, and start.sh.
#
# Subcommands:
#   status              show interval, agent state, bot health, next wake
#   get                 print the current interval (minutes)
#   set <minutes>       set wake interval (1..60); applies within a minute
#   ensure              load the LaunchAgent if it isn't running (no password)
#   run                 run one caretaker round now (for testing)
#   install             install + start the waker  (asks admin password once)
#   uninstall           stop + remove the waker    (asks admin password once)

BOT_DIR="$HOME/.claude/telegram-bot"
STATE_DIR="$BOT_DIR/data"
INTERVAL_FILE="$STATE_DIR/waker.interval"
CARETAKER="$BOT_DIR/scripts/caretaker.sh"
LABEL="com.amosdabush.telegram-waker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SUDOERS="/etc/sudoers.d/telegram-waker"

mkdir -p "$STATE_DIR"

get_interval() {
  local m=15
  [ -f "$INTERVAL_FILE" ] && m=$(cat "$INTERVAL_FILE" 2>/dev/null | tr -dc '0-9')
  [ -z "$m" ] && m=15
  echo "$m"
}

agent_loaded() { launchctl list 2>/dev/null | grep -q "$LABEL"; }

bot_healthy() {
  local hb now age
  [ -f "$STATE_DIR/heartbeat" ] || return 1
  hb=$(( $(cat "$STATE_DIR/heartbeat" 2>/dev/null | tr -dc '0-9') / 1000 ))
  now=$(date +%s); age=$(( now - hb ))
  [ "$age" -ge 0 ] && [ "$age" -le 90 ]
}

write_plist() {
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$CARETAKER</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$STATE_DIR/waker-agent.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/waker-agent.log</string>
</dict>
</plist>
EOF
}

case "$1" in
  get)
    get_interval
    ;;

  set)
    N=$(echo "$2" | tr -dc '0-9')
    if [ -z "$N" ] || [ "$N" -lt 1 ] || [ "$N" -gt 60 ]; then
      echo "❌ interval must be 1..60 minutes"; exit 1
    fi
    echo "$N" > "$INTERVAL_FILE"
    echo "✅ waker interval set to ${N}m (applies within a minute)"
    ;;

  ensure)
    if [ -f "$PLIST" ] && ! agent_loaded; then
      launchctl load "$PLIST" 2>/dev/null && echo "▶️ waker loaded"
    elif agent_loaded; then
      echo "✅ waker already running"
    else
      echo "⚠️ waker not installed yet — run: waker-ctl install"
    fi
    ;;

  run)
    bash "$CARETAKER"
    echo "ran one caretaker round (see $STATE_DIR/caretaker.log)"
    ;;

  status)
    echo "⏰ Telegram Waker status"
    echo "  interval : $(get_interval)m"
    if agent_loaded; then echo "  agent    : running"; else echo "  agent    : NOT running"; fi
    if bot_healthy; then echo "  bot      : healthy"; else echo "  bot      : down/stuck"; fi
    if [ -f "$SUDOERS" ]; then echo "  wake     : enabled (can wake from sleep)"; else echo "  wake     : awake-only (no sleep-wake yet)"; fi
    NEXT=$(pmset -g sched 2>/dev/null | grep -i 'wake' | grep -v apple | head -1)
    [ -n "$NEXT" ] && echo "  next     :$NEXT"
    ;;

  install)
    echo "Installing waker LaunchAgent..."
    write_plist
    launchctl unload "$PLIST" 2>/dev/null
    launchctl load "$PLIST" && echo "✅ agent loaded (runs every 60s + on wake)"
    echo
    echo "Enabling scheduled wake (needs your admin password once)..."
    TMP=$(mktemp)
    echo "$(whoami) ALL=(root) NOPASSWD: /usr/bin/pmset schedule wake *" > "$TMP"
    if sudo visudo -cf "$TMP" >/dev/null 2>&1; then
      sudo install -m 0440 -o root -g wheel "$TMP" "$SUDOERS" && echo "✅ scheduled wake enabled"
    else
      echo "⚠️ sudoers validation failed — wake-from-sleep NOT enabled (awake-healing still works)"
    fi
    rm -f "$TMP"
    ;;

  uninstall)
    launchctl unload "$PLIST" 2>/dev/null
    rm -f "$PLIST" && echo "🛑 agent removed"
    if [ -f "$SUDOERS" ]; then sudo rm -f "$SUDOERS" && echo "🛑 scheduled-wake permission removed"; fi
    ;;

  *)
    echo "usage: waker-ctl {status|get|set <min>|ensure|run|install|uninstall}"
    exit 1
    ;;
esac

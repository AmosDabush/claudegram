#!/bin/bash
# attach-ctl.sh — drive a LIVE Claude session from Telegram, without --resume.
# Messages are injected into the running session over its unix socket, so the
# session keeps its context, its cwd and its place in the turn.
#
# This is a second pipe. It does not touch the resume/bookmark flow.

SOCK_DIR="/tmp/cc-socks"

# The bot's PATH starts with /opt/homebrew/bin, which can hold an OLD claude
# (2.0.54, no --bg). Always resolve the newest one explicitly.
pick_claude() {
  # honour the bot's own setting first
  local cfg
  cfg=$(grep -E "^CLAUDE_BIN_PATH=" "$HOME/.claude/telegram-bot/.env" 2>/dev/null | cut -d= -f2- | tr -d "\"'" | xargs)
  [ -d "$cfg" ] && cfg="$cfg/claude"
  if [ -n "$cfg" ] && [ -f "$cfg" ] && [ -x "$cfg" ]; then echo "$cfg"; return; fi
  local best="" bestv=0 c v n
  for c in "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude "$(command -v claude 2>/dev/null)"; do
    [ -x "$c" ] || continue
    v=$("$c" --version 2>/dev/null | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+') || continue
    n=$(printf '%s' "$v" | awk -F. '{printf "%d%03d%03d", $1,$2,$3}')
    if [ "${n:-0}" -gt "$bestv" ]; then bestv=$n; best=$c; fi
  done
  echo "${best:-claude}"
}
CLAUDE_BIN="$(pick_claude)"
STATE_DIR="$HOME/.claude/telegram-bot/data"
STATE="$STATE_DIR/attached.json"
LOG="$STATE_DIR/attach-relay.log"
RELAYS="$STATE_DIR/attach-relays.txt"
STREAMER="$HOME/.claude/telegram-bot/scripts/attach-streamer.py"
SPID="$STATE_DIR/attach-streamer.pid"

RELAYD="$HOME/.claude/telegram-bot/scripts/attach-relay-daemon.py"
RPID="$STATE_DIR/relay-daemon.pid"

# A warm relay session removes the 10-15s boot per message. Keep one alive.
ensure_relay_daemon() {
  if [ -f "$RPID" ] && ps -p "$(cat "$RPID" 2>/dev/null)" >/dev/null 2>&1; then return 0; fi
  rm -f "$STATE_DIR/relay.sock"
  nohup python3 "$RELAYD" >/dev/null 2>&1 &
  sleep 2
}

stop_streamer() { [ -f "$SPID" ] && kill "$(cat "$SPID")" 2>/dev/null; rm -f "$SPID"; return 0; }
start_streamer() {
  stop_streamer
  nohup python3 "$STREAMER" >/dev/null 2>&1 &
  sleep 1
}

# Each send leaves a finished background session behind; clear out the old ones
# so `claude agents` does not fill up with relays.
prune_relays() {
  [ -f "$RELAYS" ] || return 0
  local keep=""
  local n=0
  while read -r rid; do
    [ -z "$rid" ] && continue
    n=$((n+1))
    if [ "$n" -le 3 ]; then keep="$keep$rid\n"; continue; fi   # leave the newest few alone
    "$CLAUDE_BIN" stop "$rid" >/dev/null 2>&1
    "$CLAUDE_BIN" rm   "$rid" >/dev/null 2>&1
  done < <(tail -r "$RELAYS" 2>/dev/null || tac "$RELAYS")
  printf "%b" "$keep" > "$RELAYS"
}
mkdir -p "$STATE_DIR"

die() { echo "$1" >&2; exit 1; }

# A socket is only real if its pid is alive AND is a claude process.
sock_pid_alive() {
  local pid="$1"
  ps -p "$pid" -o comm=,args= 2>/dev/null | grep -q "claude"
}

session_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-
}

session_label() {
  local pid="$1" cwd
  cwd=$(session_cwd "$pid")
  echo "$(basename "${cwd:-?}")-$pid"
}

cmd_list() {
  local _target; _target=$(cmd_target_pid 2>/dev/null) || true
  printf "%-8s %-11s %-9s %s\n" PID AGE STATE CWD
  local found=0
  for s in "$SOCK_DIR"/*.sock; do
    [ -e "$s" ] || continue
    local pid; pid=$(basename "$s" .sock)
    sock_pid_alive "$pid" || continue
    found=1
    local age cwd mark
    age=$(ps -o etime= -p "$pid" | tr -d ' ')
    cwd=$(session_cwd "$pid")
    mark=""
    if [ "$pid" = "${_target:-}" ]; then mark="ATTACHED"; fi
    printf "%-8s %-11s %-9s %s\n" "$pid" "$age" "$mark" "${cwd/#$HOME/~}"
  done
  [ "$found" = 0 ] && echo "(no live sessions)"
  return 0
}

cmd_target_pid() {
  [ -f "$STATE" ] || return 1
  python3 -c "import json;print(json.load(open('$STATE'))['pid'])" 2>/dev/null
}

cmd_attach() {
  local pid="$1"
  [ -n "$pid" ] || die "usage: attach-ctl.sh attach <pid>"
  [ -S "$SOCK_DIR/$pid.sock" ] || die "no socket for pid $pid — is it a live claude session?"
  sock_pid_alive "$pid" || die "pid $pid is not a live claude process"
  python3 - "$pid" "$(session_cwd "$pid")" "$(session_label "$pid")" <<'PY'
import json,sys,time,os
pid,cwd,label=sys.argv[1],sys.argv[2],sys.argv[3]
p=os.path.expanduser("~/.claude/telegram-bot/data/attached.json")
json.dump({"pid":int(pid),"cwd":cwd,"label":label,
           "addr":f"uds:/tmp/cc-socks/{pid}.sock","ts":int(time.time())},
          open(p,"w"),indent=1)
PY
  # Attaching from the terminal means you want the live pipe — flip the toggle
  # so the bot does not keep routing to the resume flow.
  printf '{"mode":"attach","ts":%s}\n' "$(date +%s000)" > "$STATE_DIR/pipe-mode.json"
  ensure_relay_daemon
  start_streamer
  echo "attached -> $(session_label "$pid")"
  echo "  cwd  : $(session_cwd "$pid")"
  echo "  addr : uds:$SOCK_DIR/$pid.sock"
}

cmd_detach() { stop_streamer; rm -f "$STATE" && echo "detached"; }

cmd_status() {
  [ -f "$STATE" ] || { echo "not attached"; return 0; }
  local pid; pid=$(cmd_target_pid)
  if sock_pid_alive "$pid"; then
    echo "attached : $(python3 -c "import json;print(json.load(open('$STATE'))['label'])")"
    echo "pid      : $pid (alive, up $(ps -o etime= -p "$pid"|tr -d ' '))"
    echo "cwd      : $(session_cwd "$pid")"
  else
    echo "attached : $(python3 -c "import json;print(json.load(open('$STATE'))['label'])" 2>/dev/null)"
    echo "pid      : $pid  ** DEAD ** — use resume mode, or attach to another session"
    return 2
  fi
}

cmd_send() {
  local msg="$*"
  [ -n "$msg" ] || die "usage: attach-ctl.sh send <text>"
  [ -f "$STATE" ] || die "not attached — run: attach-ctl.sh attach <pid>"
  local pid addr; pid=$(cmd_target_pid)
  sock_pid_alive "$pid" || die "target pid $pid is dead — reattach or fall back to resume"
  addr="uds:$SOCK_DIR/$pid.sock"

  # Build the relay prompt with JSON-safe escaping (Hebrew, quotes, newlines).
  local prompt
  prompt=$(python3 - "$addr" "$msg" <<'PY'
import json,sys
addr,msg=sys.argv[1],sys.argv[2]
print(f"Call the SendMessage tool exactly once with to={json.dumps(addr)} "
      f"and message={json.dumps(msg)}. Do nothing else. Reply with only: SENT")
PY
)
  # A new message from the phone ALWAYS starts a new Telegram card. Deciding
  # this at send time is deterministic; deriving it from transcript records
  # was not — socket messages do not land as "user" records.
  rm -f "$STATE_DIR/attach-live.json"

  cd "$(session_cwd "$pid")" 2>/dev/null || cd "$HOME"

  # Prefer the warm relay: a persistent session, so no 10-15s boot per message.
  if [ -S "$STATE_DIR/relay.sock" ]; then
    if python3 - "$addr" "$msg" <<'PYEOF' 2>/dev/null
import json, socket, sys, os
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(10)
s.connect(os.path.expanduser("~/.claude/telegram-bot/data/relay.sock"))
s.sendall(json.dumps({"to": sys.argv[1], "text": sys.argv[2]}).encode() + b"\n")
sys.exit(0 if b'"ok":true' in s.recv(200) else 1)
PYEOF
    then
      printf '%s | warm relay -> %s\n' "$(date '+%F %T')" "$addr" >> "$LOG"
      python3 "$HOME/.claude/telegram-bot/scripts/attach-ack.py" 2>/dev/null &
      echo "sent -> $(session_label "$pid")"
      return 0
    fi
    printf '%s | warm relay failed, falling back to --bg\n' "$(date '+%F %T')" >> "$LOG"
  fi

  # Fallback: a fresh background session. Slower (boot per message) but works
  # even when the daemon is down. `claude -p` cannot be used here at all — it
  # only gets SendMessage when descended from a live session.
  local out rc id
  out=$(timeout 90 "$CLAUDE_BIN" --bg "$prompt" --dangerously-skip-permissions < /dev/null 2>&1)
  rc=$?
  id=$(printf '%s' "$out" | grep -oE 'backgrounded · [0-9a-f]+' | awk '{print $NF}')
  printf '%s | rc=%s | id=%s | %s\n' "$(date '+%F %T')" "$rc" "${id:-none}" "${out//$'\n'/ }" >> "$LOG"

  if [ "$rc" -ne 0 ] || [ -z "$id" ]; then
    die "relay failed (rc=$rc): ${out:-no output}"
  fi
  echo "$id" >> "$RELAYS"
  prune_relays
  echo "sent -> $(session_label "$pid")"
}

case "$1" in
  list)   cmd_list ;;
  attach) shift; cmd_attach "$@" ;;
  detach) cmd_detach ;;
  status) cmd_status ;;
  send)   shift; cmd_send "$@" ;;
  *) cat <<EOF
attach-ctl.sh — drive a live Claude session from Telegram (no --resume)

  list             live sessions you can attach to
  attach <pid>     point Telegram at that session
  status           what is attached, and whether it is still alive
  send <text>      inject text into the attached session
  detach           stop targeting

State: $STATE
EOF
  ;;
esac

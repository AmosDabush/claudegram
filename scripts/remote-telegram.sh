#!/bin/bash
# remote-telegram.sh — push an attach target to Telegram from the terminal.
#
#   current   attach the session this was run from, and say so in Telegram
#   all       send the full live-session picker to Telegram
#
# Both leave /attach in the bot working exactly as before.

set -o pipefail
ENV_FILE="$HOME/.claude/telegram-bot/.env"
CTL="$HOME/.claude/telegram-bot/scripts/attach-ctl.sh"
SOCK="/tmp/cc-socks"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
: "${BOT_TOKEN:?BOT_TOKEN missing from .env}"
CHAT="${1:-$OWNER_CHAT_ID}"

api() { curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/$1" \
          -H 'Content-Type: application/json' -d @- ; }

# The claude session this script is running under.
own_pid() {
  local pid=$PPID
  for _ in 1 2 3 4 5 6 7 8; do
    [ "$pid" -le 1 ] 2>/dev/null && break
    [ -S "$SOCK/$pid.sock" ] && { echo "$pid"; return 0; }
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -z "$pid" ] && break
  done
  return 1
}

cmd_current() {
  local pid; pid=$(own_pid) || { echo "not inside a live Claude session"; exit 1; }
  bash "$CTL" attach "$pid" >/dev/null || exit 1
  local cwd; cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-)
  python3 - "$CHAT" "$pid" "$cwd" <<'PY' | api sendMessage >/dev/null
import json,sys,os
chat,pid,cwd=sys.argv[1],sys.argv[2],sys.argv[3]
print(json.dumps({"chat_id":chat,
 "text":f"🔗 *Attached to this terminal session*\n📁 `{os.path.basename(cwd)}`\n🆔 pid `{pid}`\n\nAnything you type here now lands in that running session.",
 "parse_mode":"Markdown",
 "reply_markup":{"inline_keyboard":[[{"text":"⏹ Detach","callback_data":"udetach"}],
                                    [{"text":"📋 Other sessions","callback_data":"ulist"}]]}}))
PY
  echo "📱 attached pid $pid and told Telegram"
}

cmd_all() {
  local rows; rows=$(bash "$CTL" list | tail -n +2)
  [ -z "$rows" ] && { echo "no live sessions"; exit 1; }
  printf '%s' "$rows" | python3 - "$CHAT" <<'PY' | api sendMessage >/dev/null
import json,sys,os
chat=sys.argv[1]
reg={}
try: reg=json.load(open(os.path.expanduser("~/.claude/telegram-bot/data/session-registry.json")))
except Exception: pass
kb=[]
n=0
for line in sys.stdin.read().splitlines():
    p=line.split()
    if len(p)<3 or not p[0].isdigit(): continue
    pid,age,cwd=p[0],p[1],p[-1]
    label=os.path.basename(cwd.rstrip('/')) or cwd
    rec=reg.get(pid)
    if rec:
        try:
            t=json.load(open(os.path.expanduser("~/.claude/telegram-bot/data/ai-titles.json"))).get(rec["session_id"],{}).get("title")
            if t: label=f"{t} · {label}"
        except Exception: pass
    kb.append([{"text":f"{label} · {pid} · {age.split('-')[0]}d"[:64],"callback_data":f"uattach:{pid}"}])
    n+=1
kb.append([{"text":"⏹ Detach","callback_data":"udetach"}])
print(json.dumps({"chat_id":chat,
 "text":f"🔗 *Live sessions* ({n})\n\nTap one to drive it directly — no resume, no new process.",
 "parse_mode":"Markdown","reply_markup":{"inline_keyboard":kb}}))
PY
  echo "📱 sent the session list to Telegram"
}

case "$1" in
  current) shift; CHAT="${1:-$OWNER_CHAT_ID}"; cmd_current ;;
  all)     shift; CHAT="${1:-$OWNER_CHAT_ID}"; cmd_all ;;
  *) echo "usage: remote-telegram.sh {current|all} [chat_id]" ;;
esac

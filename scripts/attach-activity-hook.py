#!/usr/bin/env python3
"""PreToolUse hook: stream the attached session's activity to Telegram.

Keeps ONE message per turn and edits it, so a long turn reads as a live status
line instead of a wall of notifications. Gated exactly like the reply hook.
"""
import json, os, subprocess, sys, time
import sys as _sys
_sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tg_text import clean

D        = os.path.expanduser("~/.claude/telegram-bot/data")
ENV      = os.path.expanduser("~/.claude/telegram-bot/.env")
ATTACHED = f"{D}/attached.json"
MODE     = f"{D}/pipe-mode.json"
LIVE     = f"{D}/attach-live.json"
LOG      = f"{D}/attach-activity.log"
SOCK     = "/tmp/cc-socks"
MAXTOOLS = 8
BODYCAP  = 3500
PROJECTS = os.path.expanduser("~/.claude/projects")
TURN_GAP = 90          # seconds of quiet that means "new turn, new message"

def log(m):
    try:
        open(LOG, "a").write(f"{time.strftime('%F %T')} | {m}\n")
    except Exception:
        pass

def env(k):
    try:
        for line in open(ENV):
            if line.startswith(k + "="):
                return line.split("=", 1)[1].strip().strip("'\"")
    except Exception:
        pass
    return None

def own_pid():
    pid = os.getppid()
    for _ in range(8):
        if pid <= 1: break
        if os.path.exists(f"{SOCK}/{pid}.sock"): return pid
        try:
            pid = int(subprocess.run(["ps","-o","ppid=","-p",str(pid)],
                                     capture_output=True, text=True).stdout.strip())
        except Exception: break
    return None

def tg(method, payload):
    r = subprocess.run(
        ["curl","-s","--max-time","10","-X","POST",
         f"https://api.telegram.org/bot{env('BOT_TOKEN')}/{method}",
         "-H","Content-Type: application/json","--data-binary","@-"],
        input=json.dumps(payload), capture_output=True, text=True)
    try:
        return json.loads(r.stdout or "{}")
    except Exception:
        return {}

def transcript(sid, given):
    if given and os.path.exists(given): return given
    try:
        for d in os.listdir(PROJECTS):
            fp = os.path.join(PROJECTS, d, sid + ".jsonl")
            if os.path.exists(fp): return fp
    except Exception:
        pass
    return None

def new_text_blocks(path, after_uuid):
    """Assistant text written since we last looked — the closest this pipe
    gets to streaming the answer, since we do not own the process's stdout."""
    # No cursor yet = first tool of a turn: seek to the end and emit nothing,
    # otherwise the whole transcript would replay into the card.
    out, last, seen = [], after_uuid, False
    backfill = after_uuid is None
    try:
        lines = open(path, encoding="utf-8").read().splitlines()
    except Exception:
        return out, after_uuid
    for line in lines:
        if not line.strip(): continue
        try: r = json.loads(line)
        except Exception: continue
        uid = r.get("uuid")
        if backfill:
            last = uid or last          # just advance the cursor, emit nothing
            continue
        if not seen:
            if uid == after_uuid: seen = True
            continue
        if r.get("type") != "assistant": continue
        c = (r.get("message") or {}).get("content")
        if not isinstance(c, list): continue
        for b in c:
            if isinstance(b, dict) and b.get("type") == "text" and b.get("text","").strip():
                out.append(b["text"].strip())
        last = uid or last
    return out, last

def describe(name, inp):
    """One short line per tool — enough to follow along, never a dump."""
    inp = inp or {}
    if name == "Bash":
        return "⚡ " + (inp.get("description") or (inp.get("command") or "")[:60])
    if name in ("Read", "Edit", "Write"):
        return {"Read":"📖","Edit":"✏️","Write":"📝"}[name] + " " + os.path.basename(inp.get("file_path",""))
    if name in ("Grep", "Glob"):
        return f"🔎 {inp.get('pattern','')[:40]}"
    if name == "Task":
        return f"🤖 {(inp.get('description') or '')[:50]}"
    if name == "WebFetch":
        return f"🌐 {(inp.get('url') or '')[:50]}"
    return f"🔧 {name}"

def main():
    data = json.load(sys.stdin)

    try:
        mode = json.load(open(MODE)).get("mode")
        if mode != "attach":
            log(f"skip: pipe is {mode}, not attach")
            return
        if int(json.load(open(ATTACHED))["pid"]) != own_pid():
            return
    except Exception as e:
        log(f"skip: gate unreadable ({type(e).__name__})")
        return

    chat = env("OWNER_CHAT_ID")
    if not chat: return

    line = describe(data.get("tool_name",""), data.get("tool_input"))

    # Reuse this turn's message, or start a new one after a gap of quiet.
    state = {}
    try: state = json.load(open(LIVE))
    except Exception: pass
    fresh = (time.time() - state.get("ts", 0)) > TURN_GAP

    # Fires the moment a tool is called — the fastest signal available. The
    # streamer owns the text; this only appends the action trail to the same card.
    tools = [] if fresh else state.get("tools", [])
    body  = "" if fresh else state.get("body", "")
    cursor = None if fresh else state.get("cursor")

    tools.append(line)
    trail = tools[-MAXTOOLS:]
    if len(tools) > MAXTOOLS:
        trail = [f"… +{len(tools)-MAXTOOLS}"] + trail

    body = clean(body)
    shown = body[-BODYCAP:] if len(body) > BODYCAP else body
    text = (shown + "\n\n" if shown else "") + "⚙️ " + "\n⚙️ ".join(trail)

    if fresh or not state.get("message_id"):
        r = tg("sendMessage", {"chat_id": chat, "text": text,
                               "disable_notification": True})
        mid = (r.get("result") or {}).get("message_id")
    else:
        mid = state["message_id"]
        tg("editMessageText", {"chat_id": chat, "message_id": mid, "text": text})

    if mid:
        json.dump({"message_id": mid, "body": body, "tools": tools,
                   "cursor": cursor, "ts": time.time()}, open(LIVE, "w"))

try:
    main()
except Exception as e:
    log(f"ERROR {type(e).__name__}: {e}")
sys.exit(0)

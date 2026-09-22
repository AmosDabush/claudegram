#!/usr/bin/env python3
"""Stop hook: send the attached session's reply back to Telegram.

Fires at the end of every turn in every session, but only acts when THIS
session is the one Telegram is attached to and the pipe is in attach mode.
Never fails a turn: any error exits 0 silently.
"""
import json, os, subprocess, sys, time
import sys as _sys
_sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tg_text import clean

D        = os.path.expanduser("~/.claude/telegram-bot/data")
ENV      = os.path.expanduser("~/.claude/telegram-bot/.env")
ATTACHED = f"{D}/attached.json"
MODE     = f"{D}/pipe-mode.json"
SEEN     = f"{D}/attach-last-sent.json"
LIVE     = f"{D}/attach-live.json"
SOCK     = "/tmp/cc-socks"
PROJECTS = os.path.expanduser("~/.claude/projects")
LIMIT    = 3800
LOG      = f"{D}/attach-reply.log"

def log(msg):
    try:
        with open(LOG, "a") as f:
            f.write(f"{time.strftime('%F %T')} | {msg}\n")
    except Exception:
        pass

def env(key):
    try:
        for line in open(ENV):
            if line.startswith(key + "="):
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

def transcript(sid, given):
    if given and os.path.exists(given): return given
    for d in os.listdir(PROJECTS):
        fp = os.path.join(PROJECTS, d, sid + ".jsonl")
        if os.path.exists(fp): return fp
    return None

def last_reply(path):
    """Last assistant text block, plus the uuid so we never send it twice."""
    try:
        lines = open(path, encoding="utf-8").read().splitlines()
    except Exception:
        return None, None
    for line in reversed(lines):
        if not line.strip(): continue
        try: r = json.loads(line)
        except Exception: continue
        if r.get("type") != "assistant": continue
        c = (r.get("message") or {}).get("content")
        parts = [b.get("text","") for b in c if isinstance(b, dict) and b.get("type")=="text"] \
                if isinstance(c, list) else ([c] if isinstance(c, str) else [])
        text = "\n".join(t for t in parts if t).strip()
        if text:
            return text, r.get("uuid") or r.get("timestamp")
    return None, None

def main():
    data = json.load(sys.stdin)
    sid  = data.get("session_id")
    if not sid: return

    # only the attached session, only in attach mode
    try:
        mode = json.load(open(MODE)).get("mode")
        if mode != "attach":
            log(f"skip: pipe is {mode}, not attach")      # never fail silently
            return
        if int(json.load(open(ATTACHED))["pid"]) != own_pid():
            return                                        # other session: normal, stay quiet
    except Exception as e:
        log(f"skip: gate unreadable ({type(e).__name__})")
        return

    path = transcript(sid, data.get("transcript_path"))
    if not path: return
    text, uid = last_reply(path)
    if not text or not uid: return

    try:
        if json.load(open(SEEN)).get("uuid") == uid: return   # already sent
    except Exception:
        pass

    token, chat = env("BOT_TOKEN"), env("OWNER_CHAT_ID")
    if not token or not chat: return

    text = clean(text)
    if len(text) > LIMIT:
        text = text[:LIMIT] + "\n\n… (truncated)"

    # curl, not urllib: this machine sits behind a corporate CA, and only the
    # system keychain trusts it. urllib's own bundle fails the handshake.
    # If this turn streamed into a live card, finish THAT message rather than
    # posting the answer twice. One message that grows and completes.
    mid = None
    try:
        live = json.load(open(LIVE))
        if time.time() - live.get("ts", 0) < 120:
            mid = live.get("message_id")
    except Exception:
        pass

    method = "editMessageText" if mid else "sendMessage"
    body = {"chat_id": chat, "text": text, "disable_web_page_preview": True}
    if mid:
        body["message_id"] = mid
    r = subprocess.run(
        ["curl", "-s", "--max-time", "15", "-X", "POST",
         f"https://api.telegram.org/bot{token}/{method}",
         "-H", "Content-Type: application/json", "--data-binary", "@-"],
        input=json.dumps(body), capture_output=True, text=True)
    ok = '"ok":true' in (r.stdout or "")

    # An edit can fail if the text is byte-identical to what is already there.
    if not ok and mid:
        r = subprocess.run(
            ["curl", "-s", "--max-time", "15", "-X", "POST",
             f"https://api.telegram.org/bot{token}/sendMessage",
             "-H", "Content-Type: application/json", "--data-binary", "@-"],
            input=json.dumps({"chat_id": chat, "text": text,
                              "disable_web_page_preview": True}),
            capture_output=True, text=True)
        ok = '"ok":true' in (r.stdout or "")

    log(f"{method} ok={ok} rc={r.returncode} {(r.stdout or r.stderr or '')[:120]}")
    if ok:
        json.dump({"uuid": uid}, open(SEEN, "w"))
        try: os.remove(LIVE)          # turn is done; next one starts a new card
        except Exception: pass

try:
    main()
except Exception as e:
    log(f"ERROR {type(e).__name__}: {e}")   # never silent again
sys.exit(0)

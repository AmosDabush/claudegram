#!/usr/bin/env python3
"""Open the card the instant a message is delivered.

Without this there is no feedback until the first tool call, so the phone shows
nothing and you cannot tell thinking from stalled. Posts immediately and hands
the message_id to the streamer/hook to keep editing.
"""
import json, os, subprocess, sys, time

D    = os.path.expanduser("~/.claude/telegram-bot/data")
ENV  = os.path.expanduser("~/.claude/telegram-bot/.env")
LIVE = f"{D}/attach-live.json"
SET  = os.path.expanduser("~/.claude/settings.json")

def env(k):
    try:
        for l in open(ENV):
            if l.startswith(k+"="): return l.split("=",1)[1].strip().strip("'\"")
    except Exception: pass
    return None

def effort():
    try:
        s = json.load(open(SET))
        return f"{s.get('model','claude')} · {s.get('effortLevel','default')} effort"
    except Exception:
        return "thinking"

def main():
    token, chat = env("BOT_TOKEN"), env("OWNER_CHAT_ID")
    if not token or not chat: return
    text = f"🤔 Thinking · {effort()}"
    r = subprocess.run(
        ["curl","-s","--max-time","10","-X","POST",
         f"https://api.telegram.org/bot{token}/sendMessage",
         "-H","Content-Type: application/json","--data-binary","@-"],
        input=json.dumps({"chat_id": chat, "text": text,
                          "disable_notification": True}),
        capture_output=True, text=True)
    try:
        mid = json.loads(r.stdout)["result"]["message_id"]
    except Exception:
        return
    json.dump({"message_id": mid, "body": "", "tools": [],
               "ts": time.time(), "started": time.time(), "status": "thinking"},
              open(LIVE, "w"))

try: main()
except Exception: pass

#!/usr/bin/env python3
"""Persistent relay: keeps ONE Claude session warm and forwards through it.

Spawning `claude --bg` per message cost 10-15s of boot every time. This keeps a
single stream-json session alive and writes each message to its stdin, so only
the turn itself costs time.

Protocol: newline-delimited JSON on a unix socket.
    {"to": "uds:/tmp/cc-socks/<pid>.sock", "text": "..."}
"""
import json, os, socket, subprocess, sys, threading, time

D      = os.path.expanduser("~/.claude/telegram-bot/data")
SOCK   = f"{D}/relay.sock"
PIDF   = f"{D}/relay-daemon.pid"
LOG    = f"{D}/relay-daemon.log"
CWD    = os.path.expanduser("~/git/cc-final26")
ENV    = os.path.expanduser("~/.claude/telegram-bot/.env")
EDIT_GAP = 1.2          # seconds between Telegram edits
CAP      = 3600

def env(k):
    try:
        for line in open(ENV):
            if line.startswith(k + "="):
                return line.split("=", 1)[1].strip().strip("'\"")
    except Exception: pass
    return None

TOKEN, CHAT = env("BOT_TOKEN"), env("OWNER_CHAT_ID")

def tg(method, payload):
    r = subprocess.run(
        ["curl","-s","--max-time","10","-X","POST",
         f"https://api.telegram.org/bot{TOKEN}/{method}",
         "-H","Content-Type: application/json","--data-binary","@-"],
        input=json.dumps(payload), capture_output=True, text=True)
    try: return json.loads(r.stdout or "{}")
    except Exception: return {}

def log(m):
    try: open(LOG,"a").write(f"{time.strftime('%F %T')} | {m}\n")
    except Exception: pass

def claude_bin():
    for c in (os.path.expanduser("~/.local/bin/claude"), "/opt/homebrew/bin/claude"):
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return "claude"

class Relay:
    def __init__(self):
        self.p = None
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.own = False          # True while the phone is talking to THIS session
        self.buf = ""
        self.mid = None
        self.tools = []
        self.last_edit = 0.0
        self.spawn()

    def flush(self, final=False):
        """Push the buffer to Telegram, throttled."""
        now = time.time()
        if not final and now - self.last_edit < EDIT_GAP: return
        text = self.buf[-CAP:] if self.buf else ""
        if self.tools and not final:
            text = (text + "\n\n" if text else "") + "⚙️ " + " · ".join(self.tools[-5:])
        if not text.strip(): return
        if self.mid is None:
            r = tg("sendMessage", {"chat_id": CHAT, "text": text,
                                   "disable_notification": True,
                                   "disable_web_page_preview": True})
            self.mid = (r.get("result") or {}).get("message_id")
        else:
            tg("editMessageText", {"chat_id": CHAT, "message_id": self.mid,
                                   "text": text, "disable_web_page_preview": True})
        self.last_edit = now

    def spawn(self):
        if self.p:
            try: self.p.kill()
            except Exception: pass
        self.ready.clear()
        self.p = subprocess.Popen(
            [claude_bin(), "--input-format","stream-json","--output-format","stream-json",
             "--verbose","--include-partial-messages","--dangerously-skip-permissions"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1, cwd=CWD)
        threading.Thread(target=self.drain, daemon=True).start()
        log(f"relay session spawned pid={self.p.pid}")

    def drain(self):
        """Keep the pipe empty; a blocked stdout would wedge the session."""
        try:
            for line in self.p.stdout:
                line = line.strip()
                if not line.startswith("{"): continue
                try: ev = json.loads(line)
                except Exception: continue
                t = ev.get("type")
                if t == "stream_event" and self.own:
                    e = ev.get("event", {})
                    if e.get("type") == "content_block_delta":
                        d = e.get("delta", {})
                        if d.get("type") == "text_delta":
                            self.buf += d.get("text", "")
                            self.flush()
                    elif e.get("type") == "content_block_start":
                        cb = e.get("content_block", {})
                        if cb.get("type") == "tool_use":
                            self.tools.append("🔧 " + cb.get("name",""))
                            self.flush()
                elif t == "result":
                    if self.own:
                        self.flush(final=True)
                        self.mid = None; self.buf = ""; self.tools = []
                    self.ready.set()
                elif t == "system":
                    self.ready.set()          # warm and idle
        except Exception as e:
            log(f"drain ended: {e}")

    def send(self, to, text, own=False):
        self.own = own
        if own:
            self.buf = ""; self.mid = None; self.tools = []
            prompt = text                      # the phone IS talking to this session
        else:
            prompt = (f"Call the SendMessage tool exactly once with to={json.dumps(to)} "
                      f"and message={json.dumps(text)}. Do nothing else.")
        with self.lock:
            if not self.p or self.p.poll() is not None:
                log("relay died; respawning"); self.spawn(); time.sleep(2)
            try:
                self.p.stdin.write(json.dumps(
                    {"type":"user","message":{"role":"user","content":prompt}}) + "\n")
                self.p.stdin.flush()
                return True
            except Exception as e:
                log(f"write failed: {e}"); self.spawn()
                return False

def main():
    os.makedirs(D, exist_ok=True)
    if os.path.exists(SOCK): os.remove(SOCK)
    open(PIDF,"w").write(str(os.getpid()))

    relay = Relay()
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCK); srv.listen(8)
    log("listening on " + SOCK)

    while True:
        conn, _ = srv.accept()
        try:
            data = conn.recv(65536).decode("utf-8", "replace").strip()
            req = json.loads(data)
            ok = relay.send(req.get("to"), req["text"], own=bool(req.get("own")))
            conn.sendall(b'{"ok":true}\n' if ok else b'{"ok":false}\n')
        except Exception as e:
            log(f"request failed: {e}")
            try: conn.sendall(b'{"ok":false}\n')
            except Exception: pass
        finally:
            conn.close()

try:
    main()
except Exception as e:
    log(f"FATAL {type(e).__name__}: {e}")
finally:
    for f in (PIDF, SOCK):
        try: os.remove(f)
        except Exception: pass

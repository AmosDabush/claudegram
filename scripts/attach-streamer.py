#!/usr/bin/env python3
"""Tail the attached session's transcript and stream it to Telegram.

Hooks only fire on tool calls, so they cannot show thinking or text as it is
written. This watches the transcript file itself, which grows continuously
during a turn, and edits ONE Telegram message per turn as content arrives.

Exits on its own when the pipe leaves attach mode or the session dies.
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
PIDFILE  = f"{D}/attach-streamer.pid"
LOG      = f"{D}/attach-streamer.log"
PROJECTS = os.path.expanduser("~/.claude/projects")
SOCK     = "/tmp/cc-socks"

POLL     = 0.7
MAXAGE   = 45           # roll to a NEW message: an edited card scrolls out of view
CHUNK    = 1200         # also roll over once a card gets this long          # how often to read the transcript
EDIT_GAP = 1.6          # min seconds between Telegram edits (rate limits)
BODYCAP  = 3600
TOOLS    = 6

def log(m):
    try: open(LOG, "a").write(f"{time.strftime('%F %T')} | {m}\n")
    except Exception: pass

def env(k):
    try:
        for line in open(ENV):
            if line.startswith(k + "="):
                return line.split("=", 1)[1].strip().strip("'\"")
    except Exception: pass
    return None

TOKEN = env("BOT_TOKEN"); CHAT = env("OWNER_CHAT_ID")

def tg(method, payload):
    r = subprocess.run(
        ["curl","-s","--max-time","10","-X","POST",
         f"https://api.telegram.org/bot{TOKEN}/{method}",
         "-H","Content-Type: application/json","--data-binary","@-"],
        input=json.dumps(payload), capture_output=True, text=True)
    try: return json.loads(r.stdout or "{}")
    except Exception: return {}

def gate():
    """(pid, transcript) while we should be streaming, else None."""
    try:
        if json.load(open(MODE)).get("mode") != "attach": return None
        pid = int(json.load(open(ATTACHED))["pid"])
    except Exception:
        return None
    if not os.path.exists(f"{SOCK}/{pid}.sock"): return None
    return pid

def find_transcript(pid):
    """Newest transcript in the registry for this pid, else newest overall."""
    try:
        rec = json.load(open(f"{D}/session-registry.json")).get(str(pid))
        if rec:
            for d in os.listdir(PROJECTS):
                fp = os.path.join(PROJECTS, d, rec["session_id"] + ".jsonl")
                if os.path.exists(fp): return fp
    except Exception: pass
    return None

def describe(name, inp):
    inp = inp or {}
    if name == "Bash":  return "⚡ " + (inp.get("description") or (inp.get("command") or "")[:40])
    if name in ("Read","Edit","Write"):
        return {"Read":"📖","Edit":"✏️","Write":"📝"}[name] + " " + os.path.basename(inp.get("file_path",""))
    if name in ("Grep","Glob"): return f"🔎 {str(inp.get('pattern',''))[:30]}"
    if name == "Task": return f"🤖 {str(inp.get('description',''))[:35]}"
    return f"🔧 {name}"

# The TUI's own vocabulary, lifted from the binary.
WORDS = ['Vibing', 'Reticulating', 'Incubating', 'Brewing', 'Percolating', 'Simmering', 'Noodling', 'Pondering', 'Marinating', 'Conjuring', 'Schlepping', 'Puttering', 'Finagling']

def human_tokens(n):
    if n >= 1000: return f"{n/1000:.1f}k"
    return str(n)

def status_line(body, tools, started, done, tokens=0):
    el = int(time.time() - started) if started else 0
    tok = f" · ↓ {human_tokens(tokens)} tokens" if tokens else ""
    if done:
        return f"✅ Done ({el}s{tok})"
    word = WORDS[(el // 6) % len(WORDS)]      # rotate like the terminal does
    return f"✻ {word}… ({el}s{tok})"

def render(body, tools, thinking, done, started=None, tokens=0):
    parts = []
    if body:
        parts.append(clean(body)[-BODYCAP:])
    if tools:
        shown = tools[-TOOLS:]
        if len(tools) > TOOLS:
            shown = [f"… +{len(tools)-TOOLS}"] + shown
        parts.append("⚙️ " + "\n⚙️ ".join(shown))

    parts.append(status_line(body, tools, started, done, tokens))   # bottom
    return "\n\n".join(p for p in parts if p)

def save(mid, body, tools, cursor, ts):
    """One shared record. The PreToolUse hook writes the same file, so always
    merge rather than overwrite — otherwise the two clobber each other."""
    cur = {}
    try: cur = json.load(open(LIVE))
    except Exception: pass
    cur.update({"message_id": mid, "body": body, "ts": ts, "streamer": True})
    if tools: cur["tools"] = tools
    try: json.dump(cur, open(LIVE, "w"))
    except Exception: pass

def load_shared():
    try: return json.load(open(LIVE))
    except Exception: return {}

def main():
    open(PIDFILE, "w").write(str(os.getpid()))
    pid = gate()
    if not pid:
        log("not attached at start; exiting"); return
    path = find_transcript(pid)
    if not path:
        log(f"no transcript for pid {pid}; exiting"); return
    log(f"streaming pid={pid} file={os.path.basename(path)}")

    offset = os.path.getsize(path)      # start from now, never replay history
    mid = None; body = ""; tools = []; thinking = ""
    last_edit = 0.0; dirty = False; idle_since = time.time(); card_started = time.time()
    started = time.time(); tokens = 0; rolled_tools = 0

    while True:
        if gate() != pid:
            log("gate closed; exiting"); break

        try: size = os.path.getsize(path)
        except OSError: break

        if size > offset:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                f.seek(offset); chunk = f.read(); offset = f.tell()
            for line in chunk.splitlines():
                if not line.strip(): continue
                try: r = json.loads(line)
                except Exception: continue
                t = r.get("type")
                if t == "user":
                    # Tool RESULTS are also "user" records, as are meta records.
                    # Only a genuine user message starts a new turn — treating
                    # every user record as one wiped the card on each tool call.
                    c = (r.get("message") or {}).get("content")
                    is_result = "toolUseResult" in r or (
                        isinstance(c, list) and any(
                            isinstance(b, dict) and b.get("type") == "tool_result" for b in c))
                    if is_result or r.get("isMeta"):
                        continue
                    mid = None; body = ""; tools = []; thinking = ""
                    dirty = True
                    continue
                if t in ("attachment", "queue-operation"):
                    # Messages injected over the socket land as these, not as
                    # "user" records — they still start a new turn.
                    c = (r.get("message") or {}).get("content")
                    blob = c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)
                    if "cross-session-message" in (blob or ""):
                        mid = None; body = ""; tools = []; thinking = ""
                        started = time.time(); tokens = 0; rolled_tools = 0; dirty = True
                    continue
                if t == "system":
                    continue
                if t != "assistant": continue
                u = (r.get("message") or {}).get("usage") or {}
                if u.get("output_tokens"):
                    tokens += u["output_tokens"]
                    dirty = True
                c = (r.get("message") or {}).get("content")
                if not isinstance(c, list): continue
                for b in c:
                    if not isinstance(b, dict): continue
                    if b.get("type") == "thinking":
                        # The transcript stores thinking encrypted (signature);
                        # the plain text is never there. Only note that it ran.
                        thinking = "thinking"
                        dirty = True
                    elif b.get("type") == "text" and b.get("text","").strip():
                        body = (body + "\n\n" + b["text"].strip()).strip()
                        dirty = True
                    # tool_use is handled by the PreToolUse hook, which fires
                    # instantly instead of waiting for the transcript to flush.
            idle_since = time.time()

        # keep the elapsed counter moving even with no new content
        if mid is not None and time.time() - last_edit >= 3:
            dirty = True

        # RULE 1: attach-ctl removes this file on every send. If it is gone,
        # a new message was sent — never touch the previous card again.
        if mid is not None and not os.path.exists(LIVE):
            mid = None; body = ""; tools = []; thinking = ""
            started = time.time(); tokens = 0; rolled_tools = 0; card_started = time.time()

        shared = load_shared()
        if shared.get("message_id") and mid is None:
            mid = shared["message_id"]          # ack/hook opened the card first
            card_started = shared.get("ts", time.time())
            started = shared.get("started", card_started)
        tools = shared.get("tools", tools)

        now = time.time()
        if mid is not None and now - card_started > MAXAGE and (body or len(tools) > rolled_tools):
            tg("editMessageText", {"chat_id": CHAT, "message_id": mid,
                                   "text": render(body, tools, thinking, True, started, tokens),
                                   "disable_web_page_preview": True})
            rolled_tools = len(tools)
            mid = None; body = ""                  # keep the trail, start a new card
            card_started = now
            try: os.remove(LIVE)
            except Exception: pass
            dirty = True

        # Long turn: close this card and continue in a new message, so what you
        # already read stays put instead of being pushed around by edits.
        if mid is not None and len(body) > CHUNK:
            tg("editMessageText", {"chat_id": CHAT, "message_id": mid,
                                   "text": render(body, tools, thinking, True, started, tokens),
                                   "disable_web_page_preview": True})
            mid = None; body = ""; tools = []
            card_started = now
            try: os.remove(LIVE)
            except Exception: pass
            dirty = True
        if dirty and now - last_edit >= EDIT_GAP:
            text = render(body, tools, thinking, False, started, tokens)
            if mid is None:
                r = tg("sendMessage", {"chat_id": CHAT, "text": text,
                                       "disable_notification": True,
                                       "disable_web_page_preview": True})
                mid = (r.get("result") or {}).get("message_id")
                card_started = now
                if mid:
                    save(mid, body, tools, None, now)
            else:
                tg("editMessageText", {"chat_id": CHAT, "message_id": mid,
                                       "text": text, "disable_web_page_preview": True})
                save(mid, body, tools, None, now)
            last_edit = now; dirty = False

        time.sleep(POLL)

try:
    main()
except Exception as e:
    log(f"ERROR {type(e).__name__}: {e}")
finally:
    try: os.remove(PIDFILE)
    except Exception: pass

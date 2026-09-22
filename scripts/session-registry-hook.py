#!/usr/bin/env python3
"""Stop hook: record which live pid owns which session id.

The attach pipe discovers sessions by pid (socket filename); every title the bot
knows is keyed by session id. Nothing on disk links them, so we write the link
ourselves at the end of each turn.

Never fails a turn: any error exits 0 silently.
"""
import json, os, subprocess, sys, time

REG = os.path.expanduser("~/.claude/telegram-bot/data/session-registry.json")
SOCK = "/tmp/cc-socks"

def claude_pid():
    """Walk up from this hook to the claude process that owns a live socket."""
    pid = os.getppid()
    for _ in range(8):
        if pid <= 1:
            break
        if os.path.exists(f"{SOCK}/{pid}.sock"):
            return pid
        try:
            pid = int(subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)],
                                     capture_output=True, text=True).stdout.strip())
        except Exception:
            break
    return None

def main():
    data = json.load(sys.stdin)
    sid = data.get("session_id")
    if not sid:
        return
    pid = claude_pid()
    if not pid:
        return

    try:
        reg = json.load(open(REG))
    except Exception:
        reg = {}

    reg[str(pid)] = {
        "session_id": sid,
        "cwd": data.get("cwd") or os.getcwd(),
        "transcript": data.get("transcript_path", ""),
        "ts": int(time.time()),
    }
    # Drop entries whose socket is gone, so the file cannot grow without bound.
    reg = {p: v for p, v in reg.items() if os.path.exists(f"{SOCK}/{p}.sock")}

    os.makedirs(os.path.dirname(REG), exist_ok=True)
    tmp = REG + ".tmp"
    with open(tmp, "w") as f:
        json.dump(reg, f, indent=1)
    os.replace(tmp, REG)

try:
    main()
except Exception:
    pass
sys.exit(0)

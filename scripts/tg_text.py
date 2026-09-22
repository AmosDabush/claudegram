"""Markdown -> plain text for Telegram.

Sending with parse_mode breaks on backticks/underscores in real answers, so we
send plain — which means the markup has to be stripped, not passed through.
"""
import re

def clean(t: str) -> str:
    if not t: return ""
    t = re.sub(r"```[a-zA-Z0-9_+-]*\n?", "", t)       # fenced code markers
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t, flags=re.S) # bold
    t = re.sub(r"(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)", r"\1", t, flags=re.S)  # italic
    t = re.sub(r"`([^`]+)`", r"\1", t)                 # inline code
    t = re.sub(r"^\s{0,3}#{1,6}\s*", "", t, flags=re.M)  # headings
    t = re.sub(r"^\s*[-*]\s+", "• ", t, flags=re.M)      # bullets
    t = re.sub(r"^\s*\|.*\|\s*$", lambda m: " ".join(
        c.strip() for c in m.group(0).strip().strip("|").split("|") if c.strip()),
        t, flags=re.M)                                  # tables -> spaced text
    t = re.sub(r"^\s*[-: |]{6,}\s*$", "", t, flags=re.M)  # table rules
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)        # links
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()

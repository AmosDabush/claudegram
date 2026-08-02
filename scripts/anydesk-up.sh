#!/bin/bash
# Wake AnyDesk on this Mac so a phone can connect in.
# Launches the app (it isn't open by default), waits for the background
# service to come up, and prints the Mac's AnyDesk address on the last line.
# Output: human status lines + final line "ID: <number>" (or "ID: none").

BIN="/Applications/AnyDesk.app/Contents/MacOS/AnyDesk"

if [ ! -x "$BIN" ]; then
  echo "AnyDesk not installed"
  echo "ID: none"
  exit 1
fi

if pgrep -x AnyDesk >/dev/null 2>&1; then
  echo "AnyDesk already running"
else
  echo "Launching AnyDesk..."
  open -a AnyDesk
fi

ID=""
for i in $(seq 1 12); do
  OUT="$("$BIN" --get-id 2>/dev/null)"
  if echo "$OUT" | grep -Eq '^[0-9]{6,}$'; then
    ID="$OUT"
    break
  fi
  sleep 1
done

if [ -n "$ID" ]; then
  echo "Service is up"
  echo "ID: $ID"
else
  echo "Service did not come up in time"
  echo "ID: none"
fi

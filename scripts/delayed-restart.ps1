# Bounce the bot from inside a session that the bot itself is hosting.
#
# /restart is the normal way in, and it is one tap — but it is a tap, and the whole
# point of the last hour of work was not having to make one while driving. The bot's
# own Claude sessions are its children, so anything that restarts it kills the session
# asking for the restart, mid-sentence, before the answer is delivered.
#
# Hence the delay: long enough for the turn to finish streaming, then take the tree
# down. The supervisor treats a non-zero exit as a crash and brings it straight back,
# and the session resumes itself on the next message from its saved id.
#
# Force, and the whole tree, on purpose. A polite signal makes bot.js exit zero, which
# the supervisor reads as "asked to stop" and honours by staying down — the one outcome
# worse than not restarting at all. Killing the tree also takes the Claude children
# with it, so none survive to fight the next process over the same transcript.
# Not $Pid — that name is already PowerShell's own read-only process id, and binding a
# parameter to it fails before the script runs at all.
param(
  [Parameter(Mandatory = $true)][int]$BotPid,
  [int]$DelaySeconds = 25
)

Start-Sleep -Seconds $DelaySeconds
taskkill /F /T /PID $BotPid | Out-Null

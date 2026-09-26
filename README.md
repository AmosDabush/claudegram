# Claudegram

Control [Claude Code](https://claude.ai/code) from your phone via Telegram. Full AI coding assistant in your pocket.

Claudegram turns your Telegram into a mobile interface for the Claude CLI running on your
own machine — macOS or Windows. Send messages, manage sessions, get voice responses, run
git commands, and keep coding from anywhere.

Run several sessions at once, each in its own Telegram topic with its own history and its
own working directory, and move a session from your terminal to your phone mid-thought.

---

## Features

### AI Chat
- Send messages to Claude directly from Telegram
- Full context-aware sessions with memory across messages
- Photo analysis - send screenshots or images for Claude to analyze
- Multiple permission modes: safe, fast, plan-only, or full auto
- Cancel running requests anytime

### Voice & Text-to-Speech
- **4 TTS engines**: Edge (Microsoft), Google, Piper (local), Coqui (local)
- **3 voice modes**: off, button-click, or fully automatic
- **Hebrew & English** voice support with multiple voice actors
- **Chunked streaming** - hear the first part while the rest generates
- **7 chunk presets** from instant-first-audio to full-message
- Adjustable speech speed (-50% to +100%)
- Voice style presets: normal, casual, very casual, bro

### Several sessions at once
- **A topic per session** - each Telegram forum topic is its own conversation, with its
  own history, its own settings and its own working directory, so two sessions never
  share a memory or answer into each other
- **Move to Telegram** - send the session you are in from the terminal to your phone: it
  arrives with a summary and a Resume button, and lands back in the topic it already
  lived in, or a new one made for it
- Needs the second bot; see [Install](#install)

### Session Management
- **Resume any session** - Telegram or Mac terminal sessions
- **Unified session browser** - see all sessions across devices
- **Session persistence** - survive bot restarts
- **Bookmarks** - save sessions with description and resume button
- **Move to Mac** - transfer session to terminal with one tap
- On-demand mode (each message independent) or session mode (context preserved)

### Interactive Mode
- Claude runs as a persistent background process
- Real-time streaming responses with live updates
- Process logs and tool usage tracking
- Optional iTerm visible window for watching Claude work
- Thought mode: see Claude's reasoning process

### Parallel Processing
- **Perspectives** - get 2-5 different viewpoints on any question simultaneously
- **Investigate** - Claude breaks a problem into branches and explores all in parallel
- Progress tracking per branch with voice response support

### Git Integration
- `/status`, `/branch`, `/branches` - quick git info
- `/repo` - full repository overview
- `/ls`, `/tree`, `/files` - browse files and folders
- Git-aware project navigation

### Project Navigation
- Save project shortcuts for quick switching
- Interactive folder browser with navigation buttons
- Auto-detect git repositories
- Seamless project switching with session cleanup

### Smart Infrastructure
- **Auto-restart** on crashes (wrapper with 5 retries)
- **Caffeinate** - keeps Mac awake based on activity
- **Idle timeout** - Mac sleeps when you're not using it
- **Multi-user support** with authorization

---

## All Commands

### Chat & AI

| Command | Description |
|---------|-------------|
| _(any text)_ | Send message to Claude |
| `-r <msg>` | Quick resume - force continue session |
| `/fast <question>` | Quick answer without file tools (~3s) |
| `/new` | Start fresh session, clear context |
| `/cancel` | Stop current request |

### Sessions

| Command | Description |
|---------|-------------|
| `/sessions` | Browse & resume past sessions (Telegram + Mac) |
| `/askhistory <q>` | Ask a question about your own past sessions |
| `/session [on\|off]` | Toggle session mode (context) vs on-demand |
| `/persist [on\|off]` | Keep session alive after bot restart |
| `/bookmark [text]` | Save session with resume button |
| `/move_to_mac` | Transfer session to Mac terminal |

### Mode & Settings

| Command | Description |
|---------|-------------|
| `/mode` | Switch permission mode |
| `/settings` | Quick settings panel |
| `/interactive [on\|off]` | Toggle persistent Claude process |
| `/terminal [on\|off]` | Toggle visible iTerm window |
| `/thought [off\|on\|auto]` | Toggle extended thinking logs |
| `/claude` | Full Claude settings menu |

**Permission Modes:**
- **default** - Claude asks before risky operations
- **fast** - Quick answers, no file tools
- **plan** - Planning only, no execution
- **yolo** - Skip all permission checks (use carefully)

### Voice & TTS

| Command | Description |
|---------|-------------|
| `/voice [off\|on\|auto]` | Set voice mode |
| `/tts` | Choose TTS engine |
| `/setvoice` | Pick voice actor |
| `/setvoicespeed` | Adjust speech speed |
| `/voicestyle` | Set response style for voice |
| `/textstyle` | Set text formatting style |
| `/voicechunk` | Configure chunk size for streaming |
| `/v` | Generate voice from last response |

**Voice Modes:**
- **off** - text only
- **on** - text + click button for voice
- **auto** - voice generated automatically

**TTS Engines:**
- **Edge TTS** - Microsoft cloud, best quality, Hebrew support
- **Google TTS** - cloud, fast, multiple accents
- **Piper** - local, fastest, English only
- **Coqui** - local, multilingual

### Git & Files

| Command | Description |
|---------|-------------|
| `/status` or `/gs` | Git status |
| `/branch` | Current branch + remote |
| `/branches` | All branches |
| `/repo` | Full repo overview |
| `/ls [path]` | List files |
| `/tree [depth]` | Folder structure |
| `/files [pattern]` | Find files |
| `/git` | Git commands menu |

### Navigation

| Command | Description |
|---------|-------------|
| `/projects` | Saved project shortcuts |
| `/project <name>` | Switch to project |
| `/browse [path]` | Interactive folder browser |
| `/pwd` | Current directory + mode info |
| `/cd <path>` | Change directory |
| `/add <name> <path>` | Save new project shortcut |

### Parallel

| Command | Description |
|---------|-------------|
| `/perspectives [n] <question>` | Get N viewpoints (2-5) |
| `/investigate <problem>` | Parallel problem investigation |
| `/cancelall` | Cancel all parallel operations |

### System

| Command | Description |
|---------|-------------|
| `/menu` | Main menu |
| `/settings` | Quick settings panel |
| `/all` | List all commands |
| `/help` | Command reference |
| `/logs [n]` | Show last N log lines |
| `/logfile` | Download full log |
| `/clearlogs` | Clear log file |
| `/restart` | Restart bot (keeps sessions) |
| `/restart clean` | Restart and clear everything |
| `/reset` | Reset state without restart |
| `/close` | Shutdown bot |

---

## Quick Settings

The `/settings` command shows an inline panel where you can toggle everything with one tap:

- **Voice**: off / on / auto
- **Text Style**: default / concise / code focus / no emoji
- **Voice Style**: normal / casual / very casual / bro
- **Thought**: off / on / auto
- **Session**: on-demand / session
- **Mode**: default / fast / plan / yolo
- **Interactive**: off / on

---

## Architecture

```
start.sh
  |
  +-- caffeinate (keeps Mac awake)
        |
        +-- wrapper.js (auto-restart on crash, 5 retries)
              |
              +-- bot.js (main process)
                    |
                    +-- Interactive Claude (persistent stdin/stdout)
                    +-- On-demand Claude (per-message process)
```

### Key Components
- **start.sh** - launcher with syntax checking and caffeinate control
- **wrapper.js** - crash recovery with exponential backoff
- **bot.js** - main entry, command routing, message handling
- **lib/commands/** - modular command handlers
- **lib/tts/** - text-to-speech engine providers

---

## Requirements

- **macOS or Windows.** Both are supported from one codebase. macOS additionally gets
  `caffeinate`, iTerm integration and the live attach pipe; see
  [Platform differences](#platform-differences).
- **Node.js** 18+
- **Claude CLI** installed and working (`claude --version`)
- **Telegram account**, and one or two bots from @BotFather

---

## Install

```bash
git clone https://github.com/AmosDabush/claudegram.git
cd claudegram
npm install
node setup.js
```

`setup.js` asks for everything it needs, writes `.env`, and can start the bot. Then
`./start.sh` on macOS, `.\start.ps1` on Windows.

**Four things nobody can do for you**, because they happen inside Telegram — the setup
wizard tells you when each is needed:

1. **Create the bot** in @BotFather (`/newbot`) and copy the token.
2. **Get your user ID** from @userinfobot, so the bot answers you and nobody else.
3. **For several sessions at once, create a SECOND bot.** Not the same one twice:
   Telegram serves `getUpdates` to one consumer per token, so a shared token makes the
   two poll loops fight and both get 409s.
4. **Set that second bot up in the group**: turn Topics on, add the bot, make it an admin
   with *Manage Topics*, and turn Group Privacy **off** (@BotFather → /mybots → Bot
   Settings → Group Privacy). With privacy on it only receives messages starting with a
   slash, so ordinary conversation never reaches it.

`setup.js` detects the group's chat id for you — there is no way to read it off Telegram
by hand — and checks the admin rights before it writes anything.

See [SETUP.md](./SETUP.md) for the same ground step by step, and for doing it manually.

### Installing with Claude

Point Claude Code at this repository and it can do the whole install except the four
steps above:

> Install https://github.com/AmosDabush/claudegram on this machine.

Claude should clone it, run `npm install`, walk you through `node setup.js`, and start the
bot. Tell it up front whether you want the second bot, so it can prompt you for both
tokens in one pass rather than sending you back to @BotFather twice.

---

## Configuration

### Environment Variables (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Telegram bot token from @BotFather |
| `ALLOWED_USER_IDS` | Yes | Comma-separated Telegram user IDs |
| `GROUP_BOT_TOKEN` | No | A **second** bot's token, for a topic per session |
| `GROUP_CHAT_ID` | No | The supergroup it lives in, e.g. `-1001234567890` |
| `IDLE_TIMEOUT_HOURS` | No | Hours before the Mac can sleep (default: 24, macOS only) |
| `CLAUDE_BIN_PATH` | No | Path to the Claude CLI (default: `~/.local/bin`) |
| `PINNED_SESSION_ID` | No | Session `/resume_pinned` falls back to |
| `STREAM_EDIT_MS` | No | Milliseconds between streaming edits (default: 1200, or 3500 in a group) |
| `CLAUDEGRAM_SHARED_HOME` | No | `1` puts every chat back in one working directory |

---

## Platform differences

Everything works on both unless listed here.

| | macOS | Windows |
|---|---|---|
| Chat, sessions, topics, voice, git, menus | ✅ | ✅ |
| Keeping the machine awake (`caffeinate`) | ✅ | Not needed — a desktop does not sleep on its own |
| Visible terminal window (`/terminal`) | iTerm | ✅ |
| Live attach pipe (`/attach`, `/pipe`, `/detach`) | ✅ | ❌ |

The attach pipe drives a session that is *already running*, through a unix socket per
session. Claude Code on Windows opens no such socket, so those commands are not published
there rather than published and silent. `/resume` and *Move to Telegram* cover the same
ground by picking a session back up instead of joining it live.

---

## Checking it works

```bash
node scripts/qa.js          # the bot: routing, menus, commands, sessions
node scripts/qa-move.js     # move-to-telegram: where a moved session lands
node scripts/parity-check.js  # platform branches still return the Mac's values
```

`qa.js` drives the real handlers with synthetic Telegram updates and asserts **where every
reply lands** — the direct chat, General, or one particular topic. It has to work that way
because a bot cannot drive itself: Telegram never delivers one bot's messages to another,
and only a person can press an inline button. Outgoing calls are captured rather than
sent, the Claude CLI is stubbed, and a run uses `data-qa/` instead of your real sessions,
so it costs nothing and leaves nothing behind.

Run these before sending a pull request. Both suites found real bugs on their first run.

---

## Security

This bot runs Claude CLI on your machine with full access to your filesystem and tools. This is intentional - it's designed for personal use to control your own computer remotely.

**Rules:**
- Use only your own bot token (create via @BotFather)
- Add only your own Telegram user ID to `ALLOWED_USER_IDS`
- Never share your `.env` file or bot token
- Keep the bot running only on your personal machine
- If your token is compromised: `/revoke` via @BotFather, get new token, update `.env`, restart

---

## License

MIT

# Claudegram

Control [Claude Code](https://claude.ai/code) from your phone via Telegram. Full AI coding assistant in your pocket.

Claudegram turns your Telegram into a mobile interface for Claude CLI running on your Mac. Send messages, manage sessions, get voice responses, run git commands, and keep coding from anywhere.

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

- **macOS** (uses caffeinate, iTerm integration)
- **Node.js** 18+
- **Claude CLI** installed (`~/.local/bin/claude`)
- **Telegram account** + bot token from @BotFather

---

## Quick Start

```bash
git clone https://github.com/AmosDabush/claudegram.git
cd claudegram
npm install
cp .env.example .env
# Edit .env with your BOT_TOKEN and ALLOWED_USER_IDS
./start.sh
```

See [SETUP.md](./SETUP.md) for detailed step-by-step setup instructions.

---

## Configuration

### Environment Variables (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Telegram bot token from @BotFather |
| `ALLOWED_USER_IDS` | Yes | Comma-separated Telegram user IDs |
| `IDLE_TIMEOUT_HOURS` | No | Hours before Mac can sleep (default: 24) |
| `CLAUDE_BIN_PATH` | No | Path to Claude CLI (default: `~/.local/bin`) |

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

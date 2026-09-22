# Claudegram - Complete Command Reference

A Telegram bot that provides a full interface to Claude Code CLI on macOS. Chat with Claude, manage sessions, navigate projects, run git commands, get voice responses, and run parallel investigations -- all from Telegram.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Sending Messages](#sending-messages)
3. [Session Management](#session-management)
4. [Interactive Mode](#interactive-mode)
5. [Permission Modes](#permission-modes)
6. [Voice and TTS](#voice-and-tts)
7. [Project Navigation](#project-navigation)
8. [Git Integration](#git-integration)
9. [Parallel Processing](#parallel-processing)
10. [Thought Mode](#thought-mode)
11. [Settings and Menus](#settings-and-menus)
12. [Ask History](#ask-history)
13. [Bookmarks](#bookmarks)
14. [Session Transfer](#session-transfer)
15. [System Commands](#system-commands)
16. [Text and Voice Styles](#text-and-voice-styles)
17. [Image Analysis](#image-analysis)
18. [Troubleshooting](#troubleshooting)

---

## Getting Started

### What is Claudegram?

Claudegram is a Node.js Telegram bot that acts as a bridge between your Telegram chat and the Claude Code CLI running on your Mac. When you send a message in Telegram, the bot spawns or communicates with a Claude CLI process on your Mac, streams the response back, and can optionally convert it to voice audio.

### Prerequisites

- A Mac with Claude Code CLI installed (at `~/.local/bin/claude`)
- A Telegram bot token (from @BotFather)
- Your Telegram user ID added to `ALLOWED_USER_IDS` in the `.env` file

### First Steps

1. Start the bot with `bash start.sh` in the bot directory.
2. Open Telegram and message your bot.
3. Send `/start` to see a quick overview.
4. Send `/help` for the full command reference.
5. Type any message to chat with Claude immediately.

### Default Configuration

When you first use the bot, these are the defaults:

| Setting | Default Value |
|---------|--------------|
| Session Mode | Session (context remembered) |
| Interactive Mode | ON (persistent Claude process) |
| Permission Mode | Default (asks for permissions) |
| Voice | OFF |
| Voice Engine | Edge TTS |
| Voice Speed | Fast (1.25x) |
| Thought Mode | OFF |
| Terminal Display | Background |
| Session Persistence | OFF |
| Working Directory | Home directory |
| Text Style | Default (normal Claude) |
| Voice Style | Very Casual |
| Voice Chunk Preset | Medium |

---

## Sending Messages

### Basic Chat

Simply type any text message and send it. The bot will forward your message to Claude Code and stream the response back to you in real time.

**What happens behind the scenes:**

1. Your message is received by the bot.
2. If a style prompt is active (text style or voice style), it is prepended to your message as a system instruction.
3. **Interactive mode (default):** The message is piped to an already-running Claude process via stdin in `stream-json` format. If no process exists, one is spawned first.
4. **Non-interactive mode:** A new Claude CLI process is spawned for each message using `claude -p` with `--output-format stream-json`.
5. As Claude streams its response, the bot updates a Telegram message in real time (throttled to avoid rate limits).
6. Once complete, the final text is sent. If voice auto mode is on, an audio version is generated and sent.
7. A summary line appears showing elapsed time, tool count, and optional thought/status buttons.

### Message Indicators

When you send a message, a status indicator appears:

| Indicator | Meaning |
|-----------|---------|
| `🔄 Processing... (Xs)` | Claude is working on your request (interactive mode) |
| `🆕 Thinking...` | New session being created (non-interactive) |
| `💬 Thinking...` | Continuing existing session (non-interactive) |
| `⚡ Thinking...` | On-demand mode, no session tracking |
| `▌` | Cursor at end of streaming text means response is still being generated |

### Quick Resume with `-r`

Prefix your message with `-r` to force resume the last session, even in on-demand mode:

```
-r Can you explain the last change you made?
```

This is useful when you are in on-demand mode but want a one-off continuation.

### Sending Photos

You can send a photo to the bot with an optional caption. The bot will:

1. Download the image to a local `data/images/` directory
2. Send it to Claude with the caption (or "Please analyze this image" as default)
3. Return Claude's analysis

Old images are automatically cleaned up (only the most recent 20 are kept).

### Fast Mode Command

```
/fast <question>
```

Sends a one-shot question to Claude without file tools and without session tracking. Useful for quick general questions that do not need codebase access. Response time is typically around 3 seconds.

**Example:**
```
/fast What is the difference between let and const in JavaScript?
```

---

## Session Management

### What is a "Session"?

A session is a Claude conversation thread. It has a unique session ID, a project path, a message count, and a topic. When you resume a session, Claude remembers everything from previous messages in that thread.

Sessions are tracked in two places:
- **Local bot history** -- sessions created through the Telegram bot
- **CLI sessions** -- sessions created through `claude` on the Mac terminal

Both are visible in the unified session browser.

### Session Mode vs On-Demand Mode

| Feature | Session Mode (default) | On-Demand Mode |
|---------|----------------------|----------------|
| Icon | `💬` | `⚡` |
| Context | Claude remembers previous messages | Each message is independent |
| Session ID | Tracked and resumable | Not tracked |
| Use case | Multi-turn conversations, coding tasks | Quick one-off questions |

**Commands:**

```
/session          -- Show current mode with toggle buttons
/session on       -- Enable session mode
/session off      -- Enable on-demand mode
```

**Inline buttons when using `/session`:**

```
[ ⚡ Switch to On-Demand ] [ ✓ 💬 Session ]
```

(The currently active mode shows a checkmark.)

### Browsing and Resuming Sessions

```
/sessions         -- Open the unified session browser
/resume           -- Same as /sessions
```

The sessions menu shows two sections:

```
📱 Telegram Sessions
  📱 Fix login bug ⚡ (2h ago)
  📱 Add validation 🔥 (1d ago)
  ...

🖥 Terminal Sessions
  🖥 coview-backend - Deploy script (3h ago)
  🖥 telegram-bot - Add bookmarks (5h ago)
  ...

[ 📂 Browse All Projects ]
[ 🗑 Clear Telegram History ]
```

- **Telegram sessions** are sessions created through the bot
- **Terminal sessions** are sessions created via `claude` on your Mac
- Tapping any session resumes it (switches to its project directory and loads context)
- The mode icon (`⚡`, `📋`, `🔥`) shows which permission mode was used

### Browse All Projects

From the sessions menu, tap "Browse All Projects" to see all project directories that have CLI sessions. Select a project to see its sessions.

```
📂 All Mac Projects
  📁 coview-backend
  📁 telegram-bot
  📁 my-app
  ...
  [ ⬅️ Back ]
```

Select a project to see its sessions:

```
📁 coview-backend
  🖥 Fix the cron job (5💬)
  🖥 Add IST fields (12💬)
  ...
  [ ⬅️ Back to Projects ]
```

### Starting Fresh

```
/new              -- Clear current session, start fresh
```

This clears the active session ID. The next message you send will create a brand new session. In interactive mode, this also stops the running Claude process so a fresh one is started.

### Session Persistence

```
/persist          -- Show current status with toggle button
/persist on       -- Enable persistence
/persist off      -- Disable persistence
```

When persistence is **ON**, your active session is saved to disk and automatically restored after a bot restart. Without persistence, a bot restart means you start with no active session (though you can still manually resume old ones from the sessions list).

**Inline button:**

```
[ 💾 Enable ] or [ 🔄 Disable ]
```

---

## Interactive Mode

### What is Interactive Mode?

Interactive mode is the **default** and **recommended** way to use the bot. Instead of spawning a new Claude CLI process for every message, it keeps a single persistent Claude process running and communicates with it via `stream-json` format over stdin/stdout.

**Benefits:**
- Faster responses (no process startup overhead)
- Claude maintains full conversation context automatically
- Real-time streaming of responses with live message updates
- Tool usage tracking (shows what Claude is reading, editing, running)
- Cancel button available during processing

### Interactive vs Non-Interactive

| Feature | Interactive (default) | Non-Interactive |
|---------|----------------------|-----------------|
| Process lifecycle | Persistent, stays running | New process per message |
| Response start time | Faster (no spawn delay) | Slower (process must start) |
| Context handling | Automatic via persistent process | Via `--resume` flag per message |
| Live streaming | Updates every 500ms | Updates every 1500ms |
| Status display | Shows thinking, tools, elapsed time | Shows basic "Thinking..." |
| Cancel | Inline cancel button | `/cancel` command |

### Commands

```
/interactive      -- Show current mode with toggle button
/interactive on   -- Enable interactive mode
/interactive off  -- Disable interactive mode
```

**Inline button:**

```
[ ⚡ Turn OFF ] or [ 🔄 Turn ON ]
```

### Terminal Display

```
/terminal         -- Show current display mode with toggle
/terminal on      -- Show Claude in a visible iTerm window
/terminal off     -- Run Claude in the background
```

When terminal display is set to **iTerm**, Claude opens in a visible terminal window on your Mac so you can watch it work. When set to **Background** (default), Claude runs silently and you only see output in Telegram.

**Inline button:**

```
[ 🖥 iTerm ] or [ 🔇 Background ]
```

### What Happens During Processing

When Claude is processing your message in interactive mode, you see a status message that updates in real time:

```
🔄 Reading config.js [3] (12s)
```

This tells you:
- Claude is currently reading `config.js`
- It has used 3 tools so far
- It has been working for 12 seconds

The status updates as Claude uses different tools:

| Status | Meaning |
|--------|---------|
| `🔄 Processing...` | Initial processing |
| `🧠 Analyzing the database schema...` | Claude is thinking (shows first line of thought) |
| `🔄 Reading config.js` | Claude is reading a file |
| `🔄 Writing server.js` | Claude is writing a file |
| `🔄 Editing utils.js` | Claude is editing a file |
| `🔄 Running: npm test` | Claude is executing a bash command |
| `🔄 Searching: *.ts` | Claude is globbing for files |
| `🔄 Grep: handleAuth` | Claude is searching file contents |
| `🔄 Agent: investigate performance` | Claude launched a sub-agent |
| `🔄 Fetching URL` | Claude is fetching a web page |
| `📋 Todos: ✅2 🔄1 ⏳3` | Claude's todo list progress |
| `❌ Tool failed` | A tool returned an error |

A cancel button is always available:

```
[ 🛑 Cancel ]
```

### Completion Summary

After Claude finishes responding, a summary line is sent. Its content depends on your thought mode setting:

- **Thought OFF:** `Done (15s) [🔧5, 📝8]` -- shows elapsed time and counts
- **Thought ON:** `Done (15s)` with clickable buttons: `[🔧5] [📝8] [📋13] [🔊]`
- **Thought AUTO:** Full process log is printed inline automatically

The buttons (when thought mode is ON) use Telegram deep links:
- `🔧5` -- Shows the list of tools Claude used
- `📝8` -- Shows the status log (what was displayed during processing)
- `📋13` -- Shows the full process log with JSON details
- `🔊` -- Generates voice audio of the response (only when voice mode is "on")

---

## Permission Modes

Permission modes control what Claude is allowed to do without asking for confirmation.

```
/mode             -- Show current mode with selection buttons
```

### Available Modes

| Mode | Icon | Flag | Description |
|------|------|------|-------------|
| Default | `🔒` | (none) | Claude asks for permission before file edits, bash commands, etc. |
| Fast | `⚡` | `--allowedTools ""` | Quick answers only -- no file tools at all. Fastest responses (~3s). |
| Plan | `📋` | `--allowedTools "Read,Glob,Grep,WebFetch,WebSearch"` | Claude can read and search but cannot write, edit, or execute. Good for investigation. |
| YOLO | `🔥` | `--dangerously-skip-permissions` | Claude can do anything without asking. Use with caution. |

**Inline buttons:**

```
[ ✓ 🔒 Default ]
[ ⚡ Fast ]
[ 📋 Plan ]
[ 🔥 YOLO ]
```

The active mode shows a checkmark.

---

## Voice and TTS

The bot can convert Claude's text responses into audio voice messages. This is useful for hands-free listening, especially for longer explanations.

### Voice Modes

```
/voice            -- Show voice settings with mode selection and sub-settings
/voice off        -- Disable voice
/voice on         -- Enable voice (click button to generate)
/voice auto       -- Auto-generate voice for every response
```

| Mode | Icon | Behavior |
|------|------|----------|
| OFF | `🔇` | Text only. No voice generation. |
| ON | `🔊` | A `🔊` button appears in the summary after each response. Tap to generate voice on demand. |
| AUTO | `✨` | Voice is automatically generated and sent after every Claude response. |

**Inline buttons when using `/voice`:**

```
[ ✓ 🔇 Off ] [ 🔊 On ] [ ✨ Auto ]
[ 🔧 Engine: ☁️ Edge TTS ]
[ 🎙 Voice ] [ ⏩ Speed ]
[ 📦 Chunks: 🔸 Medium ]
[ 🎭 Style ]
```

### TTS Engines

```
/tts              -- Select TTS engine
```

| Engine | Icon | Description |
|--------|------|-------------|
| Piper | `🏠` | Local engine, fastest. Hebrew text falls back to Google. |
| Google TTS | `🔵` | Cloud-based, fast, good Hebrew support. |
| Edge TTS | `☁️` | Cloud-based, best quality, good Hebrew support. Default engine. |
| Coqui | `🐸` | Local engine, English only. Hebrew falls back to Google. |

### Voice Selection

```
/setvoice         -- Open full voice settings panel
```

This opens a comprehensive settings panel with sections for:

**Edge TTS voices:**

English voices:
- `🇺🇸 Christopher (Male)`
- `🇺🇸 Guy (Male)`
- `🇺🇸 Aria (Female)`
- `🇺🇸 Jenny (Female)` -- default
- `🇬🇧 Ryan (British Male)`
- `🇬🇧 Sonia (British Female)`

Hebrew voices:
- `🇮🇱 Avri (Male)`
- `🇮🇱 Hila (Female)` -- default

**Google TTS accents:**

English:
- `🇺🇸 American English` -- default
- `🇬🇧 British English`
- `🇦🇺 Australian English`
- `🇮🇳 Indian English`

Hebrew:
- `🇮🇱 Hebrew (Israel)` -- default
- `🇮🇱 Hebrew (Default)`

Google speed: `🚗 Normal` or `🐢 Slow`

### Voice Speed

```
/setvoicespeed    -- Adjust speech speed (Edge TTS)
```

| Option | Speed |
|--------|-------|
| `🐢 Very Slow` | 0.5x |
| `🚶 Slow` | 0.75x |
| `🚗 Normal` | 1.0x |
| `🏃 Fast` | 1.25x (default) |
| `🚀 Very Fast` | 1.5x |
| `⚡ Ultra Fast` | 2.0x |

### Voice Chunking

```
/voicechunk       -- Set chunk size for long responses
```

Long responses are split into multiple voice messages. The chunk preset controls how many lines of text go into each audio file. Smaller chunks mean faster delivery of the first audio segment; larger chunks mean fewer total messages.

| Preset | Icon | Pattern | Description |
|--------|------|---------|-------------|
| Small | `🔹` | 1-2-3-4-5-5-5... | Fastest first audio |
| Medium | `🔸` | 2-4-8-8-8... | Default, balanced |
| Large | `🟠` | 2-4-8-12-12-12... | Fewer messages |
| XL | `🟡` | 4-4-8-8-10-12-14-14... | Fewer messages |
| XXL | `🟢` | 5-10-15-20-20-20... | Large chunks |
| XXXL | `🔵` | 10-20-40-40... | Very large chunks |
| None | `⬜` | Full message | No splitting at all |

The pattern numbers represent line counts. For example, Medium (2-4-8-8...) means: first chunk is 2 lines, second is 4 lines, third and all subsequent are 8 lines.

Chunking is only applied when the response has more than 10 non-empty lines. Shorter responses are sent as a single voice message.

During chunked voice generation, a progress message is shown:

```
🎙 Processing VM 1/? with Edge TTS...
```

This message updates as each chunk is processed and is deleted when all chunks are sent.

### Get Voice/Text On Demand

```
/v                -- Generate voice from the last Claude response
/t                -- Show the last thought/status log as text
```

These commands work with the last response regardless of your current voice mode. Use `/v` to hear a response you only got as text, or `/t` to see the thought process of a response you got as voice.

### Language Detection

The TTS system automatically detects whether Claude's response is in English or Hebrew and selects the appropriate voice. Each engine has separate voice settings for English and Hebrew.

---

## Project Navigation

Projects are named shortcuts to directories on your Mac. The bot needs to know which directory to use as the working directory when running Claude.

### Projects

```
/projects         -- Show saved projects as inline buttons
/project <name>   -- Switch to a named project
```

Projects are displayed as a grid of buttons:

```
📁 Select a project:
Current: coview-backend

[ ✓ coview-backend ] [ telegram-bot ]
[ home ]             [ git ]
[ desktop ]          [ downloads ]
```

The currently active project shows a checkmark. Tapping a project switches to it and changes the working directory.

**Default projects** (always available):
- `home` -- Home directory
- `git` -- `~/git`
- `desktop` -- `~/Desktop`
- `downloads` -- `~/Downloads`

### Adding Projects

```
/add <name> <path>   -- Add a new project shortcut
```

**Examples:**
```
/add myapp ~/git/my-application
/add backend /Users/me/projects/backend
```

The path must exist. Tilde (`~`) is expanded to your home directory.

### Browsing Directories

```
/browse              -- Browse current directory
/browse <path>       -- Browse a specific path
```

This opens an interactive directory browser with buttons:

```
📂 Browse: /Users/me/git

[ ✅ SELECT THIS PATH ]
[ ⬆️ .. (go up) ]
[ 📦 coview-backend ]
[ 📦 telegram-bot ]
[ 📁 temp ]
[ 📁 docs ]
```

- `📦` = Git repository (clicking selects it as current project)
- `📁` = Regular folder (clicking enters it to browse further)
- `⬆️` = Go to parent directory
- `✅ SELECT THIS PATH` = Set the currently displayed directory as your working directory

### Changing Directory

```
/cd <path>           -- Change working directory directly
```

Supports absolute paths, relative paths, and tilde expansion.

**Examples:**
```
/cd ~/git/myproject
/cd ..
/cd src/components
```

### Current Path

```
/pwd                 -- Show current project name, path, session mode, and voice status
```

Output:
```
📁 Current: coview-backend
/Users/me/git/coview-backend
Mode: 💬 Session | 🔊
```

---

## Git Integration

Git commands run in the current project directory. These are read-only convenience commands -- for git operations that modify state (commit, push, etc.), ask Claude directly.

### Git Commands Menu

```
/git                 -- Show git commands as inline buttons
```

```
🌿 Git Commands
[ 📊 Status ]
[ 🌿 Branch ] [ 🌲 All Branches ]
[ 📦 Repo Info ]
[ 📂 List Files (ls) ]
[ 🌳 Tree View ] [ 🔍 Find Files ]
```

### Individual Commands

```
/status   or /gs     -- Git status (modified/staged files)
/branch              -- Current branch name and remote URL
/branches            -- List all local and remote branches
/repo                -- Full repo info: project, branch, remote, last commit, changes
```

### File Listing Commands

```
/ls                  -- List files in current directory (ls -la)
/ls <subpath>        -- List files in a subdirectory
/tree                -- Show folder structure (2 levels deep, max 50 entries)
/tree <depth>        -- Show folder structure with custom depth
/files               -- List all files recursively (max 50)
/files <pattern>     -- Find files matching a glob pattern
```

**Examples:**
```
/ls src
/tree 3
/files *.js
```

---

## Parallel Processing

Run multiple Claude instances simultaneously for broader analysis.

### Perspectives

```
/perspectives                       -- Show help
/perspectives <question>            -- Get 3 different viewpoints (default)
/perspectives <N> <question>        -- Get N viewpoints (2-5)
```

Spawns N independent Claude processes, each given a different perspective prompt:

1. **Practical, implementation-focused** perspective
2. **Thorough, analytical** perspective (edge cases)
3. **Creative, alternative approach** perspective
4. **Critical, devil's advocate** perspective (what could go wrong)
5. **Simplified, beginner-friendly** perspective

A status message tracks progress:

```
🔀 Perspectives
Getting 3 different viewpoints...

1. ✅ Done
2. 🔄 Processing...
3. ⏳ Waiting...
```

Each perspective is sent as a separate message:

```
🔀 Perspective 1/3

[Response text]
```

**Examples:**
```
/perspectives What is the best way to handle authentication?
/perspectives 4 How should we optimize our database queries?
```

### Investigate

```
/investigate                        -- Show help
/investigate <problem>              -- Break down and investigate in parallel
```

This is a two-phase process:

**Phase 1: Breakdown.** Claude analyzes your problem and creates 3-5 investigation branches, returned as a JSON array.

**Phase 2: Parallel investigation.** All branches are investigated simultaneously by independent Claude processes. Each branch gets its own Telegram message that updates in real time as Claude streams its findings.

```
🌳 Parallel Investigation

📋 4 branches identified:
1. Investigate backend API response times
2. Analyze client-side React rendering
3. Check network requests and caching
4. Review browser performance metrics

🔄 Investigating all branches in parallel...
```

Each branch message updates live:

```
🔹 Branch 1: Investigate backend API...

[Streaming response with findings...]
```

When all branches complete, a summary is generated and sent:

```
📊 Summary

Based on the investigation findings...
[Consolidated summary with action items]
```

If voice is enabled, each branch result and the summary are also sent as voice messages.

**Examples:**
```
/investigate slow rendering on the main dashboard
/investigate memory leak in background worker process
/investigate authentication failures in production
```

### Cancel All

```
/cancelall           -- Cancel all running parallel operations
```

---

## Thought Mode

Thought mode controls whether you see the behind-the-scenes process log of what Claude did to generate a response.

```
/thought             -- Show current mode with selection buttons
/thought off         -- No thought log
/thought on          -- Click button to view thought log
/thought auto        -- Thought log shows automatically
```

### Three Modes

| Mode | Icon | Behavior |
|------|------|----------|
| OFF | `🔇` | No thought log. Summary shows counts only: `Done (15s) [🔧5, 📝8]` |
| ON | `🧠` | Summary includes clickable deep-link buttons that show tools, status, and full log when tapped |
| AUTO | `✨` | Full thought log is printed inline after the response, including status steps and tools used |

**Inline buttons:**

```
[ ✓ 🔇 Off ] [ 🧠 On ] [ ✨ Auto ]
```

### What the Thought Log Contains

The thought log tracks three categories:

**Status log** (`📝`): Human-readable status messages shown during processing, such as "Reading config.js", "Running npm test", "Thinking about the architecture".

**Tools log** (`🔧`): List of every tool Claude invoked, such as "Read: /path/to/file.js", "Bash: git status", "Grep: handleAuth".

**Full process log** (`📋`): Complete JSON stream entries with types, content previews, and results. Useful for debugging.

### Deep-link Buttons (Thought ON mode)

When thought mode is ON, the summary line includes buttons that use Telegram deep links (`https://t.me/botname?start=tools`). Tapping these sends `/start tools` (or `status`, `fulllog`, `v`) to the bot, which retrieves the cached log data and displays it.

Logs are cached for 10 minutes and then automatically cleaned up.

---

## Settings and Menus

### Quick Settings Panel

```
/settings            -- Open the quick settings panel
```

This is a compact panel where you can change all major settings without typing commands. Each row shows the current value and lets you change it with a single tap:

```
⚙️ Quick Settings

📍 coview-backend

[ Voice: 🔇 ] [ off ] [ on ] [ auto ]
[ TxtStyle: 📝 ] [ 📝 ] [ ⚡ ] [ 💻 ] [ 🚫 ]
[ VoiceStyle: 🎙 ] [ 📝 ] [ 💬 ] [ 🎙 ] [ 🤙 ]
[ Thought: 🔇 ] [ off ] [ on ] [ auto ]
[ Session: 💬 ] [ demand ] [ session ]
[ Mode: 🔒 ] [ 🔒 ] [ ⚡ ] [ 📋 ] [ 🔥 ]
[ Interactive: 🔄 ] [ off ] [ on ]
[ ⬅️ Back to Menu ]
```

The currently active option shows a `●` bullet. Labels on the left show the setting name and current icon. Tapping any option changes it immediately and refreshes the panel.

### Main Menu

```
/menu                -- Open the main menu
```

The main menu is an interactive category browser:

```
🤖 Claude Code Bot

📍 coview-backend
💬 Session | 🔇

Select a category:

[ ⚙️ Quick Settings ]
[ 🤖 Claude AI ] [ 🔄 Interactive ]
[ 📂 Navigation ] [ 📋 Quick Commands ]
[ 🌿 Git ] [ 🔀 Parallel ]
[ 🎙 Voice ] [ 📜 Logs ]
[ 🛑 Cancel Request ]
```

Each category opens a sub-menu with relevant commands and settings. All sub-menus have a `⬅️ Back to Menu` button to return to the main menu.

### Claude Session Panel

```
/claude              -- Open the Claude session control panel
```

```
🤖 Claude Session

🔄 Interactive: ON (running)
🖥 Display: Background

Interactive = Claude runs persistently
iTerm = See Claude in visible window

Just type a message to chat!

[ 🔄 Interactive: ON ] [ 🖥 BG ]
[ ▶️ Resume Last Session ]
[ 📚 Past Sessions ]
[ 🆕 New Session ]
[ 💬 Toggle Mode ] [ ⚙️ Permission ]
[ 🧠 Thought Log ] [ 💾 Persist ]
[ 🖥 Move to Mac ]
[ 🛑 Cancel ]
```

### All Commands List

```
/all                 -- Show all commands organized by category (text, not interactive)
```

### Help

```
/help                -- Full help text with all commands, modes, and current status
/?                   -- Same as /help
```

---

## Ask History

Ask a question about your own past sessions and get an answer, not a list of results.

```
/askhistory why did we go back to showing days instead of hours
/askhistory                     (asks you what to look for)
```

`/ask` and `/ask_history` do the same thing. There is also an **✦ Ask History** button on the main menu and on the Claude session panel.

### What comes back

An answer with numbered citations, then a source list, then a Resume button for each session that was quoted - tapping one opens that session in iTerm on the Mac. So an answer read on the phone is one tap away from the real transcript.

The whole thing takes around 30-45 seconds. Progress is reported live in a single message that keeps updating: the terms being searched, which ones were thrown out as too common, and the real identifiers dug out of the archive along the way.

### How it finds things

Plain keyword search fails here, because the answer is usually filed under a name the question did not guess. So:

- The planner is handed a catalog of your session titles and notes, so its search terms come from your actual vocabulary rather than invention. It can also nominate sessions on a hunch from the titles alone.
- Terms appearing in most sessions are dropped as noise, and rare terms count for more. Otherwise one generic word like "revert" drowns everything.
- A second round harvests the real identifiers out of whatever the first round found - column names, ticket ids, branches - and searches again. This is what rescues a question whose subject turns out to be called something else entirely.
- Only the top sessions are read in full, with the messages either side of each match. A session that matched only inside a tool payload is discarded.
- When excerpts disagree, the later one wins and the answer says so, because decisions here get reversed over time.

### Notes

- Answers are grounded in your sessions only. If the archive does not cover it, it says so instead of guessing.
- Requires the sessions UI server on the Mac. If it is not running, the bot starts it.
- One question at a time per chat.

## Bookmarks

Bookmarks let you save a snapshot reference to a session that you can resume later with a single tap.

```
/bookmark                     -- Save current session (bot will ask for description)
/bookmark <description>       -- Save with inline description
```

### How It Works

1. The bot checks for an active session (interactive session ID or local session).
2. If no description is provided, it prompts you with a force-reply: "Describe this session:"
3. Once you provide a description, a bookmark message is sent:

```
Session Bookmark

Project: coview-backend
Date: 15/2/2026 14:30
Messages: 12
Session: a1b2c3d4

Fixing the authentication flow for SSO login

Tap to resume:
[ Resume Session ]
```

The "Resume Session" button uses the `uresume:` callback, which works the same as resuming from the sessions menu. It will:
- Stop any currently running interactive session
- Switch to the bookmarked project directory
- Enable session mode
- Resume the session with `--resume`

### Use Case

Bookmarks are persistent messages in your Telegram chat history. Unlike the sessions menu (which shows the most recent 20), bookmarks stay in your chat forever. They are useful for marking important sessions you may want to return to weeks later.

---

## Session Transfer

### Move to Mac

```
/move_to_mac         -- Get the terminal command to continue this session on your Mac
```

This generates a ready-to-paste terminal command:

```
🖥 Session ready on Mac!

Topic: Fix authentication
Path: /Users/me/git/coview-backend
Mode: default

Run this command:

cd "/Users/me/git/coview-backend" && claude --resume 'a1b2c3d4-...' --allowedTools "Read,Glob,Grep,WebFetch,WebSearch"
```

Copy the command, paste it into your Mac terminal, and you continue the exact same session with Claude in full terminal mode.

The command includes:
- `cd` to the correct project directory
- `--resume` with the session ID
- Any mode flags that were active (e.g., `--dangerously-skip-permissions` for YOLO mode)

### Resume CLI Sessions in Telegram

When you use `/sessions`, the bot also shows sessions from your Mac terminal. You can resume any CLI session directly in Telegram -- effectively moving a terminal session to Telegram.

---

## System Commands

### Restart

```
/restart             -- Restart the bot (preserves session ID for resume)
/restart clean       -- Restart and clear all sessions
```

**Normal restart:** Kills all Claude processes, saves state, restarts via `start.sh` (which wraps the process with `caffeinate` to prevent sleep). After restart, sends a "Bot restarted successfully!" notification. Sessions are preserved and can be resumed.

**Clean restart:** Same as normal restart, but also clears all session history and the sessions file.

### Close

```
/close               -- Shut down the bot completely (all instances)
```

Sends a goodbye message and exits the process. Unlike restart, the bot does not come back automatically.

### Reset

```
/reset               -- Reset user state without restarting the bot
```

This clears all runtime state for your user:
- Kills any running Claude processes
- Clears processing flags
- Clears session history
- Resets message queue

Settings (voice, mode, etc.) are preserved. This is useful when the bot seems stuck.

### Cancel

```
/cancel              -- Cancel the current Claude request
```

- In interactive mode: kills the running interactive Claude process
- In non-interactive mode: kills the spawned Claude process
- If nothing is running: reports "Nothing to cancel"

### Logs

```
/logs                -- Show last 50 lines of bot.log
/logs <N>            -- Show last N lines of bot.log
/logfile             -- Download the full bot.log as a file
/clearlogs           -- Clear the log file
```

If the log output exceeds 4000 characters, it is sent as a downloadable text file instead of inline text.

---

## Text and Voice Styles

Styles modify how Claude responds. Text styles apply to text responses; voice styles apply when voice auto mode is active.

### Text Styles

```
/textstyle           -- Show text style selection menu
```

Text styles prepend a system instruction to your message that influences Claude's response format:

| Style | Icon | Description |
|-------|------|-------------|
| Default | `📝` | Normal Claude response. No modification. |
| Concise | `⚡` | Short, direct answers. Skip unnecessary explanations. |
| Detailed | `📚` | Full explanations with examples. Thorough. |
| Code Focus | `💻` | Minimal text. Show working code first, explain only if needed. |
| No Emoji | `🚫` | Plain text only. No emojis in response. |

Text styles are active when voice mode is OFF or ON (button mode). When voice mode is AUTO, voice styles are used instead.

### Voice Styles

```
/voiceresponse       -- Show voice style selection menu
/voicestyle          -- Same as /voiceresponse
```

Voice styles optimize Claude's response for spoken output:

| Style | Icon | Description |
|-------|------|-------------|
| Off | `📝` | Normal text response. No voice optimization. |
| Normal | `🗣` | Light formatting. Minimize markdown. |
| Casual | `💬` | Conversational speech. No markdown, no bullet points. Short sentences. |
| Very Casual | `🎙` | Natural spoken explanation. No code blocks, no URLs read verbatim. Describes code instead of showing it. Uses phrases like "basically" and "what's happening is". Default voice style. |
| Bro | `🤙` | Friend chat mode. Very casual, friendly, slight humor. Sounds like WhatsApp voice chat. Never pastes code. Hand-waves non-critical details. |

Voice styles are active only when voice mode is AUTO. The style prompt is prepended to your message in brackets: `[STYLE_PROMPT]\n\nYour message`.

### Style Priority

The bot determines which style to apply based on voice mode:

| Voice Mode | Style Used |
|------------|------------|
| OFF | Text style |
| ON (button) | Text style |
| AUTO | Voice style |

---

## Image Analysis

Send a photo to the bot to have Claude analyze it.

### How to Use

1. Send a photo in the chat
2. Optionally include a caption with your question
3. The bot downloads the image, sends it to Claude, and returns the analysis

### What Happens

1. Bot sends "Downloading image..." status
2. Image is saved to `data/images/` directory
3. Status updates to "Analyzing image with Claude..."
4. Claude is invoked with `claude -p` and the image path
5. Response is sent back to Telegram
6. Old images (beyond the most recent 20) are cleaned up

### Default Caption

If no caption is provided, the default prompt is "Please analyze this image".

---

## Troubleshooting

### Bot Seems Stuck / Not Responding

**Symptom:** Messages are sent but no response comes back.

**Solutions:**
1. Send `/cancel` to abort any running request
2. Send `/reset` to clear all runtime state
3. Send `/restart` if reset does not help
4. Check `/logs` for error messages

### "Already processing" Error

**Symptom:** Bot replies with "Already processing. Use /cancel first."

**Solution:** Send `/cancel` then try again. If that does not work, send `/reset`.

### Session Not Resuming Properly

**Symptom:** Claude does not remember previous context.

**Solutions:**
1. Check that you are in session mode (`/session`)
2. Check that the project path matches (`/pwd`)
3. Use `/sessions` to explicitly resume the correct session
4. If the project path changed, the session is automatically cleared

### Voice Not Working

**Symptom:** No audio is generated.

**Solutions:**
1. Check voice mode is ON or AUTO (`/voice`)
2. Check the TTS engine is installed (`/tts`)
3. For Edge TTS: requires `edge-tts` npm package or Python package
4. For Piper: requires local piper binary and voice models
5. For Google: requires `google-tts-api` npm package
6. Check `/logs` for voice-related errors

### Interactive Process Died

**Symptom:** Bot says "Starting new session..." every time, even though interactive mode is on.

**Explanation:** The persistent Claude process may have crashed or timed out.

**Solution:** This is normal -- the bot automatically starts a new process. If it keeps happening, check `/logs` for crash reasons. You can also try `/restart`.

### Cannot Find CLI Sessions

**Symptom:** `/sessions` does not show Mac terminal sessions.

**Explanation:** CLI sessions are read from `~/.claude/projects/`. The path encoding may not match.

**Solution:** Use "Browse All Projects" from the sessions menu to navigate manually. If projects still do not appear, the CLI session files may be in an unexpected format.

### Bot Killed Previous Instance

**Symptom:** Log shows "Killed previous instance (PID: XXXX)".

**Explanation:** This is normal behavior. The bot uses PID file tracking and process detection to ensure only one instance runs at a time. On startup, it kills any existing `bot.js` processes.

### Long Response Truncated

**Symptom:** Response ends with `_(truncated)_` or seems cut off.

**Explanation:** Telegram messages have a 4096 character limit. For longer responses, the bot splits them into multiple messages using `sendLongMessage`. In interactive mode during streaming, the displayed text is capped at 4000 characters. The full text is sent as the final message.

### Rate Limiting

**Symptom:** Message updates appear jerky or delayed.

**Explanation:** The bot throttles message edits to avoid Telegram API rate limits. In interactive mode, edits are throttled to every 500ms. In non-interactive streaming mode, edits happen every 1500ms.

### Process Timeout

**Symptom:** Error message says "Timeout".

**Explanation:** Claude processes have a 5-minute timeout (non-interactive streaming) or 3-minute timeout (parallel operations, image analysis). If Claude takes longer, the process is killed.

**Solution:** Break complex tasks into smaller steps, or use interactive mode where there is no per-request timeout (the persistent process stays alive).

---

## Command Quick Reference

### Navigation
| Command | Description |
|---------|-------------|
| `/projects` | Show saved projects |
| `/project <name>` | Switch to a project |
| `/browse` | Interactive folder browser |
| `/cd <path>` | Change directory |
| `/pwd` | Show current path and mode |
| `/add <name> <path>` | Save a project shortcut |

### Files and Git
| Command | Description |
|---------|-------------|
| `/ls` | List files |
| `/tree` | Folder structure (2 levels) |
| `/files` | Find files |
| `/git` | Git commands menu |
| `/status` / `/gs` | Git status |
| `/branch` | Current branch |
| `/branches` | All branches |
| `/repo` | Full repo info |

### Claude AI
| Command | Description |
|---------|-------------|
| (any text) | Send to Claude |
| `-r <msg>` | Force resume last session |
| `/new` | Start fresh session |
| `/session` | Toggle session/on-demand |
| `/sessions` | Browse and resume sessions |
| `/resume` | Same as /sessions |
| `/askhistory <q>` | Answer a question from your past sessions |
| `/persist` | Toggle session persistence |
| `/mode` | Change permission mode |
| `/fast <q>` | Quick answer without tools |
| `/cancel` | Stop current request |

### Interactive Mode
| Command | Description |
|---------|-------------|
| `/interactive` | Toggle interactive mode |
| `/terminal` | Toggle iTerm/background display |

### Parallel
| Command | Description |
|---------|-------------|
| `/perspectives [N] <q>` | Get N viewpoints |
| `/investigate <problem>` | Parallel branch investigation |
| `/cancelall` | Cancel all parallel operations |

### Voice
| Command | Description |
|---------|-------------|
| `/voice` | Toggle voice mode (off/on/auto) |
| `/tts` | Select TTS engine |
| `/setvoice` | Change voice actor |
| `/setvoicespeed` | Adjust speech speed |
| `/voiceresponse` | Voice response style |
| `/voicechunk` | Chunk size for long responses |
| `/textstyle` | Text formatting style |
| `/v` | Get last response as voice |
| `/t` | Get last thought/status log |

### Menus and Settings
| Command | Description |
|---------|-------------|
| `/menu` | Main interactive menu |
| `/settings` | Quick settings panel |
| `/claude` | Claude session control panel |
| `/all` | List all commands |
| `/help` / `/?` | Full help text |

### Bookmarks
| Command | Description |
|---------|-------------|
| `/bookmark` | Save session (asks for description) |
| `/bookmark <desc>` | Save session with description |

### Session Transfer
| Command | Description |
|---------|-------------|
| `/move_to_mac` | Get terminal resume command |

### System
| Command | Description |
|---------|-------------|
| `/restart` | Restart bot (keep sessions) |
| `/restart clean` | Restart and clear everything |
| `/close` | Shut down bot |
| `/reset` | Reset stuck state |
| `/logs [N]` | Show last N log lines |
| `/logfile` | Download full log |
| `/clearlogs` | Clear log file |

---

## Callback Data Reference

This section documents the internal callback data strings used by inline keyboard buttons. Useful for development and debugging.

### Navigation
| Callback | Action |
|----------|--------|
| `proj:<name>` | Switch to project |
| `bn:<pathId>` | Browse into directory |
| `bs:<pathId>` | Select directory as working dir |

### Claude Session
| Callback | Action |
|----------|--------|
| `session:on` | Enable session mode |
| `session:off` | Enable on-demand mode |
| `mode:<name>` | Set permission mode (default/fast/plan/yolo) |
| `interactive:on` | Enable interactive mode |
| `interactive:off` | Disable interactive mode |
| `interactive:cancel` | Cancel current interactive request |
| `terminal:on` | Enable iTerm display |
| `terminal:off` | Disable iTerm display |
| `thought:off/on/auto` | Set thought mode |
| `persist:on/off` | Toggle session persistence |
| `uresume:<shortId>` | Resume unified session |
| `resume:<shortId>` | Resume local session |
| `resume:clear` | Clear session history |
| `cli:<shortId>` | Resume CLI session |
| `clibrowse:list` | Browse all CLI projects |
| `clibrowse:back` | Back to sessions menu |
| `clibrowse:<encoded>` | Show sessions for project |
| `cliproj:<encoded>:<shortId>` | Resume session from project browse |

### Voice
| Callback | Action |
|----------|--------|
| `voicemode:off/on/auto` | Set voice mode |
| `tts:<engineId>` | Set TTS engine |
| `voice:en:<voiceId>` | Set Edge English voice |
| `voice:he:<voiceId>` | Set Edge Hebrew voice |
| `googlevoice:<tld>` | Set Google accent |
| `googlehebrew:<tld>` | Set Google Hebrew TLD |
| `googlespeed:<id>` | Set Google speed |
| `speed:<rate>` | Set Edge speed |
| `voicestyle:<id>` | Set voice response style |
| `textstyle:<id>` | Set text response style |
| `chunk:<preset>` | Set chunk preset |
| `getvoice:<id>` | Generate voice from cached text |
| `showlog:<id>` | Show cached thought log |

### Quick Settings
| Callback | Action |
|----------|--------|
| `qset:voice:off/on/auto` | Quick set voice mode |
| `qset:thought:off/on/auto` | Quick set thought mode |
| `qset:session:demand/session` | Quick set session mode |
| `qset:perm:default/fast/plan/yolo` | Quick set permission mode |
| `qset:interactive:off/on` | Quick set interactive mode |
| `qset:txtstyle:<id>` | Quick set text style |
| `qset:vocstyle:<id>` | Quick set voice style |

### Menu
| Callback | Action |
|----------|--------|
| `all:back` | Back to main menu |
| `all:settings` | Open quick settings |
| `all:claude` | Claude AI section |
| `all:interactive` | Interactive section |
| `all:nav` | Navigation section |
| `all:files` | Quick commands section |
| `all:git` | Git section |
| `all:parallel` | Parallel section |
| `all:voice` | Voice section |
| `all:logs` | Logs section |

### Commands (button triggers)
| Callback | Action |
|----------|--------|
| `cmd:voice` | Cycle voice mode |
| `cmd:tts` | Show TTS engine menu |
| `cmd:setvoice` | Show voice settings |
| `cmd:setvoicespeed` | Show speed menu |
| `cmd:voiceresponse` | Show voice style menu |
| `cmd:voicestyle` | Show voice style menu |
| `cmd:textstyle` | Show text style menu |
| `cmd:voicechunk` | Show chunk preset menu |
| `cmd:sessions` | Show sessions menu |
| `cmd:session` | Show session mode toggle |
| `cmd:new` | Start new session |
| `cmd:interactive` | Show interactive toggle |
| `cmd:terminal` | Show terminal toggle |
| `cmd:resume` | Show sessions menu |
| `cmd:mode` | Show mode menu |
| `cmd:cancel` | Cancel current request |
| `cmd:persist` | Show persist toggle |
| `cmd:thought` | Show thought mode |
| `cmd:move_to_mac` | Move session to Mac |
| `cmd:perspectives` | Show perspectives help |
| `cmd:investigate` | Show investigate help |
| `cmd:pwd` | Show current path |
| `cmd:projects` | Show projects |
| `cmd:browse` | Open folder browser |
| `cmd:status` | Run git status |
| `cmd:branch` | Show current branch |
| `cmd:branches` | Show all branches |
| `cmd:repo` | Show repo info |
| `cmd:ls` | List files |
| `cmd:tree` | Tree view |
| `cmd:files` | Find files |
| `cmd:logs50` | Show 50 log lines |
| `cmd:logs100` | Show 100 log lines |
| `cmd:logfile` | Download log file |
| `cmd:clearlogs` | Clear log file |
| `noop` | No operation (section headers) |

---

## Architecture Notes

### Data Storage

All persistent data is stored in the `data/` directory:

| File | Purpose |
|------|---------|
| `user-state.json` | Per-user settings (mode, voice, project, etc.) |
| `sessions.json` | Session history (per chat) |
| `unified-sessions.json` | Unified registry of all sessions (Telegram + CLI) |
| `projects.json` | Custom project shortcuts |
| `bot.pid` | Current bot process ID |
| `restart-notify.txt` | Chat ID to notify after restart |
| `last_activity` | Timestamp of last user activity |
| `images/` | Downloaded Telegram photos (max 20 kept) |

### Security

- Only user IDs listed in `ALLOWED_USER_IDS` (from `.env`) can use the bot
- Unauthorized access attempts are logged
- The bot kills previous instances on startup to prevent duplicates

### Process Management

- PID file tracking prevents multiple bot instances
- On startup, kills any orphan `bot.js` processes
- Interactive Claude processes are killed on exit
- `caffeinate` (via `start.sh`) prevents Mac from sleeping while bot runs

### State Persistence

- User state is saved with a 2-second debounce (groups rapid changes into a single write)
- `saveNow()` is called on process exit for immediate persistence
- Runtime-only fields (process references, timers, etc.) are never written to disk
- `interactiveSessionId` is preserved across restarts for auto-resume capability


## Live Session Pipe

Drive a session that is **already running** instead of resuming a dead one.
`--resume` starts a new process over an old transcript; this delivers your
message into the live process, so there is one session, not two.

*In Telegram*
- `/attach` — pick a live session from a list
- `/detach` — stop driving it
- `/pipe` — switch between **ATTACH** and **RESUME**

*From a terminal session*
- `/remote-telegram-current-session` — attach the session you are sitting in
- `/remote-telegram-all` — push the whole picker to Telegram

**The pipe is a hard switch, not a fallback.** In ATTACH, a failed delivery
reports the error and stays put — it never quietly reroutes your message into a
resumed session. Switch back with `/pipe` when you want the normal flow.

Sending takes about a second; the target picks the message up on its next turn.
Every attempt is logged to `data/attach-relay.log`.

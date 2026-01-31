# Architecture - Claude Telegram Bot

Technical documentation for understanding exact behavior flows.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              TELEGRAM BOT                                    │
│                                                                             │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────────────────┐   │
│  │   bot.js    │───▶│ Command      │───▶│ Claude CLI                  │   │
│  │  (entry)    │    │ Modules      │    │ (~/.local/bin/claude)       │   │
│  └─────────────┘    └──────────────┘    └─────────────────────────────┘   │
│         │                  │                         │                      │
│         ▼                  ▼                         ▼                      │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────────────────┐   │
│  │   state.js  │    │ sessions.js  │    │ Anthropic API               │   │
│  │ (per user)  │    │ (history)    │    │ (via Claude CLI)            │   │
│  └─────────────┘    └──────────────┘    └─────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## File Responsibilities

| File | Purpose | Key Functions |
|------|---------|---------------|
| `bot.js` | Entry point, routing, menus | Telegram handlers, callback routing |
| `lib/state.js` | User state management | `getUserState()`, `scheduleSave()`, persistence |
| `lib/sessions.js` | Session history | `getSession()`, `setSession()`, CLI session discovery |
| `lib/config.js` | Constants & presets | TTS engines, voice options, style prompts |
| `lib/utils.js` | Helpers | `sendLongMessage()`, `getModeFlag()`, `formatForTelegram()` |
| `lib/commands/claude.js` | Core Claude logic | `handleMessage()`, `startInteractiveSession()`, streaming |
| `lib/commands/voice.js` | Voice settings | TTS menus, voice/text style selection |
| `lib/commands/navigation.js` | Projects & folders | `/projects`, `/browse`, `/cd` |
| `lib/commands/git.js` | Git commands | `/status`, `/branch`, `/repo` |
| `lib/commands/parallel.js` | Multi-agent | `/perspectives`, `/investigate` |
| `lib/tts/index.js` | TTS router | `generateVoice()`, `generateVoiceChunked()` |

---

## User State Structure

```javascript
// Stored in data/user-state.json per chat ID
{
  // Navigation
  currentProject: 'home',           // Project name
  currentPath: '/Users/...',        // Filesystem path

  // Claude Settings
  currentMode: 'default',           // default | fast | plan | yolo
  sessionMode: true,                // true=session, false=on-demand
  persistSession: false,            // Survive restarts

  // Voice Settings
  voiceMode: 'off',                 // off | on | auto
  voiceSettings: {
    ttsEngine: 'edge',              // edge | google | piper | coqui
    voice: 'en-US-JennyNeural',     // English voice ID
    hebrewVoice: 'he-IL-HilaNeural',// Hebrew voice ID
    rate: '+25%',                   // Speed for Edge TTS
    responseLevel: 'very_casual',   // Voice style (for auto mode)
    textStyle: 'off',               // Text style (for off/on mode)
    chunkPreset: 'medium'           // Chunk size preset
  },

  // Interactive Mode
  interactiveMode: true,            // Use persistent Claude process
  showTerminal: false,              // Show in iTerm vs background
  interactiveSessionId: null,       // For resume after restart

  // Thought Log
  thoughtMode: 'off',               // off | on | auto

  // Runtime (not persisted)
  isProcessing: false,
  currentClaudeProc: null,
  interactiveProc: null,
  pendingMessage: null,
  interactiveThinkingMsgId: null,
  interactiveStartTime: null,
  interactiveToolsUsed: []
}
```

---

## Style System

### Two Style Systems

The bot has **two separate style systems** that apply based on `voiceMode`:

| voiceMode | Style Used | Setting Location | Purpose |
|-----------|------------|------------------|---------|
| `off` | Text Style | `voiceSettings.textStyle` | Regular text responses |
| `on` | Text Style | `voiceSettings.textStyle` | Text + optional voice button |
| `auto` | Voice Style | `voiceSettings.responseLevel` | Auto-voice optimized |

### Text Style Options (`textStyle`)

```javascript
TEXT_STYLE_OPTIONS = [
  { id: 'off', name: '📝 Default', prompt: null },
  { id: 'concise', name: '⚡ Concise', prompt: 'Be concise. Short sentences...' },
  { id: 'detailed', name: '📚 Detailed', prompt: 'Provide detailed explanations...' },
  { id: 'code_only', name: '💻 Code Only', prompt: 'Minimal text, maximum code...' },
  { id: 'no_emoji', name: '🚫 No Emoji', prompt: 'Never use emojis...' }
]
```

### Voice Style Options (`responseLevel`)

```javascript
VOICE_STYLE_OPTIONS = [
  { id: 'off', name: '📝 Default', prompt: null },
  { id: 'normal', name: '🗣 Normal', prompt: 'Format for speech. No code blocks...' },
  { id: 'casual', name: '💬 Casual', prompt: 'Conversational tone...' },
  { id: 'very_casual', name: '🎙 Very Casual', prompt: 'Like talking to a friend...' },
  { id: 'bro', name: '🤙 Bro', prompt: 'Super casual, like texting a buddy...' }
]
```

---

## Message Flow Scenarios

### Scenario 1: Interactive Mode, Voice=OFF, Text Message

**Settings:** `interactiveMode=true`, `voiceMode=off`, `textStyle=concise`

```
1. User sends: "explain promises"
   │
2. bot.js on('message') → claudeCommands.handleMessage()
   │
3. handleMessage() checks interactiveMode=true
   │
4. interactiveProc exists?
   │
   ├─ YES: Send to existing process
   │   a. Send "🔄 Processing... (0s)" message with Cancel button
   │   b. Store message_id in userState.interactiveThinkingMsgId
   │   c. Apply textStyle prompt: "[Be concise...]\n\nexplain promises"
   │   d. sendToInteractive() writes JSON to stdin
   │   e. stdout handler receives streaming response
   │   f. Edit message with response text + " ▌" cursor
   │   g. On 'result': Remove cursor, send final text
   │   h. voiceMode=off → No voice generated
   │   i. Send summary: "✅ Done (5s)"
   │
   └─ NO: Start new interactive session
       a. Send "🔄 Starting new session..." message
       b. startInteractiveSession(userState, chatId, bot, null, styledMessage)
       c. Spawn: claude --input-format stream-json --output-format stream-json
       d. Wait for 'init' event from stdout
       e. Send styled message via stdin
       f. Continue from step 4a.e
```

### Scenario 2: Interactive Mode, Voice=AUTO, Voice Style=Bro

**Settings:** `interactiveMode=true`, `voiceMode=auto`, `responseLevel=bro`

```
1. User sends: "what is docker"
   │
2. bot.js → claudeCommands.handleMessage()
   │
3. voiceMode=auto → Apply voice style prompt
   │  Message becomes: "[Super casual, like texting...]\n\nwhat is docker"
   │
4. Send to interactive process (same as Scenario 1)
   │
5. On 'result' event:
   │  a. finalText = "Yo! So Docker is basically..."
   │  b. Send/edit message with finalText
   │  c. voiceMode=auto → Call sendVoiceResponse()
   │     - Detect language (English)
   │     - Check chunk preset (medium)
   │     - If text > 10 lines: use generateVoiceChunked()
   │     - Send progress: "🎙 Processing VM 1/? with Edge TTS..."
   │     - Generate audio chunks progressively
   │     - Send each chunk as voice message: "🔊 1/3", "🔊 2/3", "🔊 3/3"
   │     - Delete progress message
   │  d. Send summary: "✅ Done (12s)"
```

### Scenario 3: Interactive Mode, Voice=ON, Click 🔊 Button

**Settings:** `interactiveMode=true`, `voiceMode=on`, `textStyle=off`

```
1. User sends: "explain git rebase"
   │
2. Process message (textStyle=off → no style prompt applied)
   │
3. Claude responds with technical explanation
   │
4. On 'result':
   │  a. Send final text message
   │  b. voiceMode=on → Store text in pendingLogs: `voice_${chatId}`
   │  c. Send summary with clickable link:
   │     "✅ Done (8s) [[🔊](https://t.me/BotName?start=v)]"
   │
5. User clicks 🔊 link → Opens bot with /start v
   │
6. bot.js: /start v handler triggered
   │  a. Retrieve text from pendingLogs.get(`voice_${chatId}`)
   │  b. Call generateVoiceResponseWithChunking(bot, chatId, text)
   │  c. Clean text (remove code blocks, markdown, emojis)
   │  d. Call sendVoiceResponse() with cleaned text
   │  e. Generate and send voice (with chunking if needed)
```

### Scenario 4: Process Logs (thoughtMode=on)

**Settings:** `thoughtMode=on`, many tools used

**Three separate logs are tracked:**
- `toolsLog` - Detailed tool operations (Read: /path, Bash: cmd)
- `statusLog` - Status messages shown during processing
- `fullLog` - Full JSON stream from Claude

```
1. User sends complex query requiring multiple tools
   │
2. Claude uses tools: Read, Grep, Read, Edit, Bash
   │
3. Each JSON event from Claude:
   │  a. Add to fullLog: { type, subtype, blocks, timestamp }
   │  b. If tool_use: Add to toolsLog ("Read: /path/file.js")
   │  c. Update status & add to statusLog ("Reading file.js")
   │
4. On 'result':
   │  a. Save logs to pendingLogs:
   │     - `tools_${chatId}` → toolsLog
   │     - `status_${chatId}` → statusLog
   │     - `fulllog_${chatId}` → fullLog
   │  b. Send summary: "Done (15s) [🔧5, 📝3, 📋12, 🔊]"
   │
5. User clicks button → /start <type>
   │  - 🔧 → /start tools → Show toolsLog as list
   │  - 📝 → /start status → Show statusLog as list
   │  - 📋 → /start fulllog → Show fullLog formatted
   │  - 🔊 → /start v → Generate voice
```

**Full Log Format:**
```
1. [system:init]

2. [assistant]
   📝 Let me check the files...

3. [assistant]
   🔧 Read: {"file_path":"/path/to/file.js"}

4. [user]
   ✅ result

5. [result:success]
   → Final response text...
```

### Scenario 5: Non-Interactive Mode (Legacy)

**Settings:** `interactiveMode=false`, `sessionMode=true`

```
1. User sends message
   │
2. handleMessage() checks interactiveMode=false
   │
3. Check for existing session (sessionMode=true)
   │  - If exists and same project: resumeSessionId = session.sessionId
   │  - If different project: clear session, start new
   │
4. runClaudeStreaming():
   │  a. Build command: claude -p 'message' --output-format stream-json --resume ID
   │  b. Spawn process
   │  c. Parse JSON lines from stdout
   │  d. Update message every 1.5s with partial text
   │  e. On completion: return { text, sessionId }
   │
5. Save session if sessionMode=true
   │
6. Send final response
```

---

## Callback System

### Callback Flow

```
1. User clicks inline button
   │
2. bot.js: bot.on('callback_query')
   │
3. Try each module's handleCallback():
   │
   ├─ navigationCommands.handleCallback() → proj:*, browse:*
   ├─ gitCommands.handleCallback() → git:*
   ├─ voiceCommands.handleCallback() → voicemode:*, tts:*, voice:*, etc.
   ├─ await claudeCommands.handleCallback() → mode:*, session:*, etc. (ASYNC!)
   └─ parallelCommands.handleCallback() → parallel:*
   │
4. If none handled, check bot.js handlers:
   │
   ├─ qset:* → Quick Settings toggles
   ├─ all:* → Main menu navigation
   ├─ cmd:* → Command shortcuts
   └─ noop → Do nothing (section headers)
```

### Important: Async Callback Handler

`claudeCommands.handleCallback()` is **async** and MUST be awaited:

```javascript
// bot.js line 747 - CORRECT
if (await claudeCommands.handleCallback(bot, query, userState)) return;

// WRONG - would always be truthy (Promise object)
if (claudeCommands.handleCallback(bot, query, userState)) return;
```

### Callback Data Prefixes

| Prefix | Module | Example | Action |
|--------|--------|---------|--------|
| `proj:` | navigation | `proj:home` | Switch to project |
| `browse:` | navigation | `browse:/Users/x` | Navigate to folder |
| `mode:` | claude | `mode:yolo` | Set permission mode |
| `session:` | claude | `session:on` | Toggle session mode |
| `interactive:` | claude | `interactive:cancel` | Toggle/cancel interactive |
| `terminal:` | claude | `terminal:on` | Toggle iTerm display |
| `thought:` | claude | `thought:auto` | Set thought mode |
| `persist:` | claude | `persist:on` | Toggle persistence |
| `resume:` | claude | `resume:abc123` | Resume bot session |
| `cli:` | claude | `cli:abc123` | Resume Mac CLI session |
| `clibrowse:` | claude | `clibrowse:list` | Browse CLI projects |
| `cliproj:` | claude | `cliproj:path:id` | Resume from project |
| `voicemode:` | voice | `voicemode:auto` | Set voice mode |
| `tts:` | voice | `tts:google` | Set TTS engine |
| `voice:en:` | voice | `voice:en:Jenny` | Set English voice |
| `voice:he:` | voice | `voice:he:Hila` | Set Hebrew voice |
| `speed:` | voice | `speed:+50%` | Set voice speed |
| `voicestyle:` | voice | `voicestyle:bro` | Set voice style |
| `textstyle:` | voice | `textstyle:concise` | Set text style |
| `chunk:` | voice | `chunk:large` | Set chunk preset |
| `qset:` | bot.js | `qset:voice:auto` | Quick Settings toggle |
| `all:` | bot.js | `all:claude` | Menu section |
| `cmd:` | various | `cmd:sessions` | Execute command |
| `git:` | git | `git:status` | Git operation |
| `showlog:` | claude | `showlog:log_123` | Show thought log |
| `getvoice:` | claude | `getvoice:voice_123` | Generate voice |

---

## Quick Settings Menu Flow

```
/settings command or ⚙️ Quick Settings button
       │
       ▼
┌─────────────────────────────────────────────────────┐
│ ⚙️ Quick Settings                                   │
│                                                     │
│ Voice: 🔇    [● off] [on] [auto]                   │
│ TxtStyle: 📝  [●] [⚡] [💻] [🚫]                    │
│ VoiceStyle: 🎙 [📝] [💬] [●] [🤙]                   │
│ Thought: 🔇   [● off] [on] [auto]                  │
│ Session: ⚡   [● demand] [session]                  │
│ Mode: 🔥      [🔒] [⚡] [📋] [●]                    │
│ Interactive: 🔄 [off] [● on]                       │
│                                                     │
│ [⬅️ Back to Menu]                                  │
└─────────────────────────────────────────────────────┘
       │
       │ Click any option (e.g., qset:voice:auto)
       ▼
1. Parse: setting=voice, value=auto
2. Update: userState.voiceMode = 'auto'
3. Save: scheduleSave()
4. Answer: bot.answerCallbackQuery("✅ voice: auto")
5. Refresh: sendQuickSettings(bot, chatId, messageId)
   └─ Edits existing message with updated menu
```

---

## Restart Mechanism

### /restart (Normal)

```
1. Send "🔄 Restarting bot..."
   │
2. resetAllUsersRuntime({ keepSessionId: true })
   │  - Kill all interactiveProc
   │  - Clear runtime state
   │  - KEEP interactiveSessionId for auto-resume
   │
3. saveNow() - Persist state to disk
   │
4. Write chatId to restart-notify.txt
   │
5. spawn('node', ['bot.js'], { detached: true })
   │
6. process.exit(0)
   │
7. New process starts:
   │  - Kills old PID if exists
   │  - Loads state from disk
   │  - Reads restart-notify.txt
   │  - Sends "✅ Bot restarted successfully!"
   │
8. Next message from user:
   │  - handleMessage() finds interactiveSessionId
   │  - startInteractiveSession(resumeId=savedId)
   │  - Claude resumes with full history
```

### /restart clean

Same as above but:
- `resetAllUsersRuntime({ keepSessionId: false, clearSessions: true })`
- Clears sessions.json
- No session resume - starts fresh

### /reset

```
1. resetUserRuntime(chatId, { killProc: true, clearSessions: true })
   │  - Kill user's interactiveProc
   │  - Clear runtime state
   │  - Clear sessions
   │
2. Send "🔄 State reset!"
   │
3. NO restart - bot continues running
```

---

## TTS System

### Engine Selection

```javascript
TTS_ENGINES = {
  edge: { name: 'Edge TTS', icon: '☁️', hebrew: true },
  google: { name: 'Google TTS', icon: '🔵', hebrew: true },
  piper: { name: 'Piper', icon: '🏠', hebrew: false },
  coqui: { name: 'Coqui', icon: '🐸', hebrew: false }
}
```

### Voice Generation Flow

```
generateVoice(text, settings)
       │
       ├─ Detect language (Hebrew/English)
       │
       ├─ Select engine from settings.ttsEngine
       │
       └─ Route to engine:
          ├─ edge.js → edge-tts CLI
          ├─ google.js → gtts library
          ├─ piper.js → piper CLI
          └─ coqui.js → coqui-tts CLI
               │
               ▼
          Return { buffer, format: 'mp3'|'wav' }
```

### Chunking Flow

```
generateVoiceChunked(text, settings, onChunk, onProgress)
       │
       ├─ Split text into sentences
       │
       ├─ Group sentences by chunk preset:
       │  small:  [1, 2, 3, 4, 5, 5, 5, ...]
       │  medium: [2, 4, 8, 8, 8, ...]
       │  large:  [2, 4, 8, 12, 12, ...]
       │  xl:     [4, 4, 8, 8, 10, 12, 14, ...]
       │  xxl:    [5, 10, 15, 20, 20, ...]
       │  xxxl:   [10, 20, 40, 40, ...]
       │  none:   [full text]
       │
       └─ For each chunk:
          1. onProgress("🎙 Processing VM 2/5...")
          2. Generate audio
          3. onChunk(buffer, format, 2, 5)
          4. Caller sends as voice message
```

---

## Session Management

### Bot Sessions vs CLI Sessions

| Type | Storage | Created By | Resume Method |
|------|---------|------------|---------------|
| Bot Session | `data/sessions.json` | Telegram bot | `resume:shortId` callback |
| CLI Session | `~/.claude/projects/*/sessions.json` | Mac Claude CLI | `cli:shortId` callback |

### Session Discovery

```javascript
// Bot sessions - per chat ID
getSessionHistory(chatId) → [{ sessionId, projectPath, topic, messageCount }]

// CLI sessions - from ~/.claude/projects/
getCliProjects() → [{ name, decoded, encoded }]
getCliSessions(projectPath, limit) → [{ sessionId, topic, messageCount }]
```

### Resume Flow

```
User clicks "🖥 Topic: fix bug (5💬)"
       │
       ▼
cli:abc123 callback
       │
       ▼
1. Find session by shortId in CLI sessions
2. stopInteractiveSession(userState)
3. userState.sessionMode = true
4. If interactiveMode:
   │  startInteractiveSession(userState, chatId, bot, sessionId)
   │  → claude --resume sessionId
   └─ Send "🖥 Resuming Mac session..."
```

---

## Error Handling

### Process Crashes

```javascript
proc.on('close', (code) => {
  // Clean up state
  userState.interactiveProc = null;
  userState.isProcessing = false;
  // Stop timers
  stopTyping();
  stopTimer();
});

proc.on('error', (err) => {
  bot.sendMessage(chatId, `❌ Failed to start Claude: ${err.message}`);
});
```

### Telegram API Errors

```javascript
// Safe message sending (utils.js)
async function sendMessageSafe(bot, chatId, text) {
  try {
    return await bot.sendMessage(chatId, text);
  } catch (e) {
    console.log('Send error:', e.message);
    return null;
  }
}

async function editMessageSafe(bot, chatId, messageId, text) {
  try {
    return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
  } catch (e) {
    // Ignore "message not modified" errors
    return null;
  }
}
```

### Rate Limiting

```javascript
// Throttle message updates during streaming
if (now - lastUpdate > 500) {  // Only update every 500ms
  lastUpdate = now;
  await editMessageSafe(bot, chatId, messageId, text + ' ▌');
}
```

---

## Deep Links

### Clickable Buttons via Deep Links

Instead of inline buttons (which expire), the bot uses Telegram deep links:

```javascript
// Generate clickable links
const botUsername = (await bot.getMe()).username;
const toolsLink = `[🔧${toolsLog.length}](https://t.me/${botUsername}?start=tools)`;
const statusLink = `[📝${statusLog.length}](https://t.me/${botUsername}?start=status)`;
const fullLogLink = `[📋${fullLog.length}](https://t.me/${botUsername}?start=fulllog)`;
const voiceLink = `[🔊](https://t.me/${botUsername}?start=v)`;

// Send as Markdown
bot.sendMessage(chatId, `Done (5s) [${toolsLink}, ${statusLink}, ${fullLogLink}, ${voiceLink}]`, { parse_mode: 'Markdown' });
```

### Available Deep Link Commands

| Command | Description | Data Source |
|---------|-------------|-------------|
| `/start tools` | Show tools log | `pendingLogs.get('tools_${chatId}')` |
| `/start status` | Show status log | `pendingLogs.get('status_${chatId}')` |
| `/start fulllog` | Show full process log | `pendingLogs.get('fulllog_${chatId}')` |
| `/start v` | Generate voice | `pendingLogs.get('voice_${chatId}')` |
| `/start t` | Alias for status | Same as `/start status` |

### Handler

```javascript
// lib/commands/claude.js
bot.onText(/\/start (t|v|tools|status|fulllog)$/, async (msg, match) => {
  const cmd = match[1];
  if (cmd === 't' || cmd === 'status') {
    // Show status log
  } else if (cmd === 'tools') {
    // Show tools log
  } else if (cmd === 'fulllog') {
    // Show full process log (formatted)
  } else if (cmd === 'v') {
    // Generate voice
  }
});
```

---

## Data Files

| File | Purpose | Format |
|------|---------|--------|
| `data/user-state.json` | User settings | `{ users: { chatId: {...} }, savedAt }` |
| `data/sessions.json` | Bot session history | `{ chatId: [...sessions] }` |
| `data/projects.json` | Custom projects | `{ name: path }` |
| `data/bot.pid` | Current process ID | Plain text |
| `data/restart-notify.txt` | Chat to notify on restart | Plain text |
| `data/images/` | Uploaded photos | JPG files |
| `bot.log` | Application logs | Text log |
| `.env` | Secrets | `BOT_TOKEN=...\nALLOWED_USER_IDS=...` |

---

## Logging

All significant events are logged to `bot.log`:

```
==================================================
📨 [14:32:15] STREAMING REQUEST
   Project: my-project
   Path: /Users/x/my-project
==================================================
   PID: 12345
   Resuming session: abc123...
   [stdout] 1024 bytes
   [tool] Read
   [tool] Bash
✅ [14:32:28] STREAM COMPLETED in 13.2s
   Session ID: abc123...
```

Commands to view:
- `/logs` - Last 50 lines
- `/logs 100` - Last 100 lines
- `/logfile` - Download full log
- `/clearlogs` - Clear log file

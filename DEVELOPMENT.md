# Development Guide - Claude Telegram Bot

How to add new features, commands, and settings.

---

## Quick Reference

### Adding a New Command

1. **Choose the right module** based on functionality:
   - `lib/commands/claude.js` - Claude interaction, sessions
   - `lib/commands/voice.js` - TTS, voice settings
   - `lib/commands/navigation.js` - Projects, folders
   - `lib/commands/git.js` - Git operations
   - `lib/commands/parallel.js` - Multi-agent operations

2. **Add the command handler** in the module's `register()` function

3. **Add callback handler** if the command has buttons

4. **Update menus** in `bot.js` if needed

---

## Step-by-Step: Adding a New Command

### Example: Adding `/mycommand`

#### Step 1: Add to Command Module

```javascript
// lib/commands/yourmodule.js

function register(bot, isAuthorized) {

  // Simple command
  bot.onText(/\/mycommand/, (msg) => {
    if (!isAuthorized(msg)) return;
    bot.sendMessage(msg.chat.id, '✅ My command executed!');
  });

  // Command with argument
  bot.onText(/\/mycommand(?:\s+(.+))?/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const arg = match[1] || 'default';
    bot.sendMessage(msg.chat.id, `Argument: ${arg}`);
  });

  // Command with inline buttons
  bot.onText(/\/mycommand/, (msg) => {
    if (!isAuthorized(msg)) return;

    const keyboard = [
      [{ text: 'Option A', callback_data: 'mycmd:optionA' }],
      [{ text: 'Option B', callback_data: 'mycmd:optionB' }]
    ];

    bot.sendMessage(msg.chat.id, 'Choose an option:', {
      reply_markup: { inline_keyboard: keyboard }
    });
  });
}
```

#### Step 2: Add Callback Handler

```javascript
// lib/commands/yourmodule.js

function handleCallback(bot, query, userState) {
  const data = query.data;
  const chatId = query.message.chat.id;

  // Handle your prefix
  if (data.startsWith('mycmd:')) {
    const option = data.substring(6); // Remove 'mycmd:' prefix

    // Process the option
    if (option === 'optionA') {
      bot.answerCallbackQuery(query.id, { text: '✅ Option A selected' });
      bot.sendMessage(chatId, 'You chose Option A');
    } else if (option === 'optionB') {
      bot.answerCallbackQuery(query.id, { text: '✅ Option B selected' });
      bot.sendMessage(chatId, 'You chose Option B');
    }

    return true; // Callback was handled
  }

  return false; // Not our callback
}

module.exports = { register, handleCallback };
```

#### Step 3: Wire Up in bot.js (if new module)

```javascript
// bot.js

// Import
const myCommands = require('./lib/commands/mymodule');

// Register commands
myCommands.register(bot, isAuthorized);

// Add to callback handler chain
bot.on('callback_query', async (query) => {
  // ... existing handlers ...
  if (myCommands.handleCallback(bot, query, userState)) return;
});
```

---

## Adding a New Setting

### Example: Adding `myFeature` toggle

#### Step 1: Define Default in state.js

```javascript
// lib/state.js

function createDefaultState(chatId) {
  return {
    // ... existing fields ...
    myFeature: false,  // Add your setting with default value
  };
}
```

#### Step 2: Add Command to Toggle

```javascript
// lib/commands/yourmodule.js

bot.onText(/\/myfeature(?:\s+(on|off))?/, (msg, match) => {
  if (!isAuthorized(msg)) return;

  const userState = getUserState(msg.chat.id);
  const arg = match[1]?.toLowerCase();

  if (arg === 'on') {
    userState.myFeature = true;
    scheduleSave();  // Persist to disk
    bot.sendMessage(msg.chat.id, '✅ MyFeature enabled');
    return;
  }

  if (arg === 'off') {
    userState.myFeature = false;
    scheduleSave();
    bot.sendMessage(msg.chat.id, '❌ MyFeature disabled');
    return;
  }

  // Show menu with current status
  const icon = userState.myFeature ? '✅' : '❌';
  const keyboard = [[
    { text: userState.myFeature ? '❌ Turn OFF' : '✅ Turn ON',
      callback_data: userState.myFeature ? 'myfeature:off' : 'myfeature:on' }
  ]];

  bot.sendMessage(msg.chat.id, `🔧 *MyFeature*\n\nCurrent: ${icon}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
});
```

#### Step 3: Add to Quick Settings (optional)

```javascript
// bot.js - sendQuickSettings()

const myFeature = userState.myFeature ? 'on' : 'off';
const myFeatureIcon = userState.myFeature ? '✅' : '❌';

// Add row to keyboard
[
  { text: `MyFeature: ${myFeatureIcon}`, callback_data: 'cmd:myfeature' },
  { text: myFeature === 'off' ? '● off' : 'off', callback_data: 'qset:myfeature:off' },
  { text: myFeature === 'on' ? '● on' : 'on', callback_data: 'qset:myfeature:on' }
]

// Handle in qset: section
if (setting === 'myfeature') {
  userState.myFeature = value === 'on';
  scheduleSave();
}
```

---

## Adding a New TTS Engine

### Step 1: Create Engine File

```javascript
// lib/tts/myengine.js

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function generate(text, settings) {
  const tempFile = path.join(os.tmpdir(), `myengine_${Date.now()}.mp3`);

  return new Promise((resolve, reject) => {
    // Call your TTS CLI or API
    const proc = spawn('my-tts-cli', [
      '--text', text,
      '--output', tempFile,
      '--voice', settings.voice
    ]);

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('TTS failed'));
        return;
      }

      const buffer = fs.readFileSync(tempFile);
      fs.unlinkSync(tempFile);  // Cleanup

      resolve({
        buffer,
        format: 'mp3'  // or 'wav'
      });
    });

    proc.on('error', reject);
  });
}

module.exports = { generate };
```

### Step 2: Register in Config

```javascript
// lib/config.js

const TTS_ENGINES = {
  // ... existing engines ...
  myengine: {
    name: 'My Engine',
    icon: '🎵',
    description: 'My custom TTS engine',
    hebrew: false  // true if supports Hebrew
  }
};
```

### Step 3: Add to Router

```javascript
// lib/tts/index.js

const myengine = require('./myengine');

async function generateVoice(text, settings) {
  const engine = settings.ttsEngine || 'edge';

  switch (engine) {
    // ... existing cases ...
    case 'myengine':
      return myengine.generate(text, settings);
  }
}
```

---

## Adding a New Voice/Text Style

### Add to Config

```javascript
// lib/config.js

// For voice auto mode
const VOICE_STYLE_OPTIONS = [
  // ... existing options ...
  {
    id: 'mystyle',
    name: '🎭 My Style',
    prompt: 'Respond in my custom style. Be creative and unique. No code blocks.'
  }
];

// For text mode (off/on)
const TEXT_STYLE_OPTIONS = [
  // ... existing options ...
  {
    id: 'mytextstyle',
    name: '📝 My Text Style',
    prompt: 'Format your response in my custom way...'
  }
];
```

The style prompt is automatically prepended to user messages in `handleMessage()`.

---

## Adding Menu Sections

### Add to Main Menu

```javascript
// bot.js - sendAllMenu()

const keyboard = [
  // ... existing rows ...
  [{ text: '🆕 My Section', callback_data: 'all:mysection' }]
];
```

### Handle Menu Section

```javascript
// bot.js - handleAllMenuCallback()

if (section === 'mysection') {
  bot.answerCallbackQuery(query.id, { text: '🆕 My Section' });

  const keyboard = [
    [{ text: '🔧 Option 1', callback_data: 'cmd:myoption1' }],
    [{ text: '🔧 Option 2', callback_data: 'cmd:myoption2' }],
    [{ text: '⬅️ Back', callback_data: 'all:back' }]
  ];

  bot.editMessageText('🆕 *My Section*\n\nSelect an option:', {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
  return;
}
```

---

## Common Patterns

### Async Callback Handler

If your callback handler is async (uses `await`), it MUST be awaited in bot.js:

```javascript
// In your module
async function handleCallback(bot, query, userState) {
  // async operations...
  await someAsyncOperation();
  return true;
}

// In bot.js - MUST use await
if (await myCommands.handleCallback(bot, query, userState)) return;
```

### Persisting State

Always call `scheduleSave()` after changing user state:

```javascript
const { getUserState, scheduleSave } = require('../state');

// Change state
userState.myFeature = true;

// Schedule save (batched, not immediate)
scheduleSave();
```

### Safe Message Operations

Use safe wrappers to handle Telegram API errors:

```javascript
const { sendMessageSafe, editMessageSafe } = require('../utils');

// Won't throw on error
await sendMessageSafe(bot, chatId, 'Hello');
await editMessageSafe(bot, chatId, messageId, 'Updated');
```

### Streaming Updates with Throttle

```javascript
let lastUpdate = 0;

function onTextUpdate(text) {
  const now = Date.now();
  if (now - lastUpdate > 500) {  // Max every 500ms
    lastUpdate = now;
    editMessageSafe(bot, chatId, msgId, text + ' ▌');
  }
}
```

### Deep Links for Persistent Buttons

Instead of inline buttons (which can expire), use deep links:

```javascript
const botUsername = (await bot.getMe()).username;
const link = `https://t.me/${botUsername}?start=myaction`;
const markdown = `[Click me](${link})`;

bot.sendMessage(chatId, markdown, { parse_mode: 'Markdown' });

// Handle in /start
bot.onText(/\/start myaction$/, (msg) => {
  // Handle the action
});
```

---

## Testing

### Manual Testing Checklist

1. **Command works:** `/mycommand` executes
2. **Arguments work:** `/mycommand arg` parses correctly
3. **Buttons work:** Clicking buttons triggers callbacks
4. **State persists:** Setting survives `/restart`
5. **Errors handled:** Invalid input doesn't crash bot

### Log Watching

```bash
# Watch logs in real-time
tail -f ~/.claude/telegram-bot/bot.log

# Search for specific events
grep "mycommand" bot.log
```

### Quick Restart

```bash
# From Telegram
/restart

# From terminal
cd ~/.claude/telegram-bot && ./start.sh
```

---

## File Structure for New Feature

```
lib/
├── commands/
│   └── myfeature.js      # Command handlers + callbacks
├── myfeature/            # Complex feature with multiple files
│   ├── index.js          # Main logic
│   ├── utils.js          # Helpers
│   └── config.js         # Feature-specific config
└── config.js             # Add constants here

bot.js                     # Wire up new module
```

---

## Checklist for New Feature

- [ ] Command handler in appropriate module
- [ ] Callback handler if using buttons
- [ ] Default value in `createDefaultState()` if new setting
- [ ] `scheduleSave()` after state changes
- [ ] Menu integration if user-facing
- [ ] Quick Settings row if frequently toggled
- [ ] Update README.md with new command
- [ ] Update ARCHITECTURE.md if complex flow
- [ ] Test with `/restart` to verify persistence

---

## Debugging Tips

### Check User State

```javascript
// Add temporary debug command
bot.onText(/\/debug/, (msg) => {
  const userState = getUserState(msg.chat.id);
  bot.sendMessage(msg.chat.id, '```\n' + JSON.stringify(userState, null, 2) + '\n```', {
    parse_mode: 'Markdown'
  });
});
```

### Log Important Events

```javascript
console.log(`[MyFeature] Action: ${action}, User: ${chatId}, Value: ${value}`);
```

### Check Callback Data

```javascript
bot.on('callback_query', (query) => {
  console.log(`[Callback] Data: ${query.data}, From: ${query.from.id}`);
  // ... rest of handler
});
```

---

## API Reference

### State Functions (`lib/state.js`)

| Function | Purpose |
|----------|---------|
| `getUserState(chatId)` | Get/create user state |
| `scheduleSave()` | Queue state save to disk |
| `saveNow()` | Immediate save |
| `getAllUserStates()` | Get all users' states |
| `resetUserRuntime(chatId, opts)` | Reset runtime fields |
| `resetAllUsersRuntime(opts)` | Reset all users |

### Session Functions (`lib/sessions.js`)

| Function | Purpose |
|----------|---------|
| `getSession(chatId)` | Get active session |
| `setSession(chatId, id, path, topic)` | Save session |
| `clearSession(chatId)` | Remove active session |
| `getSessionHistory(chatId)` | Past sessions list |
| `getCliSessions(path, limit)` | Mac CLI sessions |
| `getCliProjects()` | All CLI project paths |

### Utility Functions (`lib/utils.js`)

| Function | Purpose |
|----------|---------|
| `sendLongMessage(bot, chatId, text)` | Split long messages |
| `sendMessageSafe(bot, chatId, text)` | Error-safe send |
| `editMessageSafe(bot, chatId, msgId, text)` | Error-safe edit |
| `getModeFlag(mode)` | Get CLI flag for mode |
| `formatForTelegram(text)` | Escape markdown |
| `runQuickCommand(cmd, cwd)` | Execute shell command |

### TTS Functions (`lib/tts/index.js`)

| Function | Purpose |
|----------|---------|
| `generateVoice(text, settings)` | Single audio file |
| `generateVoiceChunked(text, settings, onChunk, onProgress)` | Progressive chunks |

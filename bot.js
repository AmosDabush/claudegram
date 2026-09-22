#!/usr/bin/env node
/**
 * Claude Telegram Bot - Main Entry Point
 * Refactored modular version with persistence
 */

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// Load modules
const { FILES, TTS_ENGINES, VOICE_CHUNK_PRESETS } = require('./lib/config');
const { getUserState, getAllUserStates, saveNow, getProjects, setSessionsModule, restoreActiveSessions, resetUserRuntime, resetAllUsersRuntime } = require('./lib/state');
const { cleanupTempFiles, runQuickCommand, isGitRepo } = require('./lib/utils');
const sessions = require('./lib/sessions');

// Connect sessions module to state for persistence
setSessionsModule(sessions);

// Load command modules
const navigationCommands = require('./lib/commands/navigation');
const gitCommands = require('./lib/commands/git');
const voiceCommands = require('./lib/commands/voice');
const claudeCommands = require('./lib/commands/claude');
const parallelCommands = require('./lib/commands/parallel');
const bookmarkCommands = require('./lib/commands/bookmark');
const helpCommands = require('./lib/commands/help');
const askCommands = require('./lib/commands/ask');
const attachCommands = require('./lib/commands/attach');

// ===== Kill previous instance if exists =====
const { execSync } = require('child_process');
try {
  if (fs.existsSync(FILES.pid)) {
    const oldPid = fs.readFileSync(FILES.pid, 'utf-8').trim();
    if (oldPid && oldPid !== process.pid.toString()) {
      try {
        execSync(`kill ${oldPid} 2>/dev/null`);
        console.log(`Killed previous instance (PID: ${oldPid})`);
      } catch (e) {}
    }
  }
  // Also kill any other bot.js processes
  const otherPids = execSync(`pgrep -f "node.*bot.js" 2>/dev/null || true`).toString().trim().split('\n').filter(p => p && p !== process.pid.toString());
  for (const pid of otherPids) {
    try {
      execSync(`kill ${pid} 2>/dev/null`);
      console.log(`Killed orphan instance (PID: ${pid})`);
    } catch (e) {}
  }
} catch (e) {}

// Write current PID
fs.writeFileSync(FILES.pid, process.pid.toString());
console.log(`Bot PID: ${process.pid}`);

// Cleanup on exit
process.on('exit', () => {
  try { fs.unlinkSync(FILES.pid); } catch (e) {}

  // Stop all interactive sessions
  const allStates = getAllUserStates();
  for (const [chatId, userState] of allStates) {
    if (userState.interactiveProc) {
      try { userState.interactiveProc.kill(); } catch (e) {}
    }
  }

  saveNow();
});
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());

// ===== Load .env file =====
if (fs.existsSync(FILES.env)) {
  const envContent = fs.readFileSync(FILES.env, 'utf-8');
  envContent.split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && vals.length) process.env[key.trim()] = vals.join('=').trim();
  });
}

// ===== Configuration =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || '').split(',').map(id => parseInt(id.trim())).filter(Boolean);

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN not found! Create .env file with BOT_TOKEN=your-token');
  process.exit(1);
}

if (ALLOWED_USER_IDS.length === 0) {
  console.error('❌ ALLOWED_USER_IDS not found! Add ALLOWED_USER_IDS=123,456 to .env');
  process.exit(1);
}

// ===== Initialize bot =====
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    autoStart: true,
    params: { timeout: 30 }
  }
});

// ===== Polling error recovery =====
bot.on('polling_error', (err) => {
  const msg = err.message || '';
  // Network errors (Mac sleep, WiFi drop) - just log briefly, bot will retry
  if (msg.includes('ENOTFOUND') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('socket hang up')) {
    console.log(`[Polling] Network error: ${msg.split(':').pop().trim()}`);
    return;
  }
  // Telegram server errors (502, 429) - transient
  if (msg.includes('502') || msg.includes('429')) {
    console.log(`[Polling] Telegram server error: ${msg.split(':').pop().trim()}`);
    return;
  }
  // Unknown polling errors - log full message
  console.log(`[Polling] Error: ${msg}`);
});

// ===== Catch unhandled rejections to prevent crashes =====
process.on('unhandledRejection', (err) => {
  const msg = (err && err.message) || String(err);
  // Known harmless Telegram API errors
  if (msg.includes('message is not modified') ||
      msg.includes('query is too old') ||
      msg.includes("can't parse entities") ||
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('ENOTFOUND')) {
    console.log(`[Unhandled] ${msg.substring(0, 120)}`);
    return;
  }
  console.error(`[Unhandled Rejection] ${msg}`);
  if (err && err.stack) console.error(err.stack);
});

// Set bot commands menu
bot.setMyCommands([
  { command: 'menu', description: '📱 Main menu (all categories)' },
  { command: 'settings', description: '⚙️ Quick settings' },
  { command: 'claude', description: '🤖 Claude session & settings' },
  { command: 'model', description: '🧠 Switch Claude model' },
  { command: 'sessions', description: '📚 Browse & resume sessions' },
  { command: 'askhistory', description: '✦ Ask your own session history' },
  { command: 'projects', description: '📂 Saved projects' },
  { command: 'browse', description: '🗂 Browse folders' },
  { command: 'git', description: '🌿 Git commands' },
  { command: 'voice', description: '🔊 Voice settings' },
  { command: 'help', description: '📖 Help topics & knowledge base' },
  { command: 'all', description: '📋 List all commands' },
  { command: 'restart', description: '🔄 Restart bot' },
  { command: 'close', description: '👋 Close bot (all instances)' },
  { command: 'cancel', description: '🛑 Cancel current request' },
  { command: 'resume_pinned', description: '📌 Resume pinned session' },
  { command: 'forceresume', description: '🔓 Take over a session open elsewhere' },
  { command: 'move_to_mac', description: '🖥 Move to Mac terminal' },
  { command: 'bookmark', description: '🔖 Bookmark (save)' },
  { command: 'bookmarks', description: '🔖 Bookmarks (show all)' },
  { command: 'pin', description: '📌 Pin current session' },
  { command: 'anydesk', description: '🕹 AnyDesk' },
  { command: 'waker', description: '⏰ Bot waker (status / set minutes)' },
  { command: 'pipe', description: '🔀 Pipe: live-attach vs resume' },
  { command: 'attach', description: '🔗 Attach to a live session' },
  { command: 'detach', description: '⏹ Detach (back to resume)' }
]).then(() => {
  console.log('✅ Bot commands menu set');
}).catch(err => {
  console.log('⚠️ Could not set commands menu:', err.message);
});

console.log('🤖 Claude Telegram Bot started!');
console.log(`📁 Data directory: ${path.dirname(FILES.sessions)}`);

// Heartbeat — lets the independent caretaker tell "stuck" from "alive".
// If the event loop ever wedges, this stops updating and the caretaker notices.
const HEARTBEAT_FILE = path.join(path.dirname(FILES.sessions), 'heartbeat');
const writeHeartbeat = () => { try { fs.writeFileSync(HEARTBEAT_FILE, Date.now().toString()); } catch (e) {} };
writeHeartbeat();
setInterval(writeHeartbeat, 30000);

// Cleanup old temp files on startup
cleanupTempFiles();

// Sync CLI sessions to unified registry on startup
try { require('./scripts/watch-cli-sessions'); } catch (e) { console.log('⚠️ CLI session sync skipped:', e.message); }

// Restore active sessions for users with persistSession enabled
restoreActiveSessions();

// Send restart notification if pending
if (fs.existsSync(FILES.restartNotify)) {
  try {
    const chatId = fs.readFileSync(FILES.restartNotify, 'utf-8').trim();
    fs.unlinkSync(FILES.restartNotify);
    if (chatId) {
      bot.sendMessage(chatId, '✅ Bot restarted successfully!');
      console.log(`📨 Sent restart notification to chat ${chatId}`);
    }
  } catch (e) {
    console.log('⚠️ Could not send restart notification:', e.message);
  }
}

// ===== Security check =====
function isAuthorized(msg) {
  if (!ALLOWED_USER_IDS.includes(msg.from.id)) {
    bot.sendMessage(msg.chat.id, '⛔ Unauthorized');
    console.log(`Unauthorized access attempt from user ${msg.from.id}`);
    return false;
  }
  return true;
}

// ===== Register commands =====
navigationCommands.register(bot, isAuthorized);
gitCommands.register(bot, isAuthorized);
voiceCommands.register(bot, isAuthorized);
claudeCommands.register(bot, isAuthorized);
parallelCommands.register(bot, isAuthorized);
bookmarkCommands.register(bot, isAuthorized);
askCommands.register(bot, isAuthorized);
helpCommands.register(bot, isAuthorized);
attachCommands.register(bot, isAuthorized);
attachCommands.setRenderers({
  menu:   (b, c, m) => sendAllMenu(b, c, m),
  claude: (b, c, m) => sendClaudeSessionPanel(b, c, m)
});

// ===== Help commands =====
bot.onText(/\/start$/, (msg) => {  // Only match /start without parameters
  if (!isAuthorized(msg)) return;

  const userState = getUserState(msg.chat.id);
  const help = `
🤖 *Claude Code Bot*

*Navigation:*
/projects - Saved projects
/browse - Browse folders
/pwd - Current directory + mode

*Quick Commands:*
/ls, /tree, /files - Folder info
/repo, /status - Git info

*Claude:*
Just type → Send to Claude
-r msg → Quick resume
/sessions → Pick past session
/session → Toggle mode (⚡/💬)

⚡ On-demand = each message independent
💬 Session = Claude remembers context

Current: *${userState.currentProject}*
  `;

  bot.sendMessage(msg.chat.id, help, { parse_mode: 'Markdown' });
});

// ===== /all - List all commands =====
bot.onText(/\/all/, (msg) => {
  if (!isAuthorized(msg)) return;

  const userState = getUserState(msg.chat.id);

  const allCommands = `📋 *All Commands*

*📂 Navigation:*
/projects - Saved projects
/browse - Browse folders
/pwd - Current path
/cd <path> - Change directory
/add <name> <path> - Add project

*📋 Files:*
/ls - List files
/tree - Folder structure
/files - Find files

*🌿 Git:*
/git - Git menu
/status /gs - Git status
/branch - Current branch
/branches - All branches
/repo - Repo info

*🤖 Claude AI:*
Just type → Send to Claude
/sessions - Past sessions
/session - Toggle mode (⚡/💬)
/persist - Keep session after restart
/new - Fresh session
/mode - Permission mode
/thought - Thought process log
/cancel - Stop request
/fast <q> - Quick answer

*🔄 Interactive:*
/interactive - Toggle interactive mode
/terminal - iTerm/background display
/resume - Resume last session

*🔗 Live Session Pipe:*
/pipe - switch ATTACH ↔ RESUME
/attach - pick a live session to drive
/detach - stop driving, back to resume
_From the terminal:_ /remote-telegram-current-session · /remote-telegram-all

*🔀 Parallel:*
/perspectives [n] <q> - Get n viewpoints
/investigate <problem> - Parallel branches

*🎙 Voice:*
/voice - Toggle voice
/tts - TTS engine
/setvoice - Voice settings
/setvoicespeed - Speed
/voiceresponse - Style
/voicechunk - Chunk size

*📜 Logs:*
/logs - Last 50 lines
/logfile - Download log
/clearlogs - Clear log

*⚙️ Other:*
/help - Help
/menu - Interactive menu
/restart - Restart bot

📍 *${userState.currentProject}*`;

  bot.sendMessage(msg.chat.id, allCommands, { parse_mode: 'Markdown' });
});

// ===== /menu - Interactive menu =====
bot.onText(/\/menu/, (msg) => {
  if (!isAuthorized(msg)) return;
  sendAllMenu(bot, msg.chat.id);
});

// ===== /settings - Quick settings menu =====
bot.onText(/\/settings/, (msg) => {
  if (!isAuthorized(msg)) return;
  sendQuickSettings(bot, msg.chat.id);
});

// /stream [off|on|live] - how much of the answer you watch being written
bot.onText(/^\/stream(?:\s+(off|on|live))?$/, (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const userState = getUserState(chatId);
  const value = match[1];
  if (!value) {
    const current = userState.streamMode || 'on';
    bot.sendMessage(chatId,
      `⌨️ Stream: *${current}*\n\n` +
      `\`/stream on\` — type the answer out as it is written\n` +
      `\`/stream live\` — also type out the thinking\n` +
      `\`/stream off\` — wait for the finished answer`,
      { parse_mode: 'Markdown' });
    return;
  }
  userState.streamMode = value;
  require('./lib/state').scheduleSave();
  bot.sendMessage(chatId, `⌨️ Stream: *${value}*`, { parse_mode: 'Markdown' });
});

function sendQuickSettings(bot, chatId, messageId = null) {
  const userState = getUserState(chatId);

  // Current values
  const voiceMode = userState.voiceMode || 'off';
  const thoughtMode = userState.thoughtMode || 'off';
  const streamMode = userState.streamMode || 'on';
  const sessionMode = userState.sessionMode ? 'session' : 'demand';
  const permMode = userState.currentMode || 'default';
  const interactive = userState.interactiveMode ? 'on' : 'off';
  const textStyle = userState.voiceSettings?.textStyle || 'off';
  const voiceStyle = userState.voiceSettings?.responseLevel || 'off';

  // Icons for current state
  const voiceIcons = { off: '🔇', on: '🔊', auto: '🔊' };
  const thoughtIcons = { off: '🔇', on: '🧠', auto: '✨' };
  const streamIcons = { off: '🔇', on: '⌨️', live: '🧠' };
  const sessionIcons = { demand: '⚡', session: '💬' };
  const permIcons = { default: '🔒', fast: '⚡', plan: '📋', yolo: '🔥' };
  const interactiveIcons = { off: '⚡', on: '🔄' };
  const textStyleIcons = { off: '📝', concise: '⚡', detailed: '📚', code_only: '💻', no_emoji: '🚫' };
  const voiceStyleIcons = { off: '📝', normal: '🗣', casual: '💬', very_casual: '🎙', bro: '🤙' };

  const keyboard = [
    // Voice row
    [
      { text: `Voice: ${voiceIcons[voiceMode]}`, callback_data: 'cmd:voice' },
      { text: voiceMode === 'off' ? '● off' : 'off', callback_data: 'qset:voice:off' },
      { text: voiceMode === 'on' ? '● on' : 'on', callback_data: 'qset:voice:on' },
      { text: voiceMode === 'auto' ? '● auto' : 'auto', callback_data: 'qset:voice:auto' }
    ],
    // Text Style row (shown when voice is off/on)
    [
      { text: `TxtStyle: ${textStyleIcons[textStyle] || '📝'}`, callback_data: 'cmd:textstyle' },
      { text: textStyle === 'off' ? '●' : '📝', callback_data: 'qset:txtstyle:off' },
      { text: textStyle === 'concise' ? '●' : '⚡', callback_data: 'qset:txtstyle:concise' },
      { text: textStyle === 'code_only' ? '●' : '💻', callback_data: 'qset:txtstyle:code_only' },
      { text: textStyle === 'no_emoji' ? '●' : '🚫', callback_data: 'qset:txtstyle:no_emoji' }
    ],
    // Voice Style row (shown when voice is auto)
    [
      { text: `VoiceStyle: ${voiceStyleIcons[voiceStyle] || '📝'}`, callback_data: 'cmd:voicestyle' },
      { text: voiceStyle === 'off' ? '●' : '📝', callback_data: 'qset:vocstyle:off' },
      { text: voiceStyle === 'casual' ? '●' : '💬', callback_data: 'qset:vocstyle:casual' },
      { text: voiceStyle === 'very_casual' ? '●' : '🎙', callback_data: 'qset:vocstyle:very_casual' },
      { text: voiceStyle === 'bro' ? '●' : '🤙', callback_data: 'qset:vocstyle:bro' }
    ],
    // Thought row
    [
      { text: `Thought: ${thoughtIcons[thoughtMode]}`, callback_data: 'cmd:thought' },
      { text: thoughtMode === 'off' ? '● off' : 'off', callback_data: 'qset:thought:off' },
      { text: thoughtMode === 'on' ? '● on' : 'on', callback_data: 'qset:thought:on' },
      { text: thoughtMode === 'auto' ? '● auto' : 'auto', callback_data: 'qset:thought:auto' }
    ],
    // Stream row - type the answer out as it is written
    [
      { text: `Stream: ${streamIcons[streamMode] || '⌨️'}`, callback_data: `qset:stream:${streamMode}` },
      { text: streamMode === 'off' ? '● off' : 'off', callback_data: 'qset:stream:off' },
      { text: streamMode === 'on' ? '● on' : 'on', callback_data: 'qset:stream:on' },
      { text: streamMode === 'live' ? '● live' : 'live', callback_data: 'qset:stream:live' }
    ],
    // Session row
    [
      { text: `Session: ${sessionIcons[sessionMode]}`, callback_data: 'cmd:session' },
      { text: sessionMode === 'demand' ? '● demand' : 'demand', callback_data: 'qset:session:demand' },
      { text: sessionMode === 'session' ? '● session' : 'session', callback_data: 'qset:session:session' }
    ],
    // Permission row
    [
      { text: `Mode: ${permIcons[permMode]}`, callback_data: 'cmd:mode' },
      { text: permMode === 'default' ? '●' : '🔒', callback_data: 'qset:perm:default' },
      { text: permMode === 'fast' ? '●' : '⚡', callback_data: 'qset:perm:fast' },
      { text: permMode === 'plan' ? '●' : '📋', callback_data: 'qset:perm:plan' },
      { text: permMode === 'yolo' ? '●' : '🔥', callback_data: 'qset:perm:yolo' }
    ],
    // Interactive row
    [
      { text: `Interactive: ${interactiveIcons[interactive]}`, callback_data: 'cmd:interactive' },
      { text: interactive === 'off' ? '● off' : 'off', callback_data: 'qset:interactive:off' },
      { text: interactive === 'on' ? '● on' : 'on', callback_data: 'qset:interactive:on' }
    ],
    // Back button
    [{ text: '⬅️ Back to Menu', callback_data: 'all:back' }]
  ];

  const text = `⚙️ *Quick Settings*\n\n📍 ${userState.currentProject}`;

  if (messageId) {
    return bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  } else {
    return bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  }
}

function sendAllMenu(bot, chatId, messageId = null) {
  const userState = getUserState(chatId);
  const modeIcon = userState.sessionMode ? '💬' : '⚡';
  const voiceIcon = userState.voiceEnabled ? '🔊' : '🔇';
  const interactiveIcon = userState.interactiveMode ? '🔄' : '⚡';

  const keyboard = [
    attachCommands.toggleRow('menu'),
    [{ text: '✦ Ask History', callback_data: 'askhist:ask' }],
    [{ text: '🔗 Remote Ses', callback_data: 'all:remote' }, { text: '⚙️ Quick Settings', callback_data: 'all:settings' }],
    [{ text: '🤖 Claude AI', callback_data: 'all:claude' }, { text: '🔄 Interactive', callback_data: 'all:interactive' }],
    [{ text: '📂 Navigation', callback_data: 'all:nav' }, { text: '📋 Quick Commands', callback_data: 'all:files' }],
    [{ text: '🌿 Git', callback_data: 'all:git' }, { text: '🔀 Parallel', callback_data: 'all:parallel' }],
    [{ text: '🎙 Voice', callback_data: 'all:voice' }, { text: '📜 Logs', callback_data: 'all:logs' }],
    [{ text: '🛑 Cancel Request', callback_data: 'cmd:cancel' }]
  ];

  const pipe = attachCommands.getMode() === 'attach' ? '🔗 Remote Ses' : '📚 Resume Sessions';
  const text = `🤖 *Claude Code Bot*\n\n` +
    `📍 *${userState.currentProject}*\n` +
    `${modeIcon} ${userState.sessionMode ? 'Session' : 'On-Demand'} | ${voiceIcon}\n` +
    `Messages go to: *${pipe}*\n\n` +
    `Select a category:`;

  if (messageId) {
    return bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  } else {
    return bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  }
}

// ===== Claude Session Menu =====
// The Claude session panel, as a function so the pipe toggle can redraw it.
function sendClaudeSessionPanel(bot, chatId, messageId = null) {
  const userState = getUserState(chatId);
  const sessionIcon = userState.sessionMode ? '💬' : '⚡';
  const interactiveStatus = userState.interactiveMode ? 'ON' : 'OFF';
  const terminalStatus = userState.showTerminal ? 'iTerm' : 'Background';
  const procStatus = userState.interactiveProc ? '*(running)*' : '*(stopped)*';
  const thoughtIcon = userState.showProcessLog ? '🧠' : '🔇';

  const keyboard = [
    attachCommands.toggleRow('claude'),
    [
      { text: `🔄 Interactive: ${interactiveStatus}`, callback_data: 'cmd:interactive' },
      { text: `🖥 ${userState.showTerminal ? 'iTerm' : 'BG'}`, callback_data: 'cmd:terminal' }
    ],
    [{ text: '🔗 Remote Ses', callback_data: 'all:remote' }],
    [{ text: '▶️ Resume Last Session', callback_data: 'cmd:resume' }],
    [{ text: '📚 Past Sessions', callback_data: 'cmd:sessions' }],
    [{ text: '✦ Ask History', callback_data: 'askhist:ask' }],
    [{ text: '🆕 New Session', callback_data: 'cmd:new' }],
    [{ text: `${sessionIcon} Toggle Mode`, callback_data: 'cmd:session' }, { text: '⚙️ Permission', callback_data: 'cmd:mode' }],
    [{ text: `${thoughtIcon} Thought Log`, callback_data: 'cmd:thought' }, { text: '💾 Persist', callback_data: 'cmd:persist' }],
    [{ text: '🛠 Telegram Project', callback_data: 'cmd:tgproject' }],
    [{ text: '🖥 Move to Mac', callback_data: 'cmd:move_to_mac' }],
    [{ text: '🕹 AnyDesk (שליטה במאק)', callback_data: 'cmd:anydesk' }],
    [{ text: '🛑 Cancel', callback_data: 'cmd:cancel' }]
  ];

  const pipe = attachCommands.getMode() === 'attach' ? '🔗 Remote Ses' : '📚 Resume Sessions';
  const text = `🤖 *Claude Session*\n\n` +
    `Messages go to: *${pipe}*\n` +
    `🔄 Interactive: ${interactiveStatus} ${procStatus}\n` +
    `🖥 Display: ${terminalStatus}\n\n` +
    `Interactive = Claude runs persistently\n` +
    `iTerm = See Claude in visible window\n\n` +
    `Just type a message to chat!`;

  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  return messageId
    ? bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts }).catch(() => {})
    : bot.sendMessage(chatId, text, opts);
}

bot.onText(/\/claude/, async (msg) => {
  if (!isAuthorized(msg)) return;
  sendClaudeSessionPanel(bot, msg.chat.id);
});

// ===== Close command - kill all bot instances =====
bot.onText(/\/close/, async (msg) => {
  if (!isAuthorized(msg)) return;

  await bot.sendMessage(msg.chat.id, '👋 Closing all bot instances...');

  // Give time for message to send
  setTimeout(() => {
    process.exit(0);
  }, 500);
});

// ===== Reset command - clear stuck state without restart =====
bot.onText(/\/reset/, async (msg) => {
  if (!isAuthorized(msg)) return;

  const chatId = msg.chat.id;

  // Use the central reset function
  resetUserRuntime(chatId, { killProc: true, clearSessions: true });

  await bot.sendMessage(chatId, '🔄 State reset! Send a message to start fresh.');
});

// ===== Restart command =====
// /restart - keeps session for auto-resume
// /restart clean - clears everything including sessions
bot.onText(/\/restart(?:\s+(clean))?/, async (msg, match) => {
  if (!isAuthorized(msg)) return;

  const chatId = msg.chat.id;
  const cleanMode = match[1] === 'clean';

  if (cleanMode) {
    await bot.sendMessage(chatId, '🔄 Restarting bot (clean - clearing all sessions)...');
    resetAllUsersRuntime({ killProc: true, clearSessions: true, keepSessionId: false });
    // Clear sessions file
    try { fs.writeFileSync(path.join(__dirname, 'data', 'sessions.json'), '{}'); } catch (e) {}
  } else {
    await bot.sendMessage(chatId, '🔄 Restarting bot (keeping session for resume)...');
    resetAllUsersRuntime({ killProc: true, clearSessions: false, keepSessionId: true });
  }

  // Save state before restart
  saveNow();

  // Save chat ID for restart notification
  fs.writeFileSync(FILES.restartNotify, chatId.toString());

  // Restart via start.sh to get wrapper + caffeinate back
  const { spawn } = require('child_process');
  setTimeout(() => {
    spawn('bash', ['start.sh'], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore'
    }).unref();

    // Exit current process (start.sh will kill us anyway, but be clean)
    setTimeout(() => process.exit(0), 500);
  }, 500);
});

// ===== Photo handler - download and send to Claude =====
bot.on('photo', async (msg) => {
  if (!isAuthorized(msg)) return;

  const chatId = msg.chat.id;
  const userState = getUserState(chatId);

  // Send status message immediately
  let statusMsg;
  try {
    statusMsg = await bot.sendMessage(chatId, '📷 Downloading image...', { reply_to_message_id: msg.message_id });
  } catch (e) {
    return;
  }

  try {
    // Get highest resolution photo
    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;

    // Create images directory
    const imagesDir = path.join(__dirname, 'data', 'images');
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }

    // Use bot's built-in downloadFile method (handles auth automatically)
    const localPath = path.join(imagesDir, `${Date.now()}_${fileId.substring(0, 20)}.jpg`);

    console.log(`📷 Downloading image to: ${localPath}`);
    await bot.downloadFile(fileId, imagesDir);

    // Find the downloaded file (bot.downloadFile uses original filename)
    const file = await bot.getFile(fileId);
    const downloadedPath = path.join(imagesDir, path.basename(file.file_path));

    // Rename to our path
    if (fs.existsSync(downloadedPath) && downloadedPath !== localPath) {
      fs.renameSync(downloadedPath, localPath);
    }

    // Verify file was downloaded
    if (!fs.existsSync(localPath)) {
      await bot.editMessageText('❌ Failed to download image', { chat_id: chatId, message_id: statusMsg.message_id });
      return;
    }

    const stats = fs.statSync(localPath);
    console.log(`📷 Image saved: ${stats.size} bytes`);

    if (stats.size < 1000) {
      // Too small, probably an error
      const content = fs.readFileSync(localPath, 'utf-8').substring(0, 200);
      console.log(`📷 Image content: ${content}`);
      await bot.editMessageText(`❌ Download failed: ${content.substring(0, 100)}`, { chat_id: chatId, message_id: statusMsg.message_id });
      return;
    }

    // Update status
    await bot.editMessageText('🔄 Analyzing image with Claude...', { chat_id: chatId, message_id: statusMsg.message_id });

    // Build prompt - tell Claude to read and analyze the image file
    const caption = msg.caption || 'Please analyze this image';
    const prompt = `${caption}\n\nThe image is at: ${localPath}\nPlease read and analyze it.`;

    // Use Claude in print mode with the prompt
    const { exec } = require('child_process');
    const modeFlag = require('./lib/utils').getModeFlag(userState.currentMode);
    const escapedPrompt = prompt.replace(/'/g, "'\\''");

    const cmd = `claude -p '${escapedPrompt}' ${modeFlag} < /dev/null`;
    console.log(`📷 Running: ${cmd.substring(0, 100)}...`);

    exec(cmd, {
      cwd: userState.currentPath,
      env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 3 * 60 * 1000  // 3 min timeout for image analysis
    }, async (error, stdout, stderr) => {
      // Delete status message
      try { await bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) {}

      if (error) {
        const errMsg = stderr || error.message || 'Unknown error';
        bot.sendMessage(chatId, `❌ Error: ${errMsg.substring(0, 500)}`);
        return;
      }

      const output = stdout || 'Done (no output)';

      // Send response
      if (output.length <= 4000) {
        bot.sendMessage(chatId, output);
      } else {
        const { sendLongMessage } = require('./lib/utils');
        await sendLongMessage(bot, chatId, output);
      }

      // Clean up old images (keep last 20)
      try {
        const files = fs.readdirSync(imagesDir)
          .map(f => ({ name: f, time: fs.statSync(path.join(imagesDir, f)).mtime.getTime() }))
          .sort((a, b) => b.time - a.time);

        if (files.length > 20) {
          for (const f of files.slice(20)) {
            fs.unlinkSync(path.join(imagesDir, f.name));
          }
        }
      } catch (e) {}
    });
  } catch (e) {
    console.log(`📷 Error: ${e.message}`);
    try {
      await bot.editMessageText(`❌ Failed: ${e.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
    } catch (e2) {
      bot.sendMessage(chatId, `❌ Failed: ${e.message}`);
    }
  }
});

// ===== Log commands =====
bot.onText(/\/logs(?:\s+(\d+))?/, async (msg, match) => {
  if (!isAuthorized(msg)) return;

  const lines = parseInt(match[1]) || 50;

  try {
    const output = await runQuickCommand(`tail -${lines} "${FILES.log}"`, process.env.HOME);

    if (output.length > 4000) {
      const buffer = Buffer.from(output, 'utf-8');
      await bot.sendDocument(msg.chat.id, buffer, {
        caption: `📜 Last ${lines} lines of bot.log`
      }, {
        filename: 'bot-logs.txt',
        contentType: 'text/plain'
      });
    } else {
      bot.sendMessage(msg.chat.id, `📜 *Last ${lines} lines:*\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
    }
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Error reading logs: ${e.message}`);
  }
});

bot.onText(/\/logfile/, async (msg) => {
  if (!isAuthorized(msg)) return;

  try {
    const content = fs.readFileSync(FILES.log, 'utf-8');
    const buffer = Buffer.from(content, 'utf-8');

    await bot.sendDocument(msg.chat.id, buffer, {
      caption: `📜 Full bot.log (${(content.length / 1024).toFixed(1)} KB)`
    }, {
      filename: `bot-log-${new Date().toISOString().slice(0, 10)}.txt`,
      contentType: 'text/plain'
    });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`);
  }
});

bot.onText(/\/clearlogs/, async (msg) => {
  if (!isAuthorized(msg)) return;

  try {
    fs.writeFileSync(FILES.log, `🤖 Logs cleared at ${new Date().toISOString()}\n`);
    bot.sendMessage(msg.chat.id, '✅ Logs cleared');
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`);
  }
});

// /anydesk - wake AnyDesk on the Mac and send back the address to connect to
async function handleAnydesk(chatId) {
  const script = path.join(process.env.HOME, '.claude', 'telegram-bot', 'scripts', 'anydesk-up.sh');
  await bot.sendMessage(chatId, '🖥 מעיר את AnyDesk על המאק...');
  try {
    // AnyDesk polls up to ~12s to come up, so give the command headroom past
    // runQuickCommand's 10s default — otherwise a cold start gets cut off.
    const output = await runQuickCommand(`bash "${script}"`, process.env.HOME, 20000);
    const m = output.match(/ID:\s*([0-9]{6,})/);
    if (m) {
      await bot.sendMessage(chatId,
        `🖥 *AnyDesk מוכן*\n\n` +
        `כתובת: \`${m[1]}\`\n\n` +
        `פתח AnyDesk בטלפון, הקש את הכתובת, וסיסמת הגישה שהגדרת. אם סימנת "התחבר אוטומטית" זה ייכנס לבד.`,
        { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, `⚠️ AnyDesk לא הגיב בזמן.\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
    }
  } catch (e) {
    bot.sendMessage(chatId, `❌ שגיאה: ${e.message}`);
  }
}

bot.onText(/\/anydesk/, async (msg) => {
  if (!isAuthorized(msg)) return;
  handleAnydesk(msg.chat.id);
});

// /waker - status of the independent bot-waker, or /waker <minutes> to set interval
bot.onText(/\/waker(?:\s+(\d+))?$/, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const script = path.join(process.env.HOME, '.claude', 'telegram-bot', 'scripts', 'waker-ctl.sh');
  const sub = match[1] ? `set ${match[1]}` : 'status';
  try {
    const out = await runQuickCommand(`bash "${script}" ${sub}`, process.env.HOME);
    bot.sendMessage(msg.chat.id, '⏰ *Waker*\n```\n' + ((out || '(no output)').trim()) + '\n```', { parse_mode: 'Markdown' });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
  }
});

// ===== Callback query handler =====
bot.on('callback_query', async (query) => {
  if (!ALLOWED_USER_IDS.includes(query.from.id)) {
    bot.answerCallbackQuery(query.id, { text: '⛔ Unauthorized' });
    return;
  }

  const data = query.data;
  const chatId = query.message.chat.id;
  const userState = getUserState(chatId);

  // Try each command module's callback handler
  if (navigationCommands.handleCallback(bot, query, userState)) return;
  if (gitCommands.handleCallback(bot, query, userState)) return;
  if (voiceCommands.handleCallback(bot, query, userState)) return;
  if (attachCommands.handleCallback(bot, query)) return;   // live-session pipe
  if (askCommands.handleCallback(bot, query)) return;   // own namespace, claimed before the generic cmd: handlers
  if (await claudeCommands.handleCallback(bot, query, userState)) return;  // async handler needs await
  if (parallelCommands.handleCallback(bot, query, userState)) return;
  if (helpCommands.handleCallback(bot, query, userState)) return;
  if (bookmarkCommands.handleCallback(bot, query, userState)) return;

  // Handle quick settings callbacks
  if (data.startsWith('qset:')) {
    const parts = data.split(':');
    const setting = parts[1];
    const value = parts[2];
    const { scheduleSave } = require('./lib/state');

    if (setting === 'voice') {
      userState.voiceMode = value;
      userState.voiceEnabled = value !== 'off';
      scheduleSave();
    } else if (setting === 'thought') {
      userState.thoughtMode = value;
      scheduleSave();
    } else if (setting === 'stream') {
      userState.streamMode = value;
      scheduleSave();
    } else if (setting === 'session') {
      userState.sessionMode = value === 'session';
      scheduleSave();
    } else if (setting === 'perm') {
      userState.currentMode = value;
      scheduleSave();
    } else if (setting === 'interactive') {
      userState.interactiveMode = value === 'on';
      if (value === 'off' && userState.interactiveProc) {
        claudeCommands.stopInteractiveSession(userState);
      }
      scheduleSave();
    } else if (setting === 'txtstyle') {
      if (!userState.voiceSettings) userState.voiceSettings = {};
      userState.voiceSettings.textStyle = value;
      scheduleSave();
    } else if (setting === 'vocstyle') {
      if (!userState.voiceSettings) userState.voiceSettings = {};
      userState.voiceSettings.responseLevel = value;
      scheduleSave();
    }

    bot.answerCallbackQuery(query.id, { text: `✅ ${setting}: ${value}` });
    sendQuickSettings(bot, chatId, query.message.message_id);
    return;
  }

  // Handle noop (label buttons)
  if (data === 'noop') {
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Handle /all menu callbacks
  if (data === 'all:remote') {
    attachCommands.handleCallback(bot, query);
    return;
  }

  if (data.startsWith('all:')) {
    handleAllMenuCallback(bot, query, userState);
    return;
  }

  // Handle log commands
  if (data === 'cmd:logs50' || data === 'cmd:logs100' || data === 'cmd:logfile' || data === 'cmd:clearlogs') {
    handleLogCallback(bot, query, chatId);
    return;
  }

  // AnyDesk - wake remote-access on the Mac
  if (data === 'cmd:anydesk') {
    bot.answerCallbackQuery(query.id, { text: '🖥 AnyDesk' });
    handleAnydesk(chatId);
    return;
  }

  // PWD command
  if (data === 'cmd:pwd') {
    bot.answerCallbackQuery(query.id, { text: '/pwd' });
    const modeIcon = userState.sessionMode ? '💬' : '⚡';
    const modeName = userState.sessionMode ? 'Session' : 'On-Demand';
    const voiceIcon = userState.voiceEnabled ? '🔊' : '🔇';
    bot.sendMessage(chatId, `📁 Current: *${userState.currentProject}*\n\`${userState.currentPath}\`\nMode: ${modeIcon} ${modeName} | ${voiceIcon}`, { parse_mode: 'Markdown' });
    return;
  }

  // Projects command
  if (data === 'cmd:projects') {
    bot.answerCallbackQuery(query.id, { text: '/projects' });
    const projects = getProjects();
    const projectNames = Object.keys(projects);
    const keyboard = [];
    for (let i = 0; i < projectNames.length; i += 2) {
      const row = [];
      row.push({ text: projectNames[i] === userState.currentProject ? `✓ ${projectNames[i]}` : projectNames[i], callback_data: `proj:${projectNames[i]}` });
      if (projectNames[i + 1]) {
        row.push({ text: projectNames[i + 1] === userState.currentProject ? `✓ ${projectNames[i + 1]}` : projectNames[i + 1], callback_data: `proj:${projectNames[i + 1]}` });
      }
      keyboard.push(row);
    }
    bot.sendMessage(chatId, `📁 *Select a project:*\n\nCurrent: *${userState.currentProject}*`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  // Browse command
  if (data === 'cmd:browse') {
    bot.answerCallbackQuery(query.id, { text: '/browse' });
    const keyboard = navigationCommands.buildBrowseKeyboard(userState.currentPath);
    const isGit = isGitRepo(userState.currentPath);
    bot.sendMessage(chatId,
      `📂 *Browse:* \`${userState.currentPath}\`\n${isGit ? '📦 This is a git repo' : '📁 Navigate to select a folder'}\n\n📦 = git repo (click to select)\n📁 = folder (click to enter)`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
    return;
  }
});

/**
 * Handle /all menu callbacks
 */
function handleAllMenuCallback(bot, query, userState) {
  const section = query.data.substring(4);
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  // Back button
  if (section === 'back') {
    bot.answerCallbackQuery(query.id, { text: '⬅️ Back' });
    sendAllMenu(bot, chatId, messageId);
    return;
  }

  // Quick Settings section
  if (section === 'settings') {
    bot.answerCallbackQuery(query.id, { text: '⚙️ Settings' });
    sendQuickSettings(bot, chatId, messageId);
    return;
  }

  // Navigation section
  if (section === 'nav') {
    bot.answerCallbackQuery(query.id, { text: '📂 Navigation' });
    const keyboard = [
      [{ text: '📂 Projects', callback_data: 'cmd:projects' }],
      [{ text: '🗂 Browse Folders', callback_data: 'cmd:browse' }],
      [{ text: '📍 Current Path', callback_data: 'cmd:pwd' }],
      [{ text: '⬅️ Back', callback_data: 'all:back' }]
    ];
    bot.editMessageText(`📂 *Navigation*\n\nManage projects and folders:`, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  // Quick Commands section
  if (section === 'files') {
    bot.answerCallbackQuery(query.id, { text: '📋 Quick Commands' });
    const keyboard = [
      [{ text: '📄 List Files (ls)', callback_data: 'cmd:ls' }],
      [{ text: '🌳 Tree View', callback_data: 'cmd:tree' }],
      [{ text: '🔍 Find Files', callback_data: 'cmd:files' }],
      [{ text: '⬅️ Back', callback_data: 'all:back' }]
    ];
    bot.editMessageText(`📋 *Quick Commands*\n\nBrowse files and folders:`, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  // Claude AI section
  if (section === 'claude') {
    bot.answerCallbackQuery(query.id, { text: '🤖 Claude AI' });
    const sessionIcon = userState.sessionMode ? '💬' : '⚡';
    const keyboard = [
      [{ text: '📚 Past Sessions', callback_data: 'cmd:sessions' }],
      [{ text: `${sessionIcon} Session Mode`, callback_data: 'cmd:session' }, { text: '🆕 New Session', callback_data: 'cmd:new' }],
      [{ text: '💾 Persist Session', callback_data: 'cmd:persist' }, { text: '⚙️ Permission Mode', callback_data: 'cmd:mode' }],
      [{ text: '🧠 Thought Log', callback_data: 'cmd:thought' }],
      [{ text: '🖥 Move to Mac', callback_data: 'cmd:move_to_mac' }],
      [{ text: '🛑 Cancel Request', callback_data: 'cmd:cancel' }],
      [{ text: '⬅️ Back', callback_data: 'all:back' }]
    ];
    bot.editMessageText(`🤖 *Claude AI*\n\n` +
      `${sessionIcon} Mode: ${userState.sessionMode ? 'Session (remembers context)' : 'On-Demand (independent)'}\n` +
      `⚙️ Permission: ${userState.currentMode}\n` +
      `🧠 Thought Log: ${userState.showProcessLog ? 'ON' : 'OFF'}\n\n` +
      `Just type a message to chat with Claude!`, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  // Interactive section
  if (section === 'interactive') {
    bot.answerCallbackQuery(query.id, { text: '🔄 Interactive' });
    const interactiveStatus = userState.interactiveMode ? 'ON' : 'OFF';
    const terminalStatus = userState.showTerminal ? 'iTerm' : 'Background';
    const procStatus = userState.interactiveProc ? '*(running)*' : '*(stopped)*';
    const keyboard = [
      [{ text: `🔄 Interactive: ${interactiveStatus}`, callback_data: 'cmd:interactive' }],
      [{ text: `🖥 Display: ${terminalStatus}`, callback_data: 'cmd:terminal' }],
      [{ text: '▶️ Resume Session', callback_data: 'cmd:resume' }],
      [{ text: '⬅️ Back', callback_data: 'all:back' }]
    ];
    bot.editMessageText(`🔄 *Interactive Mode*\n\n` +
      `🔄 Interactive: ${interactiveStatus} ${procStatus}\n` +
      `🖥 Display: ${terminalStatus}\n\n` +
      `Interactive = Claude runs persistently\n` +
      `iTerm = See Claude in visible window`, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  // Parallel section
  if (section === 'parallel') {
    bot.answerCallbackQuery(query.id, { text: '🔀 Parallel' });
    const keyboard = [
      [{ text: '🔀 Perspectives - Multiple viewpoints', callback_data: 'cmd:perspectives' }],
      [{ text: '🌳 Investigate - Parallel branches', callback_data: 'cmd:investigate' }],
      [{ text: '⬅️ Back', callback_data: 'all:back' }]
    ];
    bot.editMessageText(`🔀 *Parallel Operations*\n\n` +
      `Get multiple AI perspectives or break down complex problems into parallel investigations.\n\n` +
      `• *Perspectives* - Ask same question, get different viewpoints\n` +
      `• *Investigate* - Claude breaks problem into branches, investigates each in parallel`, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  // Git section
  if (section === 'git') {
    bot.answerCallbackQuery(query.id, { text: '🌿 Git' });
    const keyboard = [
      [{ text: '📊 Status', callback_data: 'cmd:status' }],
      [{ text: '🌿 Branch', callback_data: 'cmd:branch' }],
      [{ text: '🌲 All Branches', callback_data: 'cmd:branches' }],
      [{ text: '📦 Repo Info', callback_data: 'cmd:repo' }],
      [{ text: '⬅️ Back', callback_data: 'all:back' }]
    ];
    bot.editMessageText(`🌿 *Git*\n\nGit operations:`, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  // Voice section
  if (section === 'voice') {
    bot.answerCallbackQuery(query.id, { text: '🎙 Voice' });
    const voiceIcon = userState.voiceEnabled ? '🔊' : '🔇';
    const engineInfo = TTS_ENGINES[userState.voiceSettings.ttsEngine || 'edge'];
    const chunkPreset = VOICE_CHUNK_PRESETS[userState.voiceSettings.chunkPreset || 'medium'];
    const keyboard = [
      [{ text: `${voiceIcon} Toggle Voice`, callback_data: 'cmd:voice' }],
      [{ text: `🔧 TTS Engine: ${engineInfo.icon} ${engineInfo.name}`, callback_data: 'cmd:tts' }],
      [{ text: '🎙 Change Voice', callback_data: 'cmd:setvoice' }],
      [{ text: '⏩ Voice Speed', callback_data: 'cmd:setvoicespeed' }],
      [{ text: `📦 Chunks: ${chunkPreset.icon} ${chunkPreset.name}`, callback_data: 'cmd:voicechunk' }],
      [{ text: '🎭 Response Style', callback_data: 'cmd:voiceresponse' }],
      [{ text: '⬅️ Back', callback_data: 'all:back' }]
    ];
    bot.editMessageText(`🎙 *Voice Settings*\n\nVoice: ${userState.voiceEnabled ? 'ON 🔊' : 'OFF 🔇'}\nEngine: ${engineInfo.icon} ${engineInfo.name}\nChunks: ${chunkPreset.icon} ${chunkPreset.name}`, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  // Logs section
  if (section === 'logs') {
    bot.answerCallbackQuery(query.id, { text: '📜 Logs' });
    const keyboard = [
      [{ text: '📜 Last 50 Lines', callback_data: 'cmd:logs50' }],
      [{ text: '📜 Last 100 Lines', callback_data: 'cmd:logs100' }],
      [{ text: '📥 Download Full Log', callback_data: 'cmd:logfile' }],
      [{ text: '🗑 Clear Logs', callback_data: 'cmd:clearlogs' }],
      [{ text: '⬅️ Back', callback_data: 'all:back' }]
    ];
    bot.editMessageText(`📜 *Logs*\n\nView bot logs:`, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }
}

/**
 * Handle log callbacks
 */
function handleLogCallback(bot, query, chatId) {
  const data = query.data;

  if (data === 'cmd:logs50') {
    bot.answerCallbackQuery(query.id, { text: '/logs 50' });
    runQuickCommand(`tail -50 "${FILES.log}"`, process.env.HOME).then(output => {
      if (output.length > 4000) {
        const buffer = Buffer.from(output, 'utf-8');
        bot.sendDocument(chatId, buffer, { caption: '📜 Last 50 lines' }, { filename: 'bot-logs.txt', contentType: 'text/plain' });
      } else {
        bot.sendMessage(chatId, `📜 *Last 50 lines:*\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
      }
    });
    return;
  }

  if (data === 'cmd:logs100') {
    bot.answerCallbackQuery(query.id, { text: '/logs 100' });
    runQuickCommand(`tail -100 "${FILES.log}"`, process.env.HOME).then(output => {
      const buffer = Buffer.from(output, 'utf-8');
      bot.sendDocument(chatId, buffer, { caption: '📜 Last 100 lines' }, { filename: 'bot-logs.txt', contentType: 'text/plain' });
    });
    return;
  }

  if (data === 'cmd:logfile') {
    bot.answerCallbackQuery(query.id, { text: '/logfile' });
    try {
      const content = fs.readFileSync(FILES.log, 'utf-8');
      const buffer = Buffer.from(content, 'utf-8');
      bot.sendDocument(chatId, buffer, { caption: `📜 Full bot.log (${(content.length / 1024).toFixed(1)} KB)` }, { filename: `bot-log-${new Date().toISOString().slice(0, 10)}.txt`, contentType: 'text/plain' });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Error: ${e.message}`);
    }
    return;
  }

  if (data === 'cmd:clearlogs') {
    bot.answerCallbackQuery(query.id, { text: '/clearlogs' });
    try {
      fs.writeFileSync(FILES.log, `🤖 Logs cleared at ${new Date().toISOString()}\n`);
      bot.sendMessage(chatId, '✅ Logs cleared');
    } catch (e) {
      bot.sendMessage(chatId, `❌ Error: ${e.message}`);
    }
    return;
  }
}

// ===== Handle regular messages (Claude interaction) =====
bot.on('message', async (msg) => {
  // Update last activity timestamp for idle detection
  try {
    fs.writeFileSync(FILES.lastActivity, Date.now().toString());
  } catch (e) {
    // Ignore errors - not critical
  }

  // Append-only inbound journal. last_activity is a single overwritten
  // timestamp, so when messages go missing there is nothing left to inspect:
  // you cannot tell "nothing was sent" from "it was sent and dropped". One
  // line per inbound message, written before any auth check or routing, makes
  // that answerable after the fact.
  try {
    const kind = msg.text ? 'text' : Object.keys(msg).find(k =>
      ['voice', 'photo', 'document', 'audio', 'video', 'sticker'].includes(k)) || 'other';
    const preview = (msg.text || '').replace(/\s+/g, ' ').slice(0, 80);
    fs.appendFileSync(
      path.join(path.dirname(FILES.sessions), 'inbound.log'),
      `${new Date().toISOString()} chat=${msg.chat.id} from=${msg.from?.id} ${kind} ${preview}\n`
    );
  } catch (e) {}

  // Check if this is a bookmark reply first
  if (bookmarkCommands.handleReply(msg, bot)) return;

  // Or an /ask question reply
  if (askCommands.handleReply(msg, bot)) return;

  // Or a session-note reply from the management card
  if (claudeCommands.handleNoteReply(msg, bot)) return;

  // Attached to a live session? Inject there instead of resuming.
  if (attachCommands.maybeRoute(bot, msg)) return;

  await claudeCommands.handleMessage(bot, msg, isAuthorized);
});

// ===== Error handling =====
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

console.log('✅ Bot is ready!');

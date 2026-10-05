#!/usr/bin/env node
/**
 * Claude Telegram Bot - Main Entry Point
 * Refactored modular version with persistence
 */

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// Load modules
const platform = require('./lib/platform');
const { FILES, TTS_ENGINES, VOICE_CHUNK_PRESETS, RESTART_EXIT_CODE } = require('./lib/config');
const { getUserState, getAllUserStates, saveNow, getProjects, setSessionsModule, restoreActiveSessions, resetUserRuntime, resetAllUsersRuntime } = require('./lib/state');
const { cleanupTempFiles, runQuickCommand, isGitRepo, tailFile } = require('./lib/utils');
const sessions = require('./lib/sessions');
const topics = require('./lib/topics');

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
const gaggimateCommands = require('./lib/commands/gaggimate');
const settingsNL = require('./lib/commands/settings-nl');
const stt = require('./lib/stt');

// A QA run loads this file to drive the real handlers with synthetic updates. It must not
// poll Telegram, must not take the running bot's place, and must leave no trace: no
// killing the live instance, no pid file, no heartbeat, no session scan. See scripts/qa.js.
const QA_MODE = process.env.CLAUDEGRAM_QA === '1';

// ===== Kill previous instance if exists =====
// Telegram serves getUpdates to one consumer per token, so a surviving old
// process does not merely waste memory — the two fight over every update and
// both get 409s. This has to succeed before polling starts.
if (!QA_MODE) try {
  if (fs.existsSync(FILES.pid)) {
    const oldPid = fs.readFileSync(FILES.pid, 'utf-8').trim();
    if (oldPid && oldPid !== process.pid.toString()) {
      if (platform.killPid(oldPid)) console.log(`Killed previous instance (PID: ${oldPid})`);
    }
  }
  // Also kill any other bot.js processes
  for (const pid of platform.findProcesses(['node', 'bot.js'])) {
    if (platform.killPid(pid)) console.log(`Killed orphan instance (PID: ${pid})`);
  }
} catch (e) {}

// Write current PID
if (!QA_MODE) {
  fs.writeFileSync(FILES.pid, process.pid.toString());
  console.log(`Bot PID: ${process.pid}`);
}

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
    // Anything already in the environment wins, as it does everywhere else: a file that
    // overwrites it leaves no way to override a value for one run.
    if (key && vals.length && process.env[key.trim()] === undefined) {
      process.env[key.trim()] = vals.join('=').trim();
    }
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
const mainBot = new TelegramBot(BOT_TOKEN, {
  polling: QA_MODE ? false : {
    autoStart: true,
    params: { timeout: 30 }
  }
});

// Answer through whichever bot can reach the chat being answered.
//
// Everything in this file replies to msg.chat.id, and most of it was written before topics
// existed. Inside a group that id is the synthetic "<chat>:<thread>" key, which only the
// group bot knows how to turn back into a chat plus a thread — handing it to this bot
// produces an invalid chat id, which is how even "⛔ Unauthorized" failed to arrive.
// Deciding from the id itself means no handler has to know: the same code answers in a
// direct chat, in General, and inside a topic.
const CHAT_FIRST = new Set(['sendMessage', 'sendPhoto', 'sendDocument', 'sendVoice', 'sendAudio', 'sendChatAction', 'sendSticker', 'deleteMessage']);
const CHAT_IN_OPTIONS = new Set(['editMessageText', 'editMessageCaption', 'editMessageReplyMarkup']);

// groupBot is built much further down; resolved per call, never captured.
function routeFor(chatId) {
  return groupBot && String(chatId).startsWith('-') ? groupBot : null;
}

const bot = new Proxy(mainBot, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== 'function') return value;
    const name = String(prop);

    if (CHAT_FIRST.has(name)) {
      return (...args) => {
        const via = routeFor(args[0]);
        return via ? via[name](...args) : value.apply(target, args);
      };
    }
    if (CHAT_IN_OPTIONS.has(name)) {
      return (...args) => {
        const via = routeFor(args[1] && args[1].chat_id);
        return via ? via[name](...args) : value.apply(target, args);
      };
    }
    return value.bind(target);
  }
});

// Slash handlers live in this file as well as in the command modules, and the group bot is
// created long after they are registered. Collecting them is what lets a topic offer the
// same menu and the same commands as the direct chat instead of staying silent.
const localHandlers = [];
const localEvents = [];

function onCommand(regexp, handler) {
  localHandlers.push([regexp, handler]);
  bot.onText(regexp, handler);
}

function onEvent(event, handler) {
  localEvents.push([event, handler]);
  bot.on(event, handler);
}

/**
 * The bot a message actually arrived on.
 *
 * Handlers in this file are registered against both bots, but they closed over the
 * private one — so a photo sent in a topic was answered by a bot that is not in
 * that group, and, worse, downloaded with the wrong token.
 *
 * That second part is the whole bug. A file id belongs to the bot it was given to:
 * handing one to another token gets a refusal rather than a file, which is why a
 * picture in a topic came back as a download failure with nothing useful to say
 * about it. Anything touching a file has to ask which bot it is holding.
 */
function botFor(msg) {
  if (!groupBot) return bot;
  const id = msg && msg.chat && msg.chat.id;
  // A synthetic topic key, or any non-private chat: both belong to the group bot.
  if (typeof id === 'string' && id.includes(':')) return groupBot;
  if (msg && msg.chat && msg.chat.type && msg.chat.type !== 'private') return groupBot;
  return bot;
}

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

// Set bot commands menu. Named so the group bot can register the same list.
const ALL_COMMANDS = [
  { command: 'menu', description: '📱 Main menu (all categories)' },
  { command: 'settings', description: '⚙️ Quick settings' },
  { command: 'set', description: '🗣 Change a setting in words ("/set קול אוטומטי")' },
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
  { command: 'resume_here', description: '▶️ Bring this topic\'s newest session back' },
  { command: 'bookmark', description: '🔖 Bookmark (save)' },
  { command: 'bookmarks', description: '🔖 Bookmarks (show all)' },
  { command: 'pin', description: '📌 Pin current session' },
  { command: 'anydesk', description: '🕹 AnyDesk' },
  { command: 'waker', description: '⏰ Bot waker (status / set minutes)' },
  { command: 'pipe', description: '🔀 Pipe: live-attach vs resume' },
  { command: 'attach', description: '🔗 Attach to a live session' },
  { command: 'detach', description: '⏹ Detach (back to resume)' }
];

// The attach pipe is macOS-only: off it, every one of these three returns without
// answering. Publishing them anyway puts commands in the menu that do nothing when
// pressed, which reads as a broken bot rather than a feature that isn't there.
const ATTACH_ONLY = new Set(['pipe', 'attach', 'detach']);
const BOT_COMMANDS = attachCommands.SUPPORTED
  ? ALL_COMMANDS
  : ALL_COMMANDS.filter(c => !ATTACH_ONLY.has(c.command));

bot.setMyCommands(BOT_COMMANDS).then(() => {
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
if (!QA_MODE) setInterval(writeHeartbeat, 30000);

// Cleanup old temp files on startup
cleanupTempFiles();

// Sync CLI sessions to unified registry on startup
if (!QA_MODE) try { require('./scripts/watch-cli-sessions'); } catch (e) { console.log('⚠️ CLI session sync skipped:', e.message); }

// Restore active sessions for users with persistSession enabled
restoreActiveSessions();

// Bringing the speech model up costs seconds on a CPU and can cost half a minute on a
// cold GPU. Doing it here means that lands while nobody is waiting, instead of on the
// first voice note of a drive. Off by default — it holds the model's memory on a machine
// that may want it for something else.
if (process.env.STT_PRELOAD === '1') stt.preload();

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
gaggimateCommands.register(bot, isAuthorized);
attachCommands.register(bot, isAuthorized);
settingsNL.register(bot, isAuthorized);
attachCommands.setRenderers({
  menu:   (b, c, m) => sendAllMenu(b, c, m),
  claude: (b, c, m) => sendClaudeSessionPanel(b, c, m)
});

// ===== Help commands =====
onCommand(/\/start$/, (msg) => {  // Only match /start without parameters
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
onCommand(/\/all/, (msg) => {
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
onCommand(/\/menu/, (msg) => {
  if (!isAuthorized(msg)) return;
  sendAllMenu(bot, msg.chat.id);
});

// ===== /settings - Quick settings menu =====
onCommand(/\/settings/, (msg) => {
  if (!isAuthorized(msg)) return;
  sendQuickSettings(bot, msg.chat.id);
});

// /stream [off|on|live] - how much of the answer you watch being written
onCommand(/^\/stream(?:\s+(off|on|live))?$/, (msg, match) => {
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
  const sttMode = userState.sttMode || 'off';

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
    // Voice notes IN — the other direction from the row above, and the only row here
    // that depends on something outside npm, so it ships off and says why when switched on.
    [
      { text: `Rec→Text: ${sttMode === 'on' ? '🎧' : '🚫'}`, callback_data: 'noop' },
      { text: sttMode === 'off' ? '● off' : 'off', callback_data: 'qset:stt:off' },
      { text: sttMode === 'on' ? '● on' : 'on', callback_data: 'qset:stt:on' }
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
    // Remote Ses is the attach pipe, which exists only on macOS. Off it the callback
    // returns without answering, so the button looked broken rather than unavailable.
    attachCommands.SUPPORTED
      ? [{ text: '🔗 Remote Ses', callback_data: 'all:remote' }, { text: '⚙️ Quick Settings', callback_data: 'all:settings' }]
      : [{ text: '⚙️ Quick Settings', callback_data: 'all:settings' }],
    [{ text: '🤖 Claude AI', callback_data: 'all:claude' }, { text: '🔄 Interactive', callback_data: 'all:interactive' }],
    [{ text: '📂 Navigation', callback_data: 'all:nav' }, { text: '📋 Quick Commands', callback_data: 'all:files' }],
    [{ text: '🌿 Git', callback_data: 'all:git' }, { text: '🔀 Parallel', callback_data: 'all:parallel' }],
    [{ text: '🎙 Voice', callback_data: 'all:voice' }, { text: '📜 Logs', callback_data: 'all:logs' }],
    [{ text: '🛑 Cancel Request', callback_data: 'cmd:cancel' }]
  ];

  // Espresso machine control, for the one person in the room who has one. Two gates, and
  // they answer different questions: AVAILABLE is "is there a machine on this network"
  // (GAGGIMATE_HOST), and the setting is "do I want to look at it right now". Same
  // reasoning as the Remote Ses row above — a button that cannot work should not be
  // drawn, because a drawn button that does nothing reads as a broken bot.
  if (gaggimateCommands.AVAILABLE && (userState.gaggimate || 'on') !== 'off') {
    keyboard.splice(keyboard.length - 1, 0, [{ text: '☕ GaggiMate', callback_data: 'gag:home' }]);
  }

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
    ...(attachCommands.SUPPORTED ? [[{ text: '🔗 Remote Ses', callback_data: 'all:remote' }]] : []),
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

onCommand(/\/claude/, async (msg) => {
  if (!isAuthorized(msg)) return;
  sendClaudeSessionPanel(bot, msg.chat.id);
});

// ===== Close command - kill all bot instances =====
onCommand(/\/close/, async (msg) => {
  if (!isAuthorized(msg)) return;

  await bot.sendMessage(msg.chat.id, '👋 Closing all bot instances...');

  // Give time for message to send
  setTimeout(() => {
    process.exit(0);
  }, 500);
});

// ===== Reset command - clear stuck state without restart =====
onCommand(/\/reset/, async (msg) => {
  if (!isAuthorized(msg)) return;

  const chatId = msg.chat.id;

  // Use the central reset function
  resetUserRuntime(chatId, { killProc: true, clearSessions: true });

  await bot.sendMessage(chatId, '🔄 State reset! Send a message to start fresh.');
});

// ===== Restart command =====
// /restart - keeps session for auto-resume
// /restart clean - clears everything including sessions
onCommand(/\/restart(?:\s+(clean))?/, async (msg, match) => {
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

  // Ask the wrapper to bring us back, rather than launching our own replacement.
  //
  // The old path spawned the launcher detached and then exited, which left the restart
  // riding on a child outliving the parent that made it. On Windows that is not a promise
  // the OS keeps: a detached child still inherits its parent's job object, so whatever
  // tears the tree down takes the launcher with it. The launcher then had to kill an
  // instance that was already leaving and re-open log files the dying wrapper might still
  // hold — Start-Process fails outright if they are locked. Any of those landed the same
  // way, cleanly and silently: bot gone, nothing to bring it back.
  //
  // The wrapper is already the thing that outlives bot.js, so let it do the job. A
  // dedicated exit code separates "restart me" from a crash (retried, budget spent) and
  // from a clean exit (/close, which must stay down).
  const { spawn } = require('child_process');
  setTimeout(() => {
    if (process.env.CLAUDEGRAM_WRAPPED) {
      process.exit(RESTART_EXIT_CODE);
      return;
    }

    // Started without the wrapper, so there is nobody to come back for us.
    const launcher = platform.IS_WIN
      ? { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'start.ps1'] }
      : { file: 'bash', args: ['start.sh'] };
    spawn(launcher.file, launcher.args, {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore'
    }).unref();

    setTimeout(() => process.exit(0), 500);
  }, 500);
});

// ===== Photo handler - download and send to Claude =====

/** One picture on disk, under a name of ours. Throws if nothing usable arrived. */
async function savePhoto(api, msg) {
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
  await api.downloadFile(fileId, imagesDir);

  // Find the downloaded file (bot.downloadFile uses original filename)
  const file = await api.getFile(fileId);
  const downloadedPath = path.join(imagesDir, path.basename(file.file_path));

  // Rename to our path
  if (fs.existsSync(downloadedPath) && downloadedPath !== localPath) {
    fs.renameSync(downloadedPath, localPath);
  }

  if (!fs.existsSync(localPath)) throw new Error('Failed to download image');

  const stats = fs.statSync(localPath);
  console.log(`📷 Image saved: ${stats.size} bytes`);

  if (stats.size < 1000) {
    // Too small, probably an error
    const content = fs.readFileSync(localPath, 'utf-8').substring(0, 200);
    console.log(`📷 Image content: ${content}`);
    throw new Error(`Download failed: ${content.substring(0, 100)}`);
  }

  return localPath;
}

/** Keep the most recent images and drop the rest. */
function pruneImages(keep = 40) {
  try {
    const imagesDir = path.join(__dirname, 'data', 'images');
    const files = fs.readdirSync(imagesDir)
      .map(f => ({ name: f, time: fs.statSync(path.join(imagesDir, f)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time);

    if (files.length > keep) {
      for (const f of files.slice(keep)) {
        fs.unlinkSync(path.join(imagesDir, f.name));
      }
    }
  } catch (e) {}
}

/**
 * What the session is told when pictures arrive.
 *
 * Several of them are one situation seen from several angles — a list, a chat and
 * the same chat after a restart — and answering each one on its own gets the
 * situation wrong in a way that answering all of them together does not.
 */
function photoPrompt(paths, caption) {
  const list = paths.map(p => `[תמונה מצורפת: ${p}]`).join('\n');
  const many = paths.length > 1;

  if (caption) {
    return `${caption}\n\n${list}\n` + (many
      ? `Open them all with Read. Together they are context for the message above — ` +
        `answer the message. Don't describe the pictures back.`
      : `Open it with Read. It is context for the message above — answer the message. ` +
        `Don't describe the picture back.`);
  }

  return `${list}\n` + (many
    ? `Open all ${paths.length} with Read. They are one situation shown in ${paths.length} ` +
      `pictures, not ${paths.length} separate questions — read them together and respond in ` +
      `the context of what we are working on. Don't narrate what is in them — say what they ` +
      `mean for the task, or ask what I want from them.`
    : `Open it with Read and respond to it in the context of what we are working on. ` +
      `Don't narrate what is in it — say what it means for the task, or ask what I want from it.`);
}

/**
 * An album is not one message.
 *
 * Telegram sends every picture in it as its own update, tied together only by
 * media_group_id, and there is no update that says which one was the last — so
 * unlike "is this recording finished", there is no fact here to ask the API for.
 * The pictures are collected instead, and handed over once a short quiet gap says
 * the group has stopped arriving. Sending them one at a time was the whole reason
 * a situation had to be explained in a single screenshot.
 */
const albums = new Map();
const ALBUM_QUIET_MS = 1500;

async function deliverPhotos(album) {
  const { api, first, status } = album;
  const chatId = first.chat.id;

  // Every failed download already said so on its own. Nothing arrived at all
  // means there is nothing to hand over.
  if (!album.shots.length) return;

  // A picture is a message, and it goes through the same front door as one.
  //
  // This used to spawn its own `claude -p` with "please read and analyze it".
  // That process had no history, no session and no future: it looked at the
  // file, wrote down what was in it, printed that, and died. Which is exactly
  // what it felt like from the phone — send a picture, get a caption back,
  // every single time, no matter what the session was in the middle of.
  //
  // The image never reached the session. Now it does: same route a voice note
  // takes once it has been transcribed, so the session that is already open
  // answers it, with everything it already knows still in front of it.
  if (status) {
    try { await api.deleteMessage(chatId, status.message_id); } catch (e) {}
  }

  // The updates of one album do not have to arrive in the order they were
  // picked, and the order they were picked is the order they explain things in.
  const paths = album.shots.sort((a, b) => a.id - b.id).map(s => s.path);

  // photo has to be cleared, or the front door routes it straight back here.
  const asText = {
    ...first,
    text: photoPrompt(paths, album.caption),
    caption: undefined,
    photo: undefined,
    media_group_id: undefined
  };
  await handleIncomingMessage(api, asText);

  pruneImages();
}

onEvent("photo", async (msg) => {
  if (!isAuthorized(msg)) return;

  const chatId = msg.chat.id;

  // The bot this arrived on, not whichever one this file happened to close over.
  // A file id only works with the token it was issued to.
  const api = botFor(msg);

  const key = msg.media_group_id ? `${chatId}:${msg.media_group_id}` : null;

  // The entry has to exist before the first await, or two pictures of the same
  // album arriving in one tick each open an album of their own.
  let album = key ? albums.get(key) : null;
  const opening = !album;
  if (opening) {
    album = { api, first: msg, status: null, caption: '', shots: [], timer: null };
    if (key) albums.set(key, album);
  }

  // Telegram hangs the caption on one picture of the album, not on all of them.
  const caption = (msg.caption || '').trim();
  if (caption && !album.caption) album.caption = caption;

  if (opening) {
    try {
      album.status = await api.sendMessage(chatId, '📷 Downloading image...', { reply_to_message_id: msg.message_id });
    } catch (e) {
      if (key) albums.delete(key);
      return;
    }
  }

  try {
    const localPath = await savePhoto(api, msg);
    album.shots.push({ id: msg.message_id, path: localPath });

    if (key && album.status && album.shots.length > 1) {
      api.editMessageText(`📷 Downloading images... (${album.shots.length})`, {
        chat_id: chatId,
        message_id: album.status.message_id
      }).catch(() => {});
    }
  } catch (e) {
    // One picture failing is not the album failing. Say so and let the rest of
    // the group go through.
    console.log(`📷 Error: ${e.message}`);
    if (album.status) {
      try {
        await api.editMessageText(`❌ Failed: ${e.message}`, { chat_id: chatId, message_id: album.status.message_id });
      } catch (e2) {
        api.sendMessage(chatId, `❌ Failed: ${e.message}`);
      }
      // That message is now the error, so nothing may delete it later.
      if (!album.shots.length) album.status = null;
    }
  }

  if (!key) {
    await deliverPhotos(album);
    return;
  }

  // Each picture pushes the handover further out, so the gap is measured from
  // the last one to arrive rather than the first.
  clearTimeout(album.timer);
  album.timer = setTimeout(() => {
    albums.delete(key);
    deliverPhotos(album).catch(e => console.log(`📷 Error: ${e.message}`));
  }, ALBUM_QUIET_MS);
});

// ===== Log commands =====
onCommand(/\/logs(?:\s+(\d+))?/, async (msg, match) => {
  if (!isAuthorized(msg)) return;

  const lines = parseInt(match[1]) || 50;

  try {
    const output = tailFile(FILES.log, lines);

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

onCommand(/\/logfile/, async (msg) => {
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

onCommand(/\/clearlogs/, async (msg) => {
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
  // anydesk-up.sh drives AnyDesk through AppleScript. There is no Windows
  // counterpart, so say so rather than failing with a missing-file error.
  if (!platform.IS_MAC) {
    return bot.sendMessage(chatId, '🖥 /anydesk זמין רק על המאק.');
  }
  const script = path.join(platform.HOME, '.claude', 'telegram-bot', 'scripts', 'anydesk-up.sh');
  await bot.sendMessage(chatId, '🖥 מעיר את AnyDesk על המאק...');
  try {
    // AnyDesk polls up to ~12s to come up, so give the command headroom past
    // runQuickCommand's 10s default — otherwise a cold start gets cut off.
    const output = await runQuickCommand(`bash "${script}"`, platform.HOME, 20000);
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

onCommand(/\/anydesk/, async (msg) => {
  if (!isAuthorized(msg)) return;
  handleAnydesk(msg.chat.id);
});

// /waker - status of the independent bot-waker, or /waker <minutes> to set interval
onCommand(/\/waker(?:\s+(\d+))?$/, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  // The waker is a LaunchAgent plus `pmset schedule wake`. On Windows the PC
  // does not sleep and a Scheduled Task covers startup, so there is nothing
  // here to report.
  if (!platform.IS_MAC) {
    return bot.sendMessage(msg.chat.id, '⏰ /waker זמין רק על המאק — כאן זו משימה מתוזמנת של Windows.');
  }
  const script = path.join(platform.HOME, '.claude', 'telegram-bot', 'scripts', 'waker-ctl.sh');
  const sub = match[1] ? `set ${match[1]}` : 'status';
  try {
    const out = await runQuickCommand(`bash "${script}" ${sub}`, platform.HOME);
    bot.sendMessage(msg.chat.id, '⏰ *Waker*\n```\n' + ((out || '(no output)').trim()) + '\n```', { parse_mode: 'Markdown' });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
  }
});

// ===== Callback query handler =====
async function handleCallbackQuery(bot, query) {
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
  if (gaggimateCommands.handleCallback(bot, query)) return;   // own gag: namespace
  if (settingsNL.handleCallback(bot, query, userState)) return;   // own nls: namespace

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
    } else if (setting === 'stt') {
      // Routed through the settings module so the panel and a spoken "תמלול דלוק" run
      // the same code — including the check for what the host is actually missing.
      settingsNL.applySetting(bot, chatId, userState, 'stt', value);
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
}

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
    Promise.resolve(tailFile(FILES.log, 50)).then(output => {
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
    Promise.resolve(tailFile(FILES.log, 100)).then(output => {
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

// ===== Voice notes in, text out =====
//
// Dictating into the text field still ends with hunting for Send. Holding the mic and
// letting go does not — which is the entire difference between usable and unusable at
// the wheel. So a voice note is transcribed and then re-enters this same function as an
// ordinary message: same settings parser, same session, same everything.
//
// The transcript is echoed back rather than swallowed, because whisper does mishear, and
// finding out from the answer is far worse than reading one line.
async function maybeTranscribe(bot, msg) {
  const media = msg.voice || msg.audio || msg.video_note;
  if (!media || msg.text) return false;
  if (!isAuthorized(msg)) return true;

  const chatId = msg.chat.id;

  // Ships off. A voice note that arrives anyway gets an explanation and a way in, once —
  // silently ignoring it would look like the bot is broken, and silently transcribing it
  // would mean installing things on someone's behalf that they never agreed to.
  if ((getUserState(chatId).sttMode || 'off') !== 'on') {
    bot.sendMessage(chatId,
      '🎙 קיבלתי הקלטה, אבל תמלול הקלטות כבוי.\n\n' +
      'זה רץ מקומית על המכונה שמריצה את הבוט ודורש התקנה חד־פעמית, ולכן הוא לא דלוק מראש.',
      {
        reply_to_message_id: msg.message_id,
        reply_markup: { inline_keyboard: [[{ text: '🎧 הפעל תמלול', callback_data: 'nls:v:stt:1' }]] }
      }
    ).catch(() => {});
    return true;
  }

  let notice = null;
  try {
    notice = await bot.sendMessage(chatId, '🎧 מתמלל...', { reply_to_message_id: msg.message_id });
  } catch (e) {}

  let file = null;
  try {
    file = await bot.downloadFile(media.file_id, require('os').tmpdir());
    const text = (await stt.transcribe(file, process.env.STT_LANG || 'he')).trim();

    if (!text) {
      if (notice) bot.editMessageText('🤷 לא שמעתי כלום בהקלטה.', { chat_id: chatId, message_id: notice.message_id }).catch(() => {});
      return true;
    }

    if (notice) bot.editMessageText(`🎙 _${text}_`, {
      chat_id: chatId, message_id: notice.message_id, parse_mode: 'Markdown'
    }).catch(() => {});

    // Hand it back to the front door as text. voice must be cleared or this loops.
    const asText = { ...msg, text, voice: undefined, audio: undefined, video_note: undefined };
    await handleIncomingMessage(bot, asText);
  } catch (e) {
    console.log(`[STT] ${e.message}`);
    const hint = /ENOENT|spawn/i.test(e.message) ? '\n(לא נמצא פייתון עם faster-whisper)' : '';
    if (notice) {
      bot.editMessageText(`⚠️ התמלול נכשל: ${e.message}${hint}`, { chat_id: chatId, message_id: notice.message_id }).catch(() => {});
    }
  } finally {
    if (file) { try { fs.unlinkSync(file); } catch (e) {} }
  }
  return true;
}

// ===== Handle regular messages (Claude interaction) =====
async function handleIncomingMessage(bot, msg) {
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

  // A settings panel that was tried as a reply keyboard and taken back out again. A
  // reply keyboard lives on the phone, not in this process: it was sent with
  // is_persistent, so removing the code that sent it left it sitting in every chat the
  // bot had answered in, with nothing left here that could take it down. Its buttons
  // then arrive as ordinary text -- '✕ Close settings' reaching Claude as a prompt.
  //
  // Answering that one label with remove_keyboard is the only way back: the keyboard
  // goes, and with it the rest of its buttons. Kept for chats that have not pressed it
  // yet, and harmless once none are left.
  if (msg.text === '✕ Close settings') {
    await bot.sendMessage(msg.chat.id, '⚙️ Settings closed', {
      reply_markup: { remove_keyboard: true },
      ...(msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {})
    });
    return;
  }

  // A voice note is just a message that has not been read out yet.
  if (await maybeTranscribe(bot, msg)) return;

  // Check if this is a bookmark reply first
  if (bookmarkCommands.handleReply(msg, bot)) return;

  // Or an /ask question reply
  if (askCommands.handleReply(msg, bot)) return;

  // Or a session-note reply from the management card
  if (claudeCommands.handleNoteReply(msg, bot)) return;

  // Attached to a live session? Inject there instead of resuming.
  if (attachCommands.maybeRoute(bot, msg)) return;

  // "אני רוצה קול" / "stream live" — a settings change stated in words. Only claims the
  // message when it is unambiguously one; anything else falls through to Claude.
  if (await settingsNL.maybeHandle(bot, msg, isAuthorized)) return;

  await claudeCommands.handleMessage(bot, msg, isAuthorized);
}

// ===== Wire the handlers to the main bot =====
// Both bots can sit in the same supergroup, so without a rule for who owns what they
// each answer every message. The main bot owns direct chats; the group bot owns groups.
//
// This has to filter the update itself, not sit in a 'message' listener. Telegram
// dispatches onText handlers from processUpdate: it emits 'message' first and only then
// walks the regexp callbacks, so a listener that returns early guards nothing — every
// slash command still runs, and answers in whichever chat the handler picks.
// Declared here rather than beside the group bot below, because the filter just under
// this needs to know whether a group bot is actually going to answer on this machine.
const GROUP_BOT_TOKEN = process.env.GROUP_BOT_TOKEN;

/**
 * Hold the group token without listening on it.
 *
 * Telegram serves getUpdates to one consumer per token. A second machine that copies
 * the settings file verbatim starts a second poll loop on the next restart, and the two
 * fight until both get 409s — so the working bot on the first machine breaks, remotely,
 * because somebody set up a laptop.
 *
 * But the token is still wanted there. scripts/move-to-telegram.js talks to the API over
 * plain HTTPS and never polls, so it can push a session from this machine into a topic
 * without anything here listening. This switch is that arrangement: the token is present
 * and usable for sending, and nothing in this process claims the group.
 */
const GROUP_BOT_SEND_ONLY = /^(1|true|yes|on)$/i.test(process.env.GROUP_BOT_SEND_ONLY || '');
const GROUP_BOT_ANSWERS = Boolean(GROUP_BOT_TOKEN) && !GROUP_BOT_SEND_ONLY;

const mainProcessUpdate = bot.processUpdate.bind(bot);
bot.processUpdate = (update) => {
  if (GROUP_BOT_ANSWERS) {
    const holder = update.message || update.edited_message || update.channel_post ||
      (update.callback_query && update.callback_query.message);
    const chat = holder && holder.chat;
    if (chat && chat.type !== 'private') return;
  }
  return mainProcessUpdate(update);
};

bot.on('message', (msg) => handleIncomingMessage(bot, msg));
bot.on('callback_query', (query) => handleCallbackQuery(bot, query));

// ===== Optional second bot: one supergroup, one topic per session =====
// Same process, same session machinery, second door. Without the token nothing below
// runs, so a machine that has not opted in behaves exactly as it always did.
let groupBot = null;

if (GROUP_BOT_TOKEN && GROUP_BOT_SEND_ONLY) {
  console.log('📤 Group bot: send-only — token held for scripts, not polled here');
}

if (GROUP_BOT_ANSWERS) {
  const { wrapBot, chatKeyOf } = require('./lib/topic-bot');
  const hosts = require('./lib/hosts');

  const raw = new TelegramBot(GROUP_BOT_TOKEN, {
    polling: QA_MODE ? false : { autoStart: true, params: { timeout: 30 } }
  });
  groupBot = wrapBot(raw);

  raw.on('polling_error', (err) => console.log(`[Polling:group] ${err.message || err}`));

  // Without its own registration the second bot has no slash menu at all. The default
  // scope does not reach group chats, so groups are registered explicitly too.
  raw.setMyCommands(BOT_COMMANDS)
    .then(() => raw.setMyCommands(BOT_COMMANDS, { scope: { type: 'all_group_chats' } }))
    .then(() => console.log('✅ Group bot commands menu set'))
    .catch(err => console.log('⚠️ Could not set group commands menu:', err.message));

  // Every command module registers against the wrapped bot, so their replies land back
  // in the topic they were called from without any of them knowing topics exist.
  navigationCommands.register(groupBot, isAuthorized);
  gitCommands.register(groupBot, isAuthorized);
  voiceCommands.register(groupBot, isAuthorized);
  claudeCommands.register(groupBot, isAuthorized);
  parallelCommands.register(groupBot, isAuthorized);
  bookmarkCommands.register(groupBot, isAuthorized);
  askCommands.register(groupBot, isAuthorized);
  helpCommands.register(groupBot, isAuthorized);
  gaggimateCommands.register(groupBot, isAuthorized);
  settingsNL.register(groupBot, isAuthorized);

  // With more than one bot in a group, Telegram appends @botname to every command the
  // menu inserts, so the text arrives as "/settings@some_bot". Handlers that anchor their
  // regex with $ — /stream, /waker, /resume, /pin — simply stop matching, and the ones
  // addressed to the other bot would be answered twice. Strip the suffix when we are the
  // one being addressed, and stay out of it when we are not.
  let selfName = null;
  raw.getMe()
    .then(me => { selfName = (me.username || '').toLowerCase(); })
    .catch(err => console.log('⚠️ Could not read group bot username:', err.message));

  // Which topics are this machine's to answer.
  //
  // Two machines each poll their own group bot, both sitting in the same group, so both
  // see every message in it. Without this gate they would both answer every topic. One
  // bound to the other machine is that machine's work, and is dropped here before any
  // handler runs — the same shape as the @botname check below, which already drops what
  // was addressed to somebody else.
  const ownsTopic = (m) => !m || !m.chat || hosts.answersHere(chatKeyOf(m));

  // Left unset on a second machine, every unbound topic is claimed by both and answered
  // twice. Silence would make that look like a bug in the bot rather than a missing line
  // in .env, so say it at startup, where it is still cheap to fix.
  if (hosts.hasChoice() && !(process.env.GROUP_FALLBACK_HOST || '').trim()) {
    console.log(`⚠️ GROUP_FALLBACK_HOST is not set — "${hosts.THIS_HOST}" will answer every ` +
      'topic nobody bound. With another machine in this group, set it to the same name on both.');
  }

  const passUpdate = raw.processUpdate.bind(raw);
  raw.processUpdate = (update) => {
    const m = update.message || update.edited_message;
    if (!ownsTopic(m || (update.callback_query && update.callback_query.message))) return;
    const addressed = m && typeof m.text === 'string' && /^\/[A-Za-z0-9_]+@([A-Za-z0-9_]+)/.exec(m.text);
    if (addressed) {
      if (selfName && addressed[1].toLowerCase() !== selfName) return;
      m.text = m.text.replace(/^(\/[A-Za-z0-9_]+)@[A-Za-z0-9_]+/, '$1');
    }
    return passUpdate(update);
  };

  // The rest of this file's commands — the menus, /stream, /logs, /waker and the others —
  // are not in a command module, so the loop above never reached them and a topic had no
  // menu at all. They answer through the routing proxy, so the same handler replies into
  // whichever topic it was called from.
  localHandlers.forEach(([regexp, handler]) => groupBot.onText(regexp, handler));
  localEvents.forEach(([event, handler]) => groupBot.on(event, handler));

  // Downstream code reads the chat id off the message to key state and to reply.
  // Swapping in the synthetic key here is what makes each topic its own session —
  // nothing further down has to change.
  const retarget = (chatHolder) => {
    if (!chatHolder || !chatHolder.chat) return;
    chatHolder.chat.id = chatKeyOf(chatHolder);
  };

  raw.on('message', (msg) => {
    // Before retarget swaps the chat id for the synthetic key, while the thread id and any
    // topic name are still on the message where this can read them.
    topics.remember(msg);
    retarget(msg);
    handleIncomingMessage(groupBot, msg);
  });

  raw.on('callback_query', (query) => {
    retarget(query.message);
    handleCallbackQuery(groupBot, query);
  });

  console.log('✅ Group bot (topic sessions) started');
}

// ===== Error handling =====
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

console.log('✅ Bot is ready!');

// Handed to scripts/qa.js so a test run can push updates through the same handlers
// Telegram would. Exporting costs nothing when the bot runs for real.
module.exports = { bot, groupBot, isAuthorized };

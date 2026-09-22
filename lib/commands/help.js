/**
 * Help Command - Knowledge Base
 * /help or /? - Browse documentation topics
 * /help <topic> - Get detailed help on a specific topic
 */

const fs = require('fs');
const path = require('path');

const DOCS_PATH = path.join(__dirname, '../../docs/COMMANDS.md');

// Topic definitions: keyword → section heading in COMMANDS.md
const TOPICS = [
  { key: 'start', aliases: ['getting started', 'setup', 'begin', 'first', 'defaults', 'config'], section: 'Getting Started', icon: '🚀', desc: 'Prerequisites, first steps, defaults' },
  { key: 'messages', aliases: ['send', 'chat', 'text', 'type', 'fast', 'photo', 'image', '-r', 'resume quick'], section: 'Sending Messages', icon: '💬', desc: 'Sending messages, photos, -r, /fast' },
  { key: 'sessions', aliases: ['session', 'resume', 'persist', 'new', 'browse', 'history'], section: 'Session Management', icon: '📚', desc: 'Session vs on-demand, browsing, persist' },
  { key: 'interactive', aliases: ['streaming', 'live', 'process', 'terminal', 'iterm'], section: 'Interactive Mode', icon: '⚡', desc: 'Live streaming, terminal display, status' },
  { key: 'modes', aliases: ['mode', 'permission', 'permissions', 'yolo', 'plan', 'default mode'], section: 'Permission Modes', icon: '🔐', desc: 'Default, fast, plan, yolo modes' },
  { key: 'voice', aliases: ['tts', 'speech', 'audio', 'edge', 'piper', 'google tts', 'setvoice', 'voicechunk', 'voicespeed'], section: 'Voice and TTS', icon: '🔊', desc: 'Voice modes, TTS engines, speed, chunking' },
  { key: 'projects', aliases: ['project', 'navigation', 'navigate', 'cd', 'pwd', 'browse folders', 'add project'], section: 'Project Navigation', icon: '📂', desc: 'Projects, browse, cd, pwd, add' },
  { key: 'git', aliases: ['status', 'branch', 'branches', 'repo', 'ls', 'tree', 'files'], section: 'Git Integration', icon: '🌿', desc: 'Git commands, file listing' },
  { key: 'parallel', aliases: ['perspectives', 'investigate', 'multi-agent', 'agents', 'cancelall'], section: 'Parallel Processing', icon: '🔀', desc: 'Perspectives, investigate, multi-agent' },
  { key: 'thought', aliases: ['thinking', 'thought mode', 'thought log', 'deep-link'], section: 'Thought Mode', icon: '🧠', desc: 'Thought logging modes (off/on/auto)' },
  { key: 'settings', aliases: ['menu', 'menus', 'quick settings', 'claude panel'], section: 'Settings and Menus', icon: '⚙️', desc: 'Settings panel, main menu, claude panel' },
  { key: 'askhistory', aliases: ['ask', 'ask history', 'history', 'search history', 'my history', 'past sessions search', 'שאל'], section: 'Ask History', icon: '✦', desc: 'Ask a question about your own past sessions' },
  { key: 'bookmarks', aliases: ['bookmark', 'save session'], section: 'Bookmarks', icon: '🔖', desc: 'Save and resume session bookmarks' },
  { key: 'pipe', aliases: ['attach', 'detach', 'live', 'live session', 'remote-telegram', 'claudegram', 'התלבש', 'pipe'], section: 'Live Session Pipe', icon: '🔗', desc: 'Drive a live session instead of resuming one' },
  { key: 'transfer', aliases: ['move', 'move to mac', 'mac', 'cli'], section: 'Session Transfer', icon: '🔄', desc: 'Move sessions between Telegram and Mac' },
  { key: 'system', aliases: ['restart', 'close', 'reset', 'cancel', 'logs', 'log'], section: 'System Commands', icon: '🛠', desc: 'Restart, close, reset, cancel, logs' },
  { key: 'styles', aliases: ['style', 'text style', 'voice style', 'formatting', 'textstyle', 'voiceresponse'], section: 'Text and Voice Styles', icon: '🎨', desc: 'Text and voice response styles' },
  { key: 'images', aliases: ['image', 'photo', 'analyze', 'picture', 'screenshot'], section: 'Image Analysis', icon: '📸', desc: 'Sending and analyzing images' },
  { key: 'troubleshooting', aliases: ['trouble', 'fix', 'stuck', 'error', 'problem', 'bug', 'not working'], section: 'Troubleshooting', icon: '🔧', desc: 'Common issues and solutions' },
];

let docsCache = null;
let docsCacheTime = 0;
const CACHE_TTL = 60000; // 1 minute

/**
 * Load and cache the docs file
 */
function loadDocs() {
  const now = Date.now();
  if (docsCache && (now - docsCacheTime) < CACHE_TTL) {
    return docsCache;
  }
  try {
    docsCache = fs.readFileSync(DOCS_PATH, 'utf-8');
    docsCacheTime = now;
    return docsCache;
  } catch (e) {
    return null;
  }
}

/**
 * Extract a section from the docs by its ## heading
 */
function extractSection(docs, sectionTitle) {
  // Find the ## heading
  const regex = new RegExp(`^## ${escapeRegex(sectionTitle)}\\s*$`, 'm');
  const match = regex.exec(docs);
  if (!match) return null;

  const startIdx = match.index;

  // Find the next ## heading (or end of file)
  const rest = docs.substring(startIdx + match[0].length);
  const nextSection = rest.match(/^## /m);
  const endIdx = nextSection ? startIdx + match[0].length + nextSection.index : docs.length;

  let content = docs.substring(startIdx, endIdx).trim();

  // Telegram has a 4096 char limit per message
  if (content.length > 4000) {
    content = content.substring(0, 3950) + '\n\n_(truncated - full docs in docs/COMMANDS.md)_';
  }

  return content;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find matching topic from user input
 */
function findTopic(query) {
  const q = query.toLowerCase().trim();

  // Exact key match
  const exact = TOPICS.find(t => t.key === q);
  if (exact) return exact;

  // Alias match
  const aliasMatch = TOPICS.find(t => t.aliases.some(a => a === q));
  if (aliasMatch) return aliasMatch;

  // Partial match on key, aliases, section name, or description
  const partial = TOPICS.find(t =>
    t.key.includes(q) ||
    t.aliases.some(a => a.includes(q)) ||
    t.section.toLowerCase().includes(q) ||
    t.desc.toLowerCase().includes(q)
  );
  if (partial) return partial;

  // Fuzzy: check if query words appear in any topic
  const words = q.split(/\s+/);
  const fuzzy = TOPICS.find(t => {
    const haystack = [t.key, ...t.aliases, t.section.toLowerCase(), t.desc.toLowerCase()].join(' ');
    return words.every(w => haystack.includes(w));
  });

  return fuzzy || null;
}

/**
 * Format the topic list message with inline buttons
 */
function buildTopicList() {
  let text = '📖 *Help Topics*\n\nTap a topic or type `/help <topic>`:\n';

  // Build inline keyboard - 2 per row
  const keyboard = [];
  for (let i = 0; i < TOPICS.length; i += 2) {
    const row = [{ text: `${TOPICS[i].icon} ${TOPICS[i].section}`, callback_data: `help:${TOPICS[i].key}` }];
    if (i + 1 < TOPICS.length) {
      row.push({ text: `${TOPICS[i + 1].icon} ${TOPICS[i + 1].section}`, callback_data: `help:${TOPICS[i + 1].key}` });
    }
    keyboard.push(row);
  }

  // Add "All Commands" button at the bottom
  keyboard.push([{ text: '📋 All Commands List', callback_data: 'help:all_commands' }]);

  return { text, keyboard };
}

/**
 * Send a topic's content
 */
function sendTopic(bot, chatId, topic, messageId) {
  const docs = loadDocs();
  if (!docs) {
    const errMsg = 'Could not load documentation file.';
    if (messageId) {
      bot.editMessageText(errMsg, { chat_id: chatId, message_id: messageId });
    } else {
      bot.sendMessage(chatId, errMsg);
    }
    return;
  }

  const content = extractSection(docs, topic.section);
  if (!content) {
    const errMsg = `Section "${topic.section}" not found in docs.`;
    if (messageId) {
      bot.editMessageText(errMsg, { chat_id: chatId, message_id: messageId });
    } else {
      bot.sendMessage(chatId, errMsg);
    }
    return;
  }

  // Convert markdown headers for Telegram (## → bold, ### → bold)
  let telegramText = content
    .replace(/^### (.+)$/gm, '*$1*')
    .replace(/^## (.+)$/gm, '📖 *$1*');

  // Telegram Markdown doesn't support tables well - convert simple tables to plain text
  // Keep tables as-is in code blocks, just clean up pipe formatting outside
  telegramText = telegramText.replace(/^\|[-:|  ]+\|$/gm, ''); // remove separator rows

  // Add back button
  const opts = {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '⬅️ All Topics', callback_data: 'help:topics' },
        { text: '📋 Commands', callback_data: 'help:all_commands' }
      ]]
    }
  };

  if (messageId) {
    bot.editMessageText(telegramText, { chat_id: chatId, message_id: messageId, ...opts });
  } else {
    bot.sendMessage(chatId, telegramText, opts);
  }
}

/**
 * Register help commands
 */
function register(bot, isAuthorized) {
  // Match /help, /?, /help <topic>, /? <topic>
  bot.onText(/\/(help|\?)(?:\s+(.+))?$/, (msg, match) => {
    if (!isAuthorized(msg)) return;

    const chatId = msg.chat.id;
    const query = match[2]; // optional topic argument

    if (!query) {
      // No topic - show topic list with buttons
      const { text, keyboard } = buildTopicList();
      bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
      return;
    }

    // Find the topic
    const topic = findTopic(query);
    if (!topic) {
      // No match - show topic list with hint
      const { text, keyboard } = buildTopicList();
      bot.sendMessage(chatId, `No topic found for "${query}".\n\n${text}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
      return;
    }

    sendTopic(bot, chatId, topic);
  });
}

/**
 * Handle callback queries for help buttons
 */
function handleCallback(bot, query, userState) {
  const data = query.data;
  if (!data.startsWith('help:')) return false;

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const action = data.substring(5); // after 'help:'

  bot.answerCallbackQuery(query.id);

  if (action === 'topics') {
    // Show topic list
    const { text, keyboard } = buildTopicList();
    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    return true;
  }

  if (action === 'all_commands') {
    // Send the /all command content
    const { getUserState } = require('../state');
    const us = getUserState(chatId);
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
/help - Help topics
/menu - Interactive menu
/settings - Quick settings
/askhistory - Ask your own past sessions
/bookmark - Save session
/restart - Restart bot

📍 *${us.currentProject || 'Home'}*`;

    bot.editMessageText(allCommands, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '⬅️ Help Topics', callback_data: 'help:topics' }
        ]]
      }
    });
    return true;
  }

  // Topic button pressed
  const topic = TOPICS.find(t => t.key === action);
  if (topic) {
    sendTopic(bot, chatId, topic, messageId);
    return true;
  }

  return false;
}

module.exports = { register, handleCallback };

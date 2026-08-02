/**
 * Claude Commands
 * Message handling, streaming, sessions, modes
 */

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getUserState, scheduleSave } = require('../state');
const {
  getSession, setSession, clearSession, incrementSession,
  getSessionHistory, getSessionByShortId, resumeSession, clearHistory,
  getCliSessions, getCliProjects, findSessionProjectPath, stripInjectedDirectives
} = require('../sessions');
const { sendLongMessage, getModeFlag, formatForTelegram, sendMessageSafe, editMessageSafe } = require('../utils');
const { generateVoice, generateVoiceChunked } = require('../tts');
const { MODE_DESCRIPTIONS, TEXT_STYLE_OPTIONS, VOICE_STYLE_OPTIONS, TTS_ENGINES, CLAUDE_BIN_PATH, BOT_DIR } = require('../config');
const unifiedSessions = require('../unified-sessions');
const sessionMeta = require('../session-meta');
const aiTitle = require('../ai-title');

// Default session wired to the permanent "resume pinned" button.
// Used until the user re-pins a different session via /pin.
const DEFAULT_PINNED_SESSION = {
  id: '68a85efb-eb06-47b4-a477-72d457236e0f',
  projectPath: '/Users/amosdabush',
  topic: '(pinned session)'
};

// Store pending process logs for clickable display
const pendingLogs = new Map();

// Clean up old logs periodically (keep for 10 minutes)
setInterval(() => {
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  for (const [key] of pendingLogs) {
    const timestamp = parseInt(key.split('_')[1]);
    if (timestamp < tenMinutesAgo) {
      pendingLogs.delete(key);
    }
  }
}, 60 * 1000);

/**
 * Register Claude commands
 */
function register(bot, isAuthorized) {

  // /new - start fresh session
  bot.onText(/\/new/, (msg) => {
    if (!isAuthorized(msg)) return;
    clearSession(msg.chat.id);
    bot.sendMessage(msg.chat.id, '🆕 Started fresh session. Claude won\'t remember previous messages.');
  });

  // Handle /start commands (deep links) - t, v, tools, status, fulllog
  bot.onText(/\/start (t|v|tools|status|fulllog)$/, async (msg, match) => {
    console.log(`[/start] Received: ${msg.text}`);
    if (!isAuthorized(msg)) return;
    const chatId = msg.chat.id;
    const cmd = match[1];
    console.log(`[/start] Command: ${cmd}, chat: ${chatId}`);

    if (cmd === 't' || cmd === 'status') {
      // Show status log (what was displayed during processing)
      const log = pendingLogs.get(`status_${chatId}`) || pendingLogs.get(`log_${chatId}`);
      if (!log || log.length === 0) {
        bot.sendMessage(chatId, '❌ No status log available');
        return;
      }
      const logLines = log.map((step, i) => `${i + 1}. ${step}`).join('\n');
      const logText = `📝 *Status:*\n\`\`\`\n${logLines}\n\`\`\``;
      if (logText.length <= 4000) {
        bot.sendMessage(chatId, logText, { parse_mode: 'Markdown' });
      } else {
        const buffer = Buffer.from(logLines, 'utf-8');
        bot.sendDocument(chatId, buffer, { caption: '📝 Status' }, { filename: 'status.txt', contentType: 'text/plain' });
      }
    } else if (cmd === 'tools') {
      // Show tools log
      const log = pendingLogs.get(`tools_${chatId}`);
      if (!log || log.length === 0) {
        bot.sendMessage(chatId, '❌ No tools log available');
        return;
      }
      const logLines = log.map((step, i) => `${i + 1}. ${step}`).join('\n');
      const logText = `🔧 *Tools:*\n\`\`\`\n${logLines}\n\`\`\``;
      if (logText.length <= 4000) {
        bot.sendMessage(chatId, logText, { parse_mode: 'Markdown' });
      } else {
        const buffer = Buffer.from(logLines, 'utf-8');
        bot.sendDocument(chatId, buffer, { caption: '🔧 Tools' }, { filename: 'tools.txt', contentType: 'text/plain' });
      }
    } else if (cmd === 'fulllog') {
      // Show full process log as text
      const log = pendingLogs.get(`fulllog_${chatId}`);
      if (!log || log.length === 0) {
        bot.sendMessage(chatId, '❌ No process log available');
        return;
      }
      // Format each entry as readable text
      const logLines = log.map((entry, i) => {
        let line = `${i + 1}. [${entry.type}${entry.subtype ? ':' + entry.subtype : ''}]`;
        if (entry.blocks) {
          for (const block of entry.blocks) {
            if (block.type === 'text' && block.text) {
              line += `\n   📝 ${block.text.substring(0, 100)}${block.text.length > 100 ? '...' : ''}`;
            } else if (block.type === 'tool_use') {
              line += `\n   🔧 ${block.name}: ${block.input?.substring(0, 80) || ''}`;
            } else if (block.type === 'tool_result') {
              line += `\n   ✅ result`;
            } else if (block.thinking) {
              line += `\n   🧠 ${block.thinking.substring(0, 80)}...`;
            }
          }
        }
        if (entry.result) {
          line += `\n   → ${entry.result.substring(0, 100)}${entry.result.length > 100 ? '...' : ''}`;
        }
        return line;
      }).join('\n\n');

      const logText = `📋 *Full Process Log:*\n\`\`\`\n${logLines}\n\`\`\``;
      if (logText.length <= 4000) {
        bot.sendMessage(chatId, logText, { parse_mode: 'Markdown' });
      } else {
        const buffer = Buffer.from(logLines, 'utf-8');
        bot.sendDocument(chatId, buffer, { caption: '📋 Full Process Log' }, { filename: 'process.txt', contentType: 'text/plain' });
      }
    } else if (cmd === 'v') {
      // Generate voice
      const text = pendingLogs.get(`voice_${chatId}`);
      if (!text) {
        bot.sendMessage(chatId, '❌ No text available for voice');
        return;
      }
      await generateVoiceResponseWithChunking(bot, chatId, text);
    }
  });

  // Helper function for voice generation - uses sendVoiceResponse for chunking support
  async function generateVoiceResponseWithChunking(bot, chatId, text) {
    console.log(`[Voice] Starting for chat ${chatId}, text length: ${text?.length}`);
    const userState = getUserState(chatId);

    // Clean text for TTS
    const cleanText = text
      .replace(/```[\s\S]*?```/g, '')           // Remove code blocks
      .replace(/`[^`]+`/g, '')                   // Remove inline code
      .replace(/\*\*([^*]+)\*\*/g, '$1')         // Bold to plain
      .replace(/\*([^*]+)\*/g, '$1')             // Italic to plain
      .replace(/#+\s*/g, '')                      // Remove headers
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // Links to text
      .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]|[\u{1F100}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]|[\u{231A}-\u{231B}]|[\u{23E9}-\u{23F3}]|[\u{23F8}-\u{23FA}]|[\u{25AA}-\u{25AB}]|[\u{25B6}]|[\u{25C0}]|[\u{25FB}-\u{25FE}]|[\u{2614}-\u{2615}]|[\u{2648}-\u{2653}]|[\u{267F}]|[\u{2693}]|[\u{26A1}]|[\u{26AA}-\u{26AB}]|[\u{26BD}-\u{26BE}]|[\u{26C4}-\u{26C5}]|[\u{26CE}]|[\u{26D4}]|[\u{26EA}]|[\u{26F2}-\u{26F3}]|[\u{26F5}]|[\u{26FA}]|[\u{26FD}]|[\u{2702}]|[\u{2705}]|[\u{2708}-\u{270D}]|[\u{270F}]|[\u{2712}]|[\u{2714}]|[\u{2716}]|[\u{271D}]|[\u{2721}]|[\u{2728}]|[\u{2733}-\u{2734}]|[\u{2744}]|[\u{2747}]|[\u{274C}]|[\u{274E}]|[\u{2753}-\u{2755}]|[\u{2757}]|[\u{2763}-\u{2764}]|[\u{2795}-\u{2797}]|[\u{27A1}]|[\u{27B0}]|[\u{27BF}]|[\u{2934}-\u{2935}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|[\u{2B50}]|[\u{2B55}]|[\u{3030}]|[\u{303D}]|[\u{3297}]|[\u{3299}]/gu, '')  // Remove emojis
      .replace(/\s+/g, ' ')                       // Normalize whitespace
      .trim();

    console.log(`[Voice] Clean text length: ${cleanText.length}`);

    if (cleanText.length < 5) {
      bot.sendMessage(chatId, '❌ Text too short for voice');
      return;
    }

    // Use sendVoiceResponse which supports chunking
    await sendVoiceResponse(bot, chatId, cleanText, userState);
  }

  // /t or /get_thought - show last thought process log
  bot.onText(/\/(t|get_thought)$/, async (msg) => {
    if (!isAuthorized(msg)) return;
    const chatId = msg.chat.id;
    const log = pendingLogs.get(`log_${chatId}`);

    if (!log || log.length === 0) {
      bot.sendMessage(chatId, '❌ No thought log available');
      return;
    }

    const logLines = log.map((step, i) => `${i + 1}. ${step}`).join('\n');
    const logText = `🧠 *Thought Process:*\n\`\`\`\n${logLines}\n\`\`\``;

    if (logText.length <= 4000) {
      bot.sendMessage(chatId, logText, { parse_mode: 'Markdown' });
    } else {
      const buffer = Buffer.from(logLines, 'utf-8');
      bot.sendDocument(chatId, buffer, { caption: '🧠 Thought Process' }, { filename: 'thought.txt', contentType: 'text/plain' });
    }
  });

  // /v or /get_voice - generate voice from last response
  bot.onText(/\/(v|get_voice)$/, async (msg) => {
    console.log(`[/v] Received: ${msg.text}`);
    if (!isAuthorized(msg)) return;
    const chatId = msg.chat.id;
    const text = pendingLogs.get(`voice_${chatId}`);
    console.log(`[/v] Text from pendingLogs: ${text ? text.substring(0, 50) + '...' : 'NULL'}`);

    if (!text) {
      bot.sendMessage(chatId, '❌ No text available for voice');
      return;
    }

    await generateVoiceResponse(bot, chatId, text);
  });

  // /session - toggle session mode
  bot.onText(/\/session(?:\s+(on|off))?/, (msg, match) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const arg = match[1]?.toLowerCase();

    if (arg === 'on') {
      userState.sessionMode = true;
      scheduleSave();
      bot.sendMessage(msg.chat.id, '💬 *Session mode enabled*\nMessages will continue conversation. Use /new to start fresh.', { parse_mode: 'Markdown' });
      return;
    }

    if (arg === 'off') {
      userState.sessionMode = false;
      clearSession(msg.chat.id);
      scheduleSave();
      bot.sendMessage(msg.chat.id, '⚡ *On-demand mode enabled*\nEach message is independent.', { parse_mode: 'Markdown' });
      return;
    }

    // Show current mode with buttons
    const session = getSession(msg.chat.id);
    const modeIcon = userState.sessionMode ? '💬' : '⚡';
    const modeName = userState.sessionMode ? 'Session' : 'On-Demand';

    let statusText = `⚙️ *Conversation Mode*\n\nCurrent: ${modeIcon} *${modeName}*\n`;

    if (userState.sessionMode && session) {
      statusText += `\n📍 Active session:\n`;
      statusText += `ID: \`${session.sessionId.substring(0, 8)}...\`\n`;
      statusText += `Messages: ${session.messageCount}\n`;
    } else if (userState.sessionMode) {
      statusText += `\nNo active session yet. Send a message to start one.\n`;
    }

    statusText += `\n⚡ On-demand = each message independent\n💬 Session = Claude remembers context`;

    const keyboard = [[
      { text: userState.sessionMode ? '⚡ Switch to On-Demand' : '✓ ⚡ On-Demand', callback_data: 'session:off' },
      { text: userState.sessionMode ? '✓ 💬 Session' : '💬 Switch to Session', callback_data: 'session:on' }
    ]];

    bot.sendMessage(msg.chat.id, statusText, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  });

  // /sessions - list past sessions
  bot.onText(/\/sessions/, (msg) => {
    if (!isAuthorized(msg)) return;
    sendSessionsMenu(bot, msg.chat.id);
  });

  // /mode - switch permission mode
  bot.onText(/\/mode/, (msg) => {
    if (!isAuthorized(msg)) return;
    sendModeMenu(bot, msg.chat.id, getUserState(msg.chat.id));
  });

  // /model - switch the Claude model (resumes the current session on the new model)
  bot.onText(/\/model/, (msg) => {
    if (!isAuthorized(msg)) return;
    sendModelMenu(bot, msg.chat.id, getUserState(msg.chat.id));
  });

  // /cancel - cancel current request
  bot.onText(/\/cancel/, (msg) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);

    if (userState.currentClaudeProc) {
      userState.currentClaudeProc.kill();
      userState.currentClaudeProc = null;
      userState.isProcessing = false;
      bot.sendMessage(msg.chat.id, '🛑 Cancelled your request');
    } else if (userState.isProcessing) {
      userState.isProcessing = false;
      bot.sendMessage(msg.chat.id, '🔄 Reset processing state');
    } else {
      bot.sendMessage(msg.chat.id, '✅ Nothing to cancel');
    }
  });

  // /persist - toggle session persistence across bot restarts
  bot.onText(/\/persist(?:\s+(on|off))?/, (msg, match) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const arg = match[1]?.toLowerCase();

    if (arg === 'on') {
      userState.persistSession = true;
      scheduleSave();
      bot.sendMessage(msg.chat.id, '💾 *Session persistence enabled*\nYour active session will survive bot restarts.', { parse_mode: 'Markdown' });
      return;
    }

    if (arg === 'off') {
      userState.persistSession = false;
      scheduleSave();
      bot.sendMessage(msg.chat.id, '🔄 *Session persistence disabled*\nBot restarts will start a fresh session.', { parse_mode: 'Markdown' });
      return;
    }

    // Show current status with toggle buttons
    const session = getSession(msg.chat.id);
    const persistIcon = userState.persistSession ? '💾' : '🔄';
    const persistName = userState.persistSession ? 'ON' : 'OFF';

    let statusText = `💾 *Session Persistence*\n\nCurrent: ${persistIcon} *${persistName}*\n`;

    if (userState.persistSession) {
      statusText += `\nYour active session will be restored after bot restarts.\n`;
      if (session) {
        statusText += `\n📍 Active session: \`${session.sessionId.substring(0, 8)}...\``;
      }
    } else {
      statusText += `\nBot restarts will start a fresh session.\n`;
    }

    const keyboard = [[
      { text: userState.persistSession ? '🔄 Disable' : '💾 Enable', callback_data: userState.persistSession ? 'persist:off' : 'persist:on' }
    ]];

    bot.sendMessage(msg.chat.id, statusText, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  });

  // /fast <question> - quick answer without file tools
  bot.onText(/\/fast\s+(.+)/, async (msg, match) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const question = match[1].trim();

    if (userState.isProcessing) {
      bot.sendMessage(msg.chat.id, '⏳ Already processing. Use /cancel first.');
      return;
    }

    userState.isProcessing = true;
    bot.sendChatAction(msg.chat.id, 'typing');

    try {
      const response = await runClaude(question, userState.currentPath, true, userState.currentMode);
      await sendLongMessage(bot, msg.chat.id, `⚡ ${response}`, msg.message_id);
    } catch (error) {
      bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`, { reply_to_message_id: msg.message_id });
    } finally {
      userState.isProcessing = false;
    }
  });

  // /interactive - toggle interactive mode
  bot.onText(/\/interactive(?:\s+(on|off))?/, (msg, match) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const arg = match[1]?.toLowerCase();

    if (arg === 'on') {
      userState.interactiveMode = true;
      scheduleSave();
      bot.sendMessage(msg.chat.id, '🔄 *Interactive mode enabled*\nClaude will run as persistent process.', { parse_mode: 'Markdown' });
      return;
    }

    if (arg === 'off') {
      stopInteractiveSession(userState);
      userState.interactiveMode = false;
      scheduleSave();
      bot.sendMessage(msg.chat.id, '⚡ *Interactive mode disabled*\nEach message spawns new process.', { parse_mode: 'Markdown' });
      return;
    }

    // Show current mode with buttons
    const modeIcon = userState.interactiveMode ? '🔄' : '⚡';
    const modeName = userState.interactiveMode ? 'ON' : 'OFF';
    const procStatus = userState.interactiveProc ? '(process running)' : '(no process)';

    const keyboard = [[
      { text: userState.interactiveMode ? '⚡ Turn OFF' : '🔄 Turn ON', callback_data: userState.interactiveMode ? 'interactive:off' : 'interactive:on' }
    ]];

    bot.sendMessage(msg.chat.id,
      `🔄 *Interactive Mode*\n\nCurrent: ${modeIcon} *${modeName}* ${procStatus}\n\n` +
      `ON = Claude runs persistently, handles context\n` +
      `OFF = Each message spawns new process`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
  });

  // /terminal - toggle visible iTerm window
  bot.onText(/\/terminal(?:\s+(on|off))?/, (msg, match) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const arg = match[1]?.toLowerCase();

    if (arg === 'on') {
      userState.showTerminal = true;
      scheduleSave();
      // If interactive session running, restart it with terminal
      if (userState.interactiveProc) {
        stopInteractiveSession(userState);
        startInteractiveSession(userState, msg.chat.id, bot);
      }
      bot.sendMessage(msg.chat.id, '🖥 *Terminal mode enabled*\nClaude will open in visible iTerm window.', { parse_mode: 'Markdown' });
      return;
    }

    if (arg === 'off') {
      userState.showTerminal = false;
      scheduleSave();
      // If interactive session running, restart it without terminal
      if (userState.interactiveProc) {
        stopInteractiveSession(userState);
        startInteractiveSession(userState, msg.chat.id, bot);
      }
      bot.sendMessage(msg.chat.id, '🔇 *Terminal mode disabled*\nClaude runs in background.', { parse_mode: 'Markdown' });
      return;
    }

    // Show current mode with buttons
    const modeIcon = userState.showTerminal ? '🖥' : '🔇';
    const modeName = userState.showTerminal ? 'iTerm' : 'Background';

    const keyboard = [[
      { text: userState.showTerminal ? '🔇 Background' : '🖥 iTerm', callback_data: userState.showTerminal ? 'terminal:off' : 'terminal:on' }
    ]];

    bot.sendMessage(msg.chat.id,
      `🖥 *Terminal Display*\n\nCurrent: ${modeIcon} *${modeName}*\n\n` +
      `iTerm = See Claude working in visible window\n` +
      `Background = Runs silently, output to Telegram only`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
  });

  // /thought - toggle thought process log (off/on/auto)
  bot.onText(/\/thought(?:\s+(off|on|auto))?/, (msg, match) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const arg = match[1]?.toLowerCase();

    if (arg === 'auto') {
      userState.thoughtMode = 'auto';
      scheduleSave();
      bot.sendMessage(msg.chat.id, '🧠 *Thought log: AUTO*\nThought process will show automatically after each response.', { parse_mode: 'Markdown' });
      return;
    }

    if (arg === 'on') {
      userState.thoughtMode = 'on';
      scheduleSave();
      bot.sendMessage(msg.chat.id, '🧠 *Thought log: ON*\nClick the tools button to view thought process.', { parse_mode: 'Markdown' });
      return;
    }

    if (arg === 'off') {
      userState.thoughtMode = 'off';
      scheduleSave();
      bot.sendMessage(msg.chat.id, '🔇 *Thought log: OFF*', { parse_mode: 'Markdown' });
      return;
    }

    // Show current mode with buttons
    const mode = userState.thoughtMode || 'off';
    const modeIcons = { off: '🔇', on: '🧠', auto: '✨' };
    const modeNames = { off: 'OFF', on: 'ON (button)', auto: 'AUTO' };

    const keyboard = [
      [
        { text: mode === 'off' ? '✓ 🔇 Off' : '🔇 Off', callback_data: 'thought:off' },
        { text: mode === 'on' ? '✓ 🧠 On' : '🧠 On', callback_data: 'thought:on' },
        { text: mode === 'auto' ? '✓ ✨ Auto' : '✨ Auto', callback_data: 'thought:auto' }
      ]
    ];

    bot.sendMessage(msg.chat.id,
      `🧠 *Thought Process Log*\n\nCurrent: ${modeIcons[mode]} *${modeNames[mode]}*\n\n` +
      `🔇 *Off* - No thought log\n` +
      `🧠 *On* - Click button to view\n` +
      `✨ *Auto* - Shows automatically`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
  });

  // /resume - show session picker (like Claude CLI)
  // Anchored so it won't also fire on /resume_pinned.
  bot.onText(/\/resume$/, (msg) => {
    if (!isAuthorized(msg)) return;
    sendSessionsMenu(bot, msg.chat.id);
  });

  // /resume_pinned - one-tap resume of a fixed, pinned session (no picker)
  bot.onText(/\/resume_pinned$/, (msg) => {
    if (!isAuthorized(msg)) return;
    const chatId = msg.chat.id;
    const userState = getUserState(chatId);

    const pinned = userState.pinnedSession || DEFAULT_PINNED_SESSION;
    const targetId = pinned.id;
    const originPath = findSessionProjectPath(targetId) || pinned.projectPath;

    if (!targetId || !originPath || !fs.existsSync(originPath)) {
      bot.sendMessage(chatId,
        `⚠️ Can't resume the pinned session \`${String(targetId || '?').slice(0, 8)}\` — its folder is missing.\nPin a live one with /pin.`,
        { parse_mode: 'Markdown' });
      return;
    }

    stopInteractiveSession(userState);
    userState.currentPath = originPath;
    userState.currentProject = path.basename(originPath);
    userState.sessionMode = true;
    scheduleSave();

    const session = unifiedSessions.findSession(targetId);
    const topic = session?.topic || pinned.topic || '(pinned session)';
    const messageCount = session?.messageCount ?? 0;
    const modeIcon = unifiedSessions.getModeIcon(session?.mode);

    setSession(chatId, targetId, originPath, topic);
    unifiedSessions.updateSession(targetId, { lastUsed: new Date().toISOString() });

    if (userState.interactiveMode) {
      const started = startInteractiveSession(userState, chatId, bot, targetId);
      if (!started) return;
      bot.sendMessage(chatId,
        `📌 *Resuming pinned session*\n\n` +
        `📝 Topic: ${topic}\n` +
        `📁 Project: *${userState.currentProject}*\n` +
        `💬 Messages: ${messageCount} ${modeIcon}\n\n` +
        `Interactive session started with --resume.`,
        { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId,
        `📌 *Pinned session resumed*\n\n` +
        `📝 Topic: ${topic}\n` +
        `📁 Project: *${userState.currentProject}*\n` +
        `💬 Messages: ${messageCount} ${modeIcon}\n\n` +
        `Type your next message to continue.`,
        { parse_mode: 'Markdown' });
    }
  });

  // /pin [id] - wire the current (or a given) session to the permanent resume button
  bot.onText(/\/pin(?:\s+(\S+))?$/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const chatId = msg.chat.id;
    const userState = getUserState(chatId);

    let targetId = match && match[1] ? match[1].trim() : null;
    let originPath = null;

    if (targetId) {
      originPath = findSessionProjectPath(targetId);
      if (!originPath) {
        bot.sendMessage(chatId, `❌ No session with id \`${targetId.slice(0, 8)}\` found on this Mac.`, { parse_mode: 'Markdown' });
        return;
      }
    } else {
      const current = getSession(chatId);
      if (!current) {
        bot.sendMessage(chatId, '❌ No active session to pin. Open one first, then /pin.');
        return;
      }
      targetId = current.sessionId;
      originPath = current.projectPath || findSessionProjectPath(targetId);
    }

    const session = unifiedSessions.findSession(targetId);
    userState.pinnedSession = {
      id: targetId,
      projectPath: originPath,
      topic: session?.topic || getSession(chatId)?.topic || '(pinned session)'
    };
    scheduleSave();

    bot.sendMessage(chatId,
      `📌 *Pinned!*\n\n` +
      `This session is now wired to the permanent resume button.\n\n` +
      `🆔 \`${String(targetId).slice(0, 8)}\`\n` +
      `📁 *${path.basename(originPath)}*`,
      { parse_mode: 'Markdown' });
  });

  // /move_to_mac - show resume command for current session
  bot.onText(/\/move_to_mac/, (msg) => {
    if (!isAuthorized(msg)) return;
    const chatId = msg.chat.id;
    const userState = getUserState(chatId);
    const currentSession = getSession(chatId);

    if (!currentSession) {
      bot.sendMessage(chatId, '❌ No active session to move');
      return;
    }

    const uSession = unifiedSessions.findSession(currentSession.sessionId);
    const flags = uSession?.flags?.join(' ') || getModeFlag(userState.currentMode) || '';
    const resumeCmd = `cd "${currentSession.projectPath}" && claude --resume '${currentSession.sessionId}' ${flags}`.trim();

    bot.sendMessage(chatId,
      `🖥 *Session ready on Mac!*\n\n` +
      `*Topic:* ${currentSession.topic || '(none)'}\n` +
      `*Path:* \`${currentSession.projectPath}\`\n` +
      `*Mode:* ${userState.currentMode}\n\n` +
      `*Run this command:*\n\`\`\`bash\n${resumeCmd}\n\`\`\``,
      { parse_mode: 'Markdown' }
    );
  });
}

/**
 * Send sessions menu - shows unified sessions from both Telegram and CLI
 */
function sendSessionsMenu(bot, chatId, showCliSessions = true) {
  const { getUserState } = require('../state');
  const userState = getUserState(chatId);

  // Sync CLI sessions on-demand before showing
  try { require('../../scripts/watch-cli-sessions'); } catch (e) {}

  const allSessions = unifiedSessions.getAllSessions();
  const telegramSessions = allSessions.filter(s => s.source === 'telegram');
  const cliSessions = allSessions.filter(s => s.source === 'cli');

  // Also check local bot history for sessions not yet in unified registry
  const history = getSessionHistory(chatId);
  for (const h of history) {
    if (!allSessions.find(s => s.id === h.sessionId)) {
      // Add missing bot sessions to unified registry
      unifiedSessions.addSession({
        id: h.sessionId,
        source: 'telegram',
        sourceId: chatId.toString(),
        topic: h.topic,
        projectPath: h.projectPath,
        mode: 'default',
        flags: [],
        messageCount: h.messageCount,
        createdAt: h.startedAt,
        lastUsed: h.startedAt
      });
    }
  }

  // Re-fetch after potential additions, then hide archived from the main list
  const finalSessions = unifiedSessions.getAllSessions();
  const archivedSet = sessionMeta.archivedIds();
  const finalTelegram = finalSessions.filter(s => s.source === 'telegram' && !archivedSet.has(s.id));
  const finalCli = finalSessions.filter(s => s.source === 'cli' && !archivedSet.has(s.id));
  const archivedCount = finalSessions.filter(s => archivedSet.has(s.id)).length;

  if (finalTelegram.length === 0 && finalCli.length === 0 && archivedCount === 0) {
    bot.sendMessage(chatId, '📭 No session history yet.\nStart a conversation or check Mac CLI sessions.', {
      reply_markup: {
        inline_keyboard: [[{ text: '📂 Browse All Projects', callback_data: 'clibrowse:list' }]]
      }
    });
    return;
  }

  const keyboard = [];

  // Show Telegram sessions — tapping opens the management card, not an instant resume
  if (finalTelegram.length > 0) {
    keyboard.push([{ text: '📱 Telegram Sessions', callback_data: 'noop' }]);

    for (let i = 0; i < Math.min(finalTelegram.length, 10); i++) {
      const s = finalTelegram[i];
      const title = resolveTitle(s);
      const timeAgo = unifiedSessions.formatTimeAgo(s.lastUsed);
      const modeIcon = unifiedSessions.getModeIcon(s.mode);

      keyboard.push([{
        text: `📱 ${title.substring(0, 30)}${title.length > 30 ? '…' : ''} ${modeIcon} (${timeAgo})`,
        callback_data: `sd:${s.id.substring(0, 8)}`
      }]);
    }
  }

  // Show CLI sessions
  if (finalCli.length > 0) {
    keyboard.push([{ text: '🖥 Terminal Sessions', callback_data: 'noop' }]);

    for (let i = 0; i < Math.min(finalCli.length, 10); i++) {
      const s = finalCli[i];
      const project = path.basename(s.projectPath);
      const title = resolveTitle(s);
      const timeAgo = unifiedSessions.formatTimeAgo(s.lastUsed);

      keyboard.push([{
        text: `🖥 ${project} · ${title.substring(0, 22)}${title.length > 22 ? '…' : ''} (${timeAgo})`,
        callback_data: `sd:${s.id.substring(0, 8)}`
      }]);
    }
  }

  // Action buttons
  if (archivedCount > 0) {
    keyboard.push([{ text: `🗄 Archived (${archivedCount})`, callback_data: 'sarclist' }]);
  }
  keyboard.push([{ text: '📂 Browse All Projects', callback_data: 'clibrowse:list' }]);
  keyboard.push([{ text: '🗑 Clear Telegram History', callback_data: 'resume:clear' }]);

  const headerText = `📋 *All Sessions*\n\n` +
    `📱 Telegram (${finalTelegram.length}) · 🖥 Terminal (${finalCli.length})\n\n` +
    `Tap a session to manage it:`;

  bot.sendMessage(chatId, headerText, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });

  // Kick off local AI titling in the background for anything not yet cached —
  // next time the list opens, the smart names are already there.
  aiTitle.enqueue([...finalTelegram.slice(0, 10), ...finalCli.slice(0, 10)]);
}

/**
 * Resolve the display title for a session.
 * Layers: manual note (wins) → [AI title, added later] → cleaned first message.
 */
function resolveTitle(session) {
  if (!session) return '(no topic)';
  const note = sessionMeta.getNote(session.id);
  if (note) return note;
  const ai = aiTitle.getCached(session.id, session.lastUsed);
  if (ai) return ai;
  return session.topic || '(no topic)';
}

/**
 * Session management card — the inner menu for one session.
 * Shows metadata + actions (resume / note / archive / move-to-mac), mirroring
 * what the sessions Web UI offers, but inside Telegram.
 */
/**
 * Read the last N real messages (human + Claude text) from a session's jsonl,
 * stripping tool noise and injected style/voice directives — same idea as the
 * Web UI quick-peek, so you can glance before resuming.
 */
// Resolve a session's jsonl on disk. Prefer scanning by id (robust even when the
// registry's projectPath drifted), fall back to the encoded projectPath.
function resolveSessionFile(session) {
  const projectsDir = path.join(require('os').homedir(), '.claude', 'projects');
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const fp = path.join(projectsDir, dir, session.id + '.jsonl');
      if (fs.existsSync(fp)) return fp;
    }
  } catch (e) {}
  const encoded = (session.projectPath || '').replace(/\//g, '-');
  const fp = path.join(projectsDir, encoded, session.id + '.jsonl');
  return fs.existsSync(fp) ? fp : null;
}

// Read ALL real messages (human + Claude text) from a session's jsonl, stripping
// tool noise and injected style/voice directives — same idea as the Web UI peek.
function readSessionMessages(session) {
  try {
    const file = resolveSessionFile(session);
    if (!file) return [];
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
    const msgs = [];
    for (const line of lines) {
      let e; try { e = JSON.parse(line); } catch (err) { continue; }
      if (e.isSidechain) continue;
      if (e.type !== 'user' && e.type !== 'assistant') continue;
      const c = e.message && e.message.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) text = c.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join(' ');
      if (/\\u[0-9a-fA-F]{4}/.test(text)) {
        try { text = text.replace(/\\u[0-9a-fA-F]{4}/g, m => String.fromCharCode(parseInt(m.slice(2), 16))); } catch (err) {}
      }
      text = stripInjectedDirectives(text);
      text = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (/^(Caveat:|API Error|\[Request interrupted|\[SYSTEM NOTIFICATION)/.test(text)) continue;
      msgs.push({ role: e.type, text });
    }
    return msgs;
  } catch (e) { return []; }
}

function getSessionLastMessages(session, n = 4) {
  return readSessionMessages(session).slice(-n);
}

/**
 * Send a quick preview of a session's last few messages (plain text, no
 * markdown parsing so message bodies can't break formatting).
 */
function sendSessionPreview(bot, chatId, shortId) {
  const s = unifiedSessions.findSessionByShortId(shortId);
  if (!s) { bot.sendMessage(chatId, '❌ Session not found.'); return; }
  const title = (sessionMeta.getNote(s.id) || s.topic || 'session').substring(0, 40);
  const msgs = getSessionLastMessages(s, 4);
  let text = `👁 הצצה — ${title}\n\n`;
  if (!msgs.length) {
    text += 'אין הודעות להצגה.';
  } else {
    text += msgs.map(m => {
      const who = m.role === 'user' ? '🧑 You:' : '🤖 Claude:';
      const body = m.text.length > 400 ? m.text.substring(0, 400) + '…' : m.text;
      return `${who}\n${body}`;
    }).join('\n\n────────\n\n');
  }
  const short = s.id.substring(0, 8);
  const keyboard = [
    [{ text: '▶️ Resume', callback_data: `uresume:${short}` }],
    [{ text: '⬅️ חזרה לסשן', callback_data: `sd:${short}` }]
  ];
  bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// Full paginated transcript — one window you page through with prev/next, so you
// can "scroll" the whole conversation inside Telegram like the Web UI sidebar.
const PEEK_PER_PAGE = 4;
const PEEK_BODY_CAP = 900;

function sendSessionScroll(bot, chatId, shortId, page, editMessageId) {
  const s = unifiedSessions.findSessionByShortId(shortId);
  if (!s) { bot.sendMessage(chatId, '❌ Session not found.'); return; }
  const title = (sessionMeta.getNote(s.id) || s.topic || 'session').substring(0, 40);
  const all = readSessionMessages(s);
  const short = s.id.substring(0, 8);

  const send = (body, kb) => {
    if (editMessageId) {
      bot.editMessageText(body, { chat_id: chatId, message_id: editMessageId, reply_markup: { inline_keyboard: kb } }).catch(() => {});
    } else {
      bot.sendMessage(chatId, body, { reply_markup: { inline_keyboard: kb } });
    }
  };

  if (!all.length) {
    send(`📜 ${title}\n\nאין הודעות להצגה.`, [[{ text: '⬅️ חזרה לסשן', callback_data: `sd:${short}` }]]);
    return;
  }

  const totalPages = Math.ceil(all.length / PEEK_PER_PAGE);
  let p = (page == null || isNaN(page)) ? totalPages - 1 : page; // default: newest page
  p = Math.max(0, Math.min(totalPages - 1, p));
  const slice = all.slice(p * PEEK_PER_PAGE, p * PEEK_PER_PAGE + PEEK_PER_PAGE);

  let text = `📜 ${title}  (${p + 1}/${totalPages})\n\n`;
  text += slice.map(m => {
    const who = m.role === 'user' ? '🧑 You:' : '🤖 Claude:';
    const b = m.text.length > PEEK_BODY_CAP ? m.text.substring(0, PEEK_BODY_CAP) + '…' : m.text;
    return `${who}\n${b}`;
  }).join('\n\n────────\n\n');
  if (text.length > 4000) text = text.substring(0, 3990) + '…';

  const nav = [];
  if (p > 0) nav.push({ text: '◀︎ ישנות', callback_data: `speekp:${short}:${p - 1}` });
  nav.push({ text: `${p + 1}/${totalPages}`, callback_data: 'noop' });
  if (p < totalPages - 1) nav.push({ text: 'חדשות ▶︎', callback_data: `speekp:${short}:${p + 1}` });

  send(text, [
    nav,
    [{ text: '▶️ Resume', callback_data: `uresume:${short}` }],
    [{ text: '⬅️ חזרה לסשן', callback_data: `sd:${short}` }]
  ]);
}

function sendSessionDetail(bot, chatId, shortId) {
  const s = unifiedSessions.findSessionByShortId(shortId);
  if (!s) { bot.sendMessage(chatId, '❌ Session not found.'); return; }

  const note = sessionMeta.getNote(s.id);
  const title = note || s.topic || '(no topic)';
  const project = s.projectPath ? path.basename(s.projectPath) : '?';
  const started = s.createdAt
    ? new Date(s.createdAt).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '?';
  const last = s.lastUsed ? unifiedSessions.formatTimeAgo(s.lastUsed) : '?';
  const archived = sessionMeta.isArchived(s.id);
  const short = s.id.substring(0, 8);
  const sourceIcon = s.source === 'telegram' ? '📱' : '🖥';

  let text = `🗂 *Session* ${sourceIcon}\n\n` +
    `*${title}*\n\n` +
    `📁 Folder: *${project}*\n` +
    `📆 Started: ${started}\n` +
    `🕐 Last: ${last}\n` +
    `💬 Messages: ${s.messageCount || 0}\n` +
    `🆔 \`${short}\``;
  if (note) text += `\n📝 Note: ${note}`;

  const keyboard = [
    [{ text: '▶️ Resume', callback_data: `uresume:${short}` }],
    [{ text: '👁 הצצה מהירה', callback_data: `speek:${short}` }, { text: '📜 כל ההודעות', callback_data: `speekf:${short}` }],
    [{ text: note ? '✎ Edit note' : '✎ Add note', callback_data: `snote:${short}` }],
    [archived
      ? { text: '↩ Unarchive', callback_data: `sunarc:${short}` }
      : { text: '🗄 Archive', callback_data: `sarc:${short}` }],
    [{ text: '🖥 Move to Mac', callback_data: `smac:${short}` }],
    [{ text: '⬅️ Back to list', callback_data: 'cmd:resume' }]
  ];

  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
}

/**
 * List archived sessions (hidden from the main list) with restore access.
 */
function sendArchivedList(bot, chatId) {
  const archivedSet = sessionMeta.archivedIds();
  const items = unifiedSessions.getAllSessions().filter(s => archivedSet.has(s.id));

  if (!items.length) {
    bot.sendMessage(chatId, '🗄 No archived sessions.');
    return;
  }

  const keyboard = items.slice(0, 20).map(s => {
    const title = resolveTitle(s);
    return [{ text: `🗄 ${title.substring(0, 34)}`, callback_data: `sd:${s.id.substring(0, 8)}` }];
  });
  keyboard.push([{ text: '⬅️ Back to list', callback_data: 'cmd:resume' }]);

  bot.sendMessage(chatId, `🗄 *Archived* (${items.length})\n\nTap to manage or restore:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Users mid-way through typing a note for a session (chatId -> full session id)
const pendingSessionNotes = new Map();

/**
 * Catch the force-reply that carries a new note for a session.
 */
function handleNoteReply(msg, bot) {
  const chatId = msg.chat.id;
  if (!pendingSessionNotes.has(chatId)) return false;
  if (!msg.reply_to_message || msg.reply_to_message.text !== '📝 Note for this session:') return false;

  const fullId = pendingSessionNotes.get(chatId);
  pendingSessionNotes.delete(chatId);

  const saved = sessionMeta.setNote(fullId, msg.text || '');
  bot.sendMessage(chatId, saved ? `📝 Note saved: *${saved}*` : '🗑 Note cleared', { parse_mode: 'Markdown' });
  sendSessionDetail(bot, chatId, fullId.substring(0, 8));
  return true;
}

/**
 * Send projects list for browsing CLI sessions
 */
function sendProjectsSessionsMenu(bot, chatId) {
  const projects = getCliProjects();

  if (projects.length === 0) {
    bot.sendMessage(chatId, '📭 No Mac CLI projects found.');
    return;
  }

  // Sort by name and limit
  const sortedProjects = projects
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 15);

  const keyboard = sortedProjects.map(p => [{
    text: `📁 ${p.name}`,
    callback_data: `clibrowse:${p.encoded.substring(0, 50)}`
  }]);

  keyboard.push([{ text: '⬅️ Back', callback_data: 'clibrowse:back' }]);

  bot.sendMessage(chatId, '📂 *All Mac Projects*\n\nSelect a project to see its sessions:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

/**
 * Send sessions for a specific CLI project
 */
function sendProjectSessionsList(bot, chatId, encodedPath) {
  const projects = getCliProjects();
  const project = projects.find(p => p.encoded.startsWith(encodedPath));

  if (!project) {
    bot.sendMessage(chatId, '❌ Project not found');
    return;
  }

  const sessions = getCliSessions(project.decoded, 10);

  if (sessions.length === 0) {
    bot.sendMessage(chatId, `📭 No sessions in *${project.name}*`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Back to Projects', callback_data: 'clibrowse:list' }]]
      }
    });
    return;
  }

  const keyboard = sessions.map(s => {
    const topic = s.topic || '(no topic)';
    const shortId = s.sessionId.substring(0, 6);
    return [{
      text: `🖥 ${topic.substring(0, 30)}${topic.length > 30 ? '...' : ''} (${s.messageCount}💬)`,
      callback_data: `cliproj:${encodedPath.substring(0, 30)}:${shortId}`
    }];
  });

  keyboard.push([{ text: '⬅️ Back to Projects', callback_data: 'clibrowse:list' }]);

  bot.sendMessage(chatId, `📁 *${project.name}*\n\nSelect a session to resume:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

/**
 * Send mode menu
 */
// Selectable Claude models. id is passed to `claude --model`; null = CLI default.
const MODELS = [
  { id: 'claude-opus-4-8', label: '🧠 Opus 4.8' },
  { id: 'claude-sonnet-5', label: '🎼 Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', label: '🍃 Haiku 4.5' },
  { id: 'claude-fable-5', label: '📖 Fable 5' },
  { id: null, label: '⚙️ Default (CLI)' }
];

function modelLabel(id) {
  return (MODELS.find(m => m.id === id) || {}).label || id || 'Default (CLI)';
}

function sendModelMenu(bot, chatId, userState) {
  const keyboard = MODELS.map(m => {
    const selected = (userState.model || null) === m.id;
    return [{ text: selected ? `✓ ${m.label}` : m.label, callback_data: `model:${m.id === null ? 'default' : m.id}` }];
  });

  bot.sendMessage(chatId,
    `🤖 *Model*\n\nCurrent: *${modelLabel(userState.model)}*\n\n` +
    `Pick a model. If a session is running it restarts on the new model and keeps this conversation.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

function sendModeMenu(bot, chatId, userState) {
  const keyboard = [
    [{ text: userState.currentMode === 'default' ? '✓ 🔒 Default' : '🔒 Default', callback_data: 'mode:default' }],
    [{ text: userState.currentMode === 'fast' ? '✓ ⚡ Fast' : '⚡ Fast', callback_data: 'mode:fast' }],
    [{ text: userState.currentMode === 'plan' ? '✓ 📋 Plan' : '📋 Plan', callback_data: 'mode:plan' }],
    [{ text: userState.currentMode === 'yolo' ? '✓ 🔥 YOLO' : '🔥 YOLO', callback_data: 'mode:yolo' }]
  ];

  bot.sendMessage(chatId,
    `⚙️ *Mode*\n\nCurrent: *${userState.currentMode}*\n\n${MODE_DESCRIPTIONS[userState.currentMode]}\n\nSelect mode:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

/**
 * Run Claude Code (non-streaming)
 */
function runClaude(prompt, cwd, fast = false, mode = 'default', model = null) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const toolsFlag = fast ? '--tools ""' : '';
    const modeFlag = getModeFlag(mode);
    const modelFlag = model ? `--model '${model}'` : '';
    const cmd = `claude -p '${escapedPrompt}' ${toolsFlag} ${modeFlag} ${modelFlag} < /dev/null`;

    console.log(`\n${'='.repeat(50)}`);
    console.log(`📨 [${new Date().toLocaleTimeString()}] NEW REQUEST ${fast ? '⚡FAST' : ''}`);
    console.log(`   Path: ${cwd}`);
    console.log(`${'='.repeat(50)}`);

    const proc = exec(cmd, {
      cwd: cwd,
      env: { ...process.env, PATH: `${CLAUDE_BIN_PATH}:${process.env.PATH}` },
      shell: '/bin/bash',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60 * 1000
    }, (error, stdout, stderr) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ [${new Date().toLocaleTimeString()}] COMPLETED in ${duration}s`);
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout || 'Done (no output)');
    });

    console.log(`   PID: ${proc.pid}`);
  });
}

/**
 * Run Claude Code with streaming
 */
function runClaudeStreaming(prompt, cwd, onUpdate, resumeSessionId = null, mode = 'default', projectName = 'unknown', onProcStart = null, model = null) {
  return new Promise((resolve, reject) => {
    // Safety: validate cwd exists
    if (!cwd || !fs.existsSync(cwd)) {
      console.log(`⚠️ Invalid cwd "${cwd}", falling back to "${BOT_DIR}"`);
      cwd = BOT_DIR;
    }

    const startTime = Date.now();
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const modeFlag = getModeFlag(mode);
    const resumeFlag = resumeSessionId ? `--resume '${resumeSessionId}'` : '';
    const modelFlag = model ? `--model '${model}'` : '';
    const cmd = `claude -p '${escapedPrompt}' --output-format stream-json --verbose ${modeFlag} ${resumeFlag} ${modelFlag} < /dev/null`;

    console.log(`\n${'='.repeat(50)}`);
    console.log(`📨 [${new Date().toLocaleTimeString()}] STREAMING REQUEST`);
    console.log(`   Project: ${projectName}`);
    console.log(`   Path: ${cwd}`);
    console.log(`${'='.repeat(50)}`);

    const proc = spawn('bash', ['-c', cmd], {
      cwd: cwd,
      env: (() => {
        const env = { ...process.env, PATH: `${CLAUDE_BIN_PATH}:${process.env.PATH}` };
        delete env.CLAUDE_CODE_ENTRYPOINT;
        delete env.CLAUDE_DEV;
        Object.keys(env).forEach(k => { if (k.startsWith('CLAUDECODE')) delete env[k]; });
        return env;
      })()
    });

    console.log(`   PID: ${proc.pid}`);
    if (resumeSessionId) console.log(`   Resuming session: ${resumeSessionId}`);

    if (onProcStart) onProcStart(proc);

    let fullText = '';
    let buffer = '';
    let sessionId = null;

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);

          if (json.session_id) {
            sessionId = json.session_id;
          }

          if (json.type === 'assistant' && json.message?.content) {
            for (const block of json.message.content) {
              if (block.type === 'text' && block.text) {
                fullText = block.text;
                onUpdate(fullText);
              }
            }
          } else if (json.type === 'result') {
            if (json.result) fullText = json.result;
            if (json.session_id) sessionId = json.session_id;
          }
        } catch (e) {}
      }
    });

    proc.stderr.on('data', (data) => {
      console.log(`   Stderr: ${data.toString().substring(0, 200)}`);
    });

    proc.on('close', (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ [${new Date().toLocaleTimeString()}] STREAM COMPLETED in ${duration}s`);
      if (sessionId) console.log(`   Session ID: ${sessionId}`);
      resolve({ text: fullText || 'Done (no output)', sessionId });
    });

    proc.on('error', (err) => {
      reject(err);
    });

    setTimeout(() => {
      proc.kill();
      reject(new Error('Timeout'));
    }, 5 * 60 * 1000);
  });
}

/**
 * Start an interactive Claude session using stream-json
 */
function startInteractiveSession(userState, chatId, bot, resumeId = null, initialMessage = null) {
  let cwd = userState.currentPath;
  const mode = userState.currentMode;
  const modeFlag = getModeFlag(mode);
  const homeDir = process.env.HOME || require('os').homedir();

  // When resuming, Claude resolves --resume against the project-key derived
  // from the launch cwd. If we launch from the wrong directory (e.g. the bot
  // dir), it reports "No conversation found" and exits — so locate the
  // session's real origin directory and use it.
  if (resumeId) {
    const originPath = findSessionProjectPath(resumeId);
    if (originPath) {
      if (originPath !== cwd) {
        console.log(`📍 Resume: switching cwd to session origin: ${originPath} (was "${cwd}")`);
      }
      cwd = originPath;
      userState.currentPath = cwd;
    } else {
      // The session's origin directory no longer exists (folder deleted/moved),
      // so it can NEVER be resumed. Abort instead of looping: a --resume with a
      // bad cwd just yields "No conversation found", exits, and retries forever.
      console.log(`⛔ Resume aborted: origin dir for session ${resumeId} not found — clearing stale session to stop retry loop.`);
      clearSession(chatId);
      userState.interactiveSessionId = null;
      userState.pendingMessage = null;
      userState.isProcessing = false;
      scheduleSave();
      bot.sendMessage(chatId,
        `⚠️ Can't resume session \`${String(resumeId).slice(0, 8)}\` — its project folder no longer exists, so this conversation is gone.\n\nI've cleared it. Send a message to start a fresh session.`,
        { parse_mode: 'Markdown' }
      );
      return false;
    }
  }

  // Safety: validate cwd exists, fallback to bot dir
  if (!cwd || !fs.existsSync(cwd)) {
    console.log(`⚠️ Invalid cwd "${cwd}", falling back to ${BOT_DIR}`);
    cwd = BOT_DIR;
    userState.currentPath = cwd;
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`🔄 [${new Date().toLocaleTimeString()}] STARTING INTERACTIVE SESSION (stream-json)`);
  console.log(`   Path: ${cwd}`);
  console.log(`   Mode: ${mode}`);
  if (resumeId) console.log(`   Resuming: ${resumeId}`);
  console.log(`${'='.repeat(50)}`);

  // Build args for claude
  // Note: removed -p flag as it prevents --resume from loading conversation history
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  if (modeFlag) {
    args.push(...modeFlag.trim().split(/\s+/).filter(Boolean));
  }
  if (resumeId) {
    args.push('--resume', resumeId);
  }
  if (userState.model) {
    args.push('--model', userState.model);
  }

  // Managing a session from Telegram means there's no terminal to approve
  // permission prompts on — so any resumed session skips permissions, otherwise
  // it just hangs on the first "can I run this?" and you're stuck on your phone.
  if (resumeId && !args.includes('--dangerously-skip-permissions')) {
    args.push('--dangerously-skip-permissions');
  }

  console.log(`   Args: ${args.join(' ')}`);

  // Spawn Claude with stream-json
  const proc = spawn(`${homeDir}/.local/bin/claude`, args, {
    cwd: cwd,
    env: (() => {
      const env = { ...process.env, PATH: `${homeDir}/.local/bin:${process.env.PATH}` };
      // Remove Claude Code env vars to avoid "nested session" detection
      delete env.CLAUDE_CODE_ENTRYPOINT;
      delete env.CLAUDE_DEV;
      Object.keys(env).forEach(k => { if (k.startsWith('CLAUDECODE')) delete env[k]; });
      return env;
    })(),
    stdio: ['pipe', 'pipe', 'pipe']
  });

  console.log(`   PID: ${proc.pid}`);
  console.log(`   stdout readable: ${proc.stdout.readable}, stderr readable: ${proc.stderr.readable}`);

  // Set encoding for streams
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');

  // State for streaming
  let buffer = '';
  let currentMessageId = null;
  let lastText = '';
  let lastUpdate = 0;
  let isReady = false;
  let typingInterval = null;
  let currentStatus = '';
  let resultReceived = false;  // Prevent processing after result
  let toolsLog = [];     // Track tool usage (Read, Edit, Bash...)
  let statusLog = [];    // Track all status messages shown
  let fullLog = [];      // Track full JSON stream for debugging

  // Initialize tracking in userState
  userState.interactiveStartTime = null;
  userState.interactiveToolsUsed = [];

  // Cancel button keyboard
  const cancelKeyboard = {
    inline_keyboard: [[{ text: '🛑 Cancel', callback_data: 'interactive:cancel' }]]
  };

  // Format elapsed time
  const formatElapsed = (startTime) => {
    if (!startTime) return '0s';
    const seconds = Math.floor((Date.now() - startTime) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m${secs}s`;
  };

  // Update status message with elapsed time
  const updateStatusMessage = async (status, showCancel = true) => {
    // Log status text (remove emoji prefix for cleaner log)
    const cleanStatus = status.replace(/^[🔄🧠📋❌]\s*/, '').trim();
    if (cleanStatus && cleanStatus !== 'Processing...' && !statusLog.includes(cleanStatus)) {
      statusLog.push(cleanStatus);
    }

    // Skip UI update if no thinking message
    if (!userState.interactiveThinkingMsgId) return;

    const elapsed = formatElapsed(userState.interactiveStartTime);
    const toolCount = userState.interactiveToolsUsed?.length > 0 ? ` [${userState.interactiveToolsUsed.length}]` : '';
    const fullStatus = `${status}${toolCount} (${elapsed})`;

    if (fullStatus === currentStatus) return;
    currentStatus = fullStatus;

    try {
      await bot.editMessageText(fullStatus, {
        chat_id: chatId,
        message_id: userState.interactiveThinkingMsgId,
        reply_markup: showCancel ? cancelKeyboard : undefined
      });
    } catch (e) {}
  };

  // Note: Timer removed - elapsed time updates on every Claude event (tool use, thinking, etc.)
  // This avoids setInterval async issues and reduces unnecessary API calls
  const startTimer = () => {};  // No-op, kept for compatibility
  const stopTimer = () => {
    // Clean up any legacy timer
    if (userState.interactiveTimerInterval) {
      clearInterval(userState.interactiveTimerInterval);
      userState.interactiveTimerInterval = null;
    }
  };

  // Send typing indicator periodically while processing
  const startTyping = () => {
    if (typingInterval) return;
    bot.sendChatAction(chatId, 'typing').catch(() => {});
    typingInterval = setInterval(() => {
      bot.sendChatAction(chatId, 'typing').catch(() => {});  // Ignore errors
    }, 4000);
  };

  const stopTyping = () => {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
  };

  // IMMEDIATELY attach stdout handler
  proc.stdout.on('data', async (data) => {
    const chunk = data.toString();
    console.log(`   [stdout] ${chunk.length} bytes`);

    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;

      // Skip processing if we already got the result (prevents duplicates)
      if (resultReceived) continue;

      try {
        const json = JSON.parse(line);

        // Log full JSON for debugging (skip large content)
        const logEntry = {
          type: json.type,
          subtype: json.subtype,
          timestamp: new Date().toISOString()
        };
        if (json.message?.content) {
          logEntry.blocks = json.message.content.map(b => ({
            type: b.type,
            name: b.name,
            text: b.text?.substring(0, 200),
            thinking: b.thinking?.substring(0, 200),
            input: b.input ? JSON.stringify(b.input).substring(0, 300) : undefined
          }));
        }
        if (json.result) {
          logEntry.result = json.result.substring(0, 500);
        }
        fullLog.push(logEntry);

        // System init - Claude is ready
        if (json.type === 'system' && json.subtype === 'init') {
          console.log(`   Claude ready, session: ${json.session_id}`);
          isReady = true;
          if (initTimeout) clearTimeout(initTimeout);
          userState.interactiveSessionId = json.session_id;

          // Send pending message
          if (userState.pendingMessage) {
            const msg = userState.pendingMessage;
            userState.pendingMessage = null;
            console.log(`   [init] Sending pending message: "${msg.substring(0, 50)}..."`);

            const sent = sendToInteractive(userState, msg, bot, chatId);
            console.log(`   [init] sendToInteractive returned: ${sent}`);

            if (sent) {
              startTyping();
              startTimer();
              updateStatusMessage('🔄 Processing...');
            } else {
              console.log(`   [init] ERROR: Failed to send pending message!`);
              bot.sendMessage(chatId, '❌ Failed to send message to Claude. Try again.');
            }
          } else {
            console.log(`   [init] No pending message`);
          }
          continue;
        }

        // Assistant response - update on every change
        if (json.type === 'assistant' && json.message?.content) {
          for (const block of json.message.content) {
            if (block.type === 'text' && block.text) {
              const text = block.text;
              stopTyping();  // Got text, stop typing indicator

              if (!currentMessageId) {
                // First message - check if we have a "Thinking..." message to update
                if (userState.interactiveThinkingMsgId) {
                  // Set BEFORE await to prevent race condition with concurrent data events
                  currentMessageId = userState.interactiveThinkingMsgId;
                  userState.interactiveThinkingMsgId = null;
                  try {
                    await editMessageSafe(bot, chatId, currentMessageId, text.substring(0, 4000) + ' ▌');
                    lastText = text;
                    lastUpdate = Date.now();
                  } catch (e) { console.log('Edit thinking error:', e.message); }
                } else if (!currentMessageId) {
                  // Double-check still null (another event might have set it)
                  // No thinking message - send new
                  try {
                    const sent = await sendMessageSafe(bot, chatId, text.substring(0, 4000) + ' ▌');
                    currentMessageId = sent.message_id;
                    lastText = text;
                    lastUpdate = Date.now();
                  } catch (e) { console.log('Send error:', e.message); }
                }
              } else if (text !== lastText) {
                // Text changed - update (throttle to avoid rate limits)
                const now = Date.now();
                if (now - lastUpdate > 500) {  // Reduced from 1500ms to 500ms
                  lastUpdate = now;
                  lastText = text;
                  try {
                    await editMessageSafe(bot, chatId, currentMessageId, text.substring(0, 4000) + ' ▌');
                  } catch (e) {}
                }
              }
            }

            // Show thinking indicator (if Claude sends thinking blocks)
            if (block.type === 'thinking') {
              startTyping();
              const thinkingText = block.thinking || '';
              const firstLine = thinkingText.split('\n').find(l => l.trim().length > 5) || '';
              const summary = firstLine.substring(0, 50) + (firstLine.length > 50 ? '...' : '');
              updateStatusMessage(summary ? `🧠 ${summary}` : '🧠 Thinking...');
            }

            // Handle TodoWrite tool - show todos progress
            if (block.type === 'tool_use' && block.name === 'TodoWrite') {
              const todos = block.input?.todos || [];
              if (todos.length > 0) {
                const completed = todos.filter(t => t.status === 'completed').length;
                const inProgress = todos.filter(t => t.status === 'in_progress').length;
                const pending = todos.filter(t => t.status === 'pending').length;

                let todoStatus = '📋 Todos: ';
                if (completed > 0) todoStatus += `✅${completed} `;
                if (inProgress > 0) todoStatus += `🔄${inProgress} `;
                if (pending > 0) todoStatus += `⏳${pending}`;

                // Find current in_progress todo
                const current = todos.find(t => t.status === 'in_progress');
                if (current) {
                  todoStatus = `🔄 ${current.activeForm || current.content}`;
                }

                updateStatusMessage(todoStatus);
              }
            }

            // Show tool use activity - update message with what Claude is doing
            if (block.type === 'tool_use') {
              startTyping();
              const toolName = block.name || 'tool';
              const input = block.input || {};
              if (!userState.interactiveToolsUsed) userState.interactiveToolsUsed = [];
              userState.interactiveToolsUsed.push(toolName);
              console.log(`   [tool] ${toolName}`);

              // Build detailed status
              let statusText = '🔄 ';
              let logEntry = '';
              if (toolName === 'Read') {
                const file = input.file_path ? path.basename(input.file_path) : 'file';
                statusText += `Reading ${file}`;
                logEntry = `Read: ${input.file_path || file}`;
              } else if (toolName === 'Write') {
                const file = input.file_path ? path.basename(input.file_path) : 'file';
                statusText += `Writing ${file}`;
                logEntry = `Write: ${input.file_path || file}`;
              } else if (toolName === 'Edit') {
                const file = input.file_path ? path.basename(input.file_path) : 'file';
                statusText += `Editing ${file}`;
                logEntry = `Edit: ${input.file_path || file}`;
              } else if (toolName === 'Bash') {
                const cmd = input.command ? input.command.substring(0, 50) : 'command';
                statusText += `Running: ${cmd.substring(0, 30)}${cmd.length > 30 ? '...' : ''}`;
                logEntry = `Bash: ${cmd}`;
              } else if (toolName === 'Glob') {
                statusText += `Searching: ${input.pattern || 'files'}`;
                logEntry = `Glob: ${input.pattern || 'pattern'}`;
              } else if (toolName === 'Grep') {
                statusText += `Grep: ${input.pattern?.substring(0, 20) || 'pattern'}`;
                logEntry = `Grep: ${input.pattern || 'pattern'}`;
              } else if (toolName === 'Task') {
                statusText += `Agent: ${input.description || 'task'}`;
                logEntry = `Task: ${input.description || 'agent'}`;
              } else if (toolName === 'WebFetch') {
                statusText += `Fetching URL`;
                logEntry = `WebFetch: ${input.url || 'url'}`;
              } else {
                statusText += `${toolName}`;
                logEntry = toolName;
              }

              // Add to tools log
              toolsLog.push(logEntry);
              updateStatusMessage(statusText);
            }
          }
        }

        // Tool result - check for errors
        if (json.type === 'user' && json.message?.content) {
          for (const block of json.message.content) {
            if (block.type === 'tool_result' && block.is_error) {
              updateStatusMessage('❌ Tool failed');
            }
          }
        }

        // Result - response complete
        if (json.type === 'result') {
          resultReceived = true;  // Prevent further processing
          stopTyping();
          stopTimer();

          // Use lastText (from streaming) preferably, fall back to json.result
          const finalText = lastText || json.result || '';
          const elapsed = formatElapsed(userState.interactiveStartTime);
          const toolCount = userState.interactiveToolsUsed?.length || 0;

          // Delete the thinking message if we have a response
          if (userState.interactiveThinkingMsgId) {
            try {
              await bot.deleteMessage(chatId, userState.interactiveThinkingMsgId);
            } catch (e) {}
            userState.interactiveThinkingMsgId = null;
          }

          // Handle response
          if (finalText) {
            if (finalText.length <= 4000) {
              if (currentMessageId) {
                // Edit existing streaming message
                try {
                  await editMessageSafe(bot, chatId, currentMessageId, finalText);
                } catch (e) {}
              } else if (!userState.interactiveThinkingMsgId || userState.interactiveThinkingMsgId === null) {
                // No streaming happened AND no thinking message being processed - send new message
                // This guards against race conditions
                await sendMessageSafe(bot, chatId, finalText);
              }
            } else {
              // Long message - delete partial and send chunks
              if (currentMessageId) {
                try { await bot.deleteMessage(chatId, currentMessageId); } catch (e) {}
              }
              // Send long message with markdown formatting
              const formatted = formatForTelegram(finalText);
              await sendLongMessage(bot, chatId, formatted, { parse_mode: 'Markdown' });
            }

            // Send voice if voiceMode is 'auto'
            const voiceMode = userState.voiceMode || 'off';
            if (voiceMode === 'auto') {
              await sendVoiceResponse(bot, chatId, finalText, userState);
            }
          }

          // Send compact summary only if we had a request in progress
          if (userState.interactiveStartTime) {
            const timestamp = Date.now();
            const voiceMode = userState.voiceMode || 'off';
            const thoughtMode = userState.thoughtMode || 'off';

            console.log(`[summary] mode=${thoughtMode}, tools=${toolsLog.length}, status=${statusLog.length}`);

            // Build inline keyboard buttons (URL type - work on all platforms)
            const botUsername = (await bot.getMe()).username;
            let buttons = [];

            // Save logs and create buttons
            if (toolsLog.length > 0) {
              pendingLogs.set(`tools_${chatId}`, toolsLog.slice());
            }
            if (statusLog.length > 0) {
              pendingLogs.set(`status_${chatId}`, statusLog.slice());
            }
            if (fullLog.length > 0) {
              pendingLogs.set(`fulllog_${chatId}`, fullLog.slice());
            }
            if (voiceMode === 'on' && finalText && finalText.length > 10) {
              pendingLogs.set(`voice_${chatId}`, finalText);
            }

            // Build buttons row (only if thoughtMode=on)
            if (thoughtMode === 'on') {
              if (toolsLog.length > 0) {
                buttons.push({ text: `🔧${toolsLog.length}`, url: `https://t.me/${botUsername}?start=tools` });
              }
              if (statusLog.length > 0) {
                buttons.push({ text: `📝${statusLog.length}`, url: `https://t.me/${botUsername}?start=status` });
              }
              if (fullLog.length > 0) {
                buttons.push({ text: `📋${fullLog.length}`, url: `https://t.me/${botUsername}?start=fulllog` });
              }
              if (voiceMode === 'on' && finalText && finalText.length > 10) {
                buttons.push({ text: '🔊', url: `https://t.me/${botUsername}?start=v` });
              }
            }

            // Build summary text
            let summaryText = `Done (${elapsed})`;
            const totalCount = toolsLog.length + statusLog.length;
            if (thoughtMode === 'off' && totalCount > 0) {
              // Show counts without buttons
              let counts = [];
              if (toolsLog.length > 0) counts.push(`🔧${toolsLog.length}`);
              if (statusLog.length > 0) counts.push(`📝${statusLog.length}`);
              summaryText += ` [${counts.join(', ')}]`;
            }

            // Auto thought mode - show logs automatically
            if (thoughtMode === 'auto' && totalCount > 0) {
              let logText = summaryText;

              if (statusLog.length > 0) {
                const statusLines = statusLog.map((step, i) => `${i + 1}. ${step}`).join('\n');
                logText += `\n\n📝 *Status:*\n\`\`\`\n${statusLines}\n\`\`\``;
              }

              if (toolsLog.length > 0) {
                const toolLines = toolsLog.map((step, i) => `${i + 1}. ${step}`).join('\n');
                logText += `\n\n🔧 *Tools:*\n\`\`\`\n${toolLines}\n\`\`\``;
              }

              if (logText.length <= 4000) {
                await bot.sendMessage(chatId, logText, { parse_mode: 'Markdown' });
              } else {
                await bot.sendMessage(chatId, summaryText);
                const allLogs = `=== Status ===\n${statusLog.join('\n')}\n\n=== Tools ===\n${toolsLog.join('\n')}`;
                const buffer = Buffer.from(allLogs, 'utf-8');
                await bot.sendDocument(chatId, buffer, { caption: '🧠 Process' }, { filename: 'process.txt', contentType: 'text/plain' });
              }
            } else {
              // Send with inline keyboard if we have buttons
              const options = buttons.length > 0
                ? { reply_markup: { inline_keyboard: [buttons] } }
                : {};
              await bot.sendMessage(chatId, summaryText, options);
            }
          }

          // Reset state for next message
          currentMessageId = null;
          lastText = '';
          resultReceived = false;  // Allow processing next message
          toolsLog = [];     // Clear tools log
          statusLog = [];    // Clear status log
          fullLog = [];      // Clear full log
          userState.interactiveStartTime = null;
          userState.interactiveToolsUsed = [];
          currentStatus = '';

          if (json.session_id) {
            setSession(chatId, json.session_id, cwd, 'Interactive');
            // Save to unified registry
            unifiedSessions.addSession({
              id: json.session_id,
              source: 'telegram',
              sourceId: chatId.toString(),
              topic: 'Interactive',
              projectPath: cwd,
              mode: mode,
              flags: modeFlag ? [modeFlag.trim()] : [],
              messageCount: 1
            });
          }
        }
      } catch (e) {
        console.log(`   Parse error: ${e.message}`);
      }
    }
  });

  proc.stderr.on('data', (data) => {
    console.log(`   [stderr] ${data.toString().substring(0, 200)}`);
  });

  proc.on('close', (code) => {
    console.log(`🔄 [${new Date().toLocaleTimeString()}] SESSION CLOSED (code: ${code})`);
    if (initTimeout) clearTimeout(initTimeout);
    stopTyping();
    stopTimer();
    userState.interactiveProc = null;
    userState.isProcessing = false;
  });

  proc.on('error', (err) => {
    console.log(`   SPAWN ERROR: ${err.message}`);
    bot.sendMessage(chatId, `❌ Failed to start Claude: ${err.message}`);
  });

  // Store process
  userState.interactiveProc = proc;
  userState.isProcessing = false;
  console.log(`   [startInteractive] Proc stored, PID: ${proc.pid}`);

  // Retry mechanism: 1 second timeout, 5 retries
  let initRetryCount = 0;
  const maxRetries = 5;
  let initTimeout = null;

  const tryInit = () => {
    initTimeout = setTimeout(() => {
      if (!isReady && userState.pendingMessage) {
        initRetryCount++;
        console.log(`   [TIMEOUT] Retry ${initRetryCount}/${maxRetries} - sending message`);

        if (initRetryCount <= maxRetries) {
          const msg = userState.pendingMessage;
          const sent = sendToInteractive(userState, msg, bot, chatId);

          if (sent) {
            userState.pendingMessage = null;
            startTyping();
            startTimer();
            updateStatusMessage('🔄 Processing...');
          } else if (initRetryCount < maxRetries) {
            // Retry in 1 second
            tryInit();
          } else {
            console.log(`   [TIMEOUT] All retries failed`);
            bot.sendMessage(chatId, '❌ Failed to connect to Claude. Try /cancel and send again.');
          }
        }
      }
    }, 1000);
  };

  tryInit();

  // Queue initial message BEFORE any async operations
  if (initialMessage) {
    userState.pendingMessage = initialMessage;
    userState.interactiveStartTime = Date.now();
    userState.interactiveToolsUsed = [];
    console.log(`   [startInteractive] Pending message set: "${initialMessage.substring(0, 50)}..."`);
  } else {
    // Only show "started" message if no initial message (manual session start)
    bot.sendMessage(chatId,
      `🖥 *Interactive Claude started*\n\n` +
      `📁 ${cwd}\n` +
      `💬 Mode: ${mode}\n` +
      `${resumeId ? '▶️ Resuming session\n' : ''}` +
      `\n_Send messages here → Claude responds here_`,
      { parse_mode: 'Markdown' }
    );
  }

  return proc;
}

/**
 * Stop an interactive Claude session
 */
function stopInteractiveSession(userState) {
  console.log(`🛑 Stopping interactive session`);
  if (userState.interactiveProc && typeof userState.interactiveProc.kill === 'function') {
    userState.interactiveProc.kill();
  }
  // Clean up timer
  if (userState.interactiveTimerInterval) {
    clearInterval(userState.interactiveTimerInterval);
    userState.interactiveTimerInterval = null;
  }
  userState.interactiveProc = null;
  userState.isProcessing = false;
  userState.pendingMessage = null;
  userState.interactiveStartTime = null;
  userState.interactiveToolsUsed = [];
  userState.interactiveThinkingMsgId = null;
}

/**
 * Send message to interactive Claude (stream-json format)
 */
function sendToInteractive(userState, message, bot = null, chatId = null) {
  console.log(`   [sendToInteractive] proc exists: ${!!userState.interactiveProc}, stdin exists: ${!!userState.interactiveProc?.stdin}`);

  if (!userState.interactiveProc || !userState.interactiveProc.stdin) {
    console.log(`   [sendToInteractive] ERROR: No proc or stdin!`);
    return false;
  }

  // Format as JSON for stream-json input
  const jsonMessage = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: message
    }
  });

  userState.interactiveProc.stdin.write(jsonMessage + '\n');
  console.log(`   [stdin] Sent: ${message.substring(0, 50)}...`);

  // Update message count in local session and unified registry
  if (chatId) {
    incrementSession(chatId);
    if (userState.interactiveSessionId) {
      const existing = unifiedSessions.findSession(userState.interactiveSessionId);
      if (existing) {
        unifiedSessions.updateSession(userState.interactiveSessionId, {
          lastUsed: new Date().toISOString(),
          messageCount: (existing.messageCount || 0) + 1
        });
      }
    }
  }

  return true;
}

/**
 * Handle incoming message (main Claude interaction)
 */
async function handleMessage(bot, msg, isAuthorized) {
  if (!isAuthorized(msg)) return;

  // Skip commands
  if (msg.text && msg.text.startsWith('/')) return;

  // Skip non-text messages
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const userState = getUserState(chatId);

  // INTERACTIVE MODE: use PTY session
  if (userState.interactiveMode) {
    // If PTY session exists, send message to it
    if (userState.interactiveProc) {
      // Send immediate "Thinking..." message with cancel button
      const cancelKeyboard = {
        inline_keyboard: [[{ text: '🛑 Cancel', callback_data: 'interactive:cancel' }]]
      };
      const thinkingMsg = await bot.sendMessage(chatId, '🔄 Processing... (0s)', {
        reply_to_message_id: msg.message_id,
        reply_markup: cancelKeyboard
      });
      userState.interactiveThinkingMsgId = thinkingMsg.message_id;
      // Reset tracking for new request
      userState.interactiveStartTime = Date.now();
      userState.interactiveToolsUsed = [];

      // Apply style prompt based on voice mode
      let messageToSend = msg.text;
      const voiceMode = userState.voiceMode || 'off';
      if (voiceMode === 'auto') {
        // Voice auto mode - use voice style
        const stylePrompt = VOICE_STYLE_OPTIONS.find(r => r.id === userState.voiceSettings.responseLevel)?.prompt;
        if (stylePrompt) messageToSend = `[${stylePrompt}]\n\n${msg.text}`;
      } else {
        // Text mode (off/on) - use text style
        const textStyle = userState.voiceSettings.textStyle || 'off';
        const stylePrompt = TEXT_STYLE_OPTIONS.find(t => t.id === textStyle)?.prompt;
        if (stylePrompt) messageToSend = `[${stylePrompt}]\n\n${msg.text}`;
      }

      sendToInteractive(userState, messageToSend, bot, chatId);
      return;
    }

    // Start new PTY session with this message
    // Check for saved session ID (from restart) or active session
    let resumeSessionId = null;

    // Priority 1: Active session in memory
    let existingSession = getSession(chatId);
    if (existingSession) {
      // Drop sessions whose origin folder no longer exists — they can't be
      // resumed and otherwise drive an endless "No conversation found" loop.
      if (existingSession.sessionId && !findSessionProjectPath(existingSession.sessionId)) {
        console.log(`[Interactive] Active session ${existingSession.sessionId.slice(0, 8)} has no origin dir, clearing and starting fresh`);
        clearSession(chatId);
        existingSession = null;
      } else if (existingSession.projectPath !== userState.currentPath) {
        console.log(`[Interactive] Session project mismatch, clearing`);
        clearSession(chatId);
        existingSession = null;
      } else {
        resumeSessionId = existingSession.sessionId;
      }
    }

    // Priority 2: Saved session ID from restart (if no active session)
    // DISABLED:     if (!resumeSessionId && userState.interactiveSessionId) {
    // DISABLED:       console.log(`[Interactive] Found saved session ID from restart: ${userState.interactiveSessionId.substring(0, 8)}...`);
    // DISABLED:       resumeSessionId = userState.interactiveSessionId;
    // DISABLED:     }

    const sessionIndicator = resumeSessionId ? '💬 Resuming session...' : '🆕 Starting new session...';
    const thinkingMsg = await bot.sendMessage(chatId, `🔄 ${sessionIndicator}`, { reply_to_message_id: msg.message_id });
    userState.interactiveThinkingMsgId = thinkingMsg.message_id;

    // Apply style prompt based on voice mode
    let initialMessage = msg.text;
    const voiceModeInit = userState.voiceMode || 'off';
    if (voiceModeInit === 'auto') {
      // Voice auto mode - use voice style
      const stylePrompt = VOICE_STYLE_OPTIONS.find(r => r.id === userState.voiceSettings.responseLevel)?.prompt;
      if (stylePrompt) initialMessage = `[${stylePrompt}]\n\n${msg.text}`;
    } else {
      // Text mode (off/on) - use text style
      const textStyle = userState.voiceSettings.textStyle || 'off';
      const stylePrompt = TEXT_STYLE_OPTIONS.find(t => t.id === textStyle)?.prompt;
      if (stylePrompt) initialMessage = `[${stylePrompt}]\n\n${msg.text}`;
    }

    console.log(`[Interactive] Starting session for chat ${chatId}, resume: ${resumeSessionId || 'new'}`);
    startInteractiveSession(userState, chatId, bot, resumeSessionId, initialMessage);
    return;
  }

  // NON-INTERACTIVE MODE: original behavior below

  // If already processing, send message to running Claude process
  if (userState.isProcessing && userState.currentClaudeProc) {
    try {
      // Send the new message to Claude's stdin
      userState.currentClaudeProc.stdin.write(msg.text + '\n');
      bot.sendMessage(chatId, `➡️ Sent to Claude`, { reply_to_message_id: msg.message_id });
    } catch (e) {
      bot.sendMessage(chatId, `⚠️ Could not send to Claude: ${e.message}`);
    }
    return;
  }

  // If processing but no proc (shouldn't happen), reset state
  if (userState.isProcessing) {
    userState.isProcessing = false;
  }

  userState.isProcessing = true;

  // Check for -r flag to force resume
  let prompt = msg.text;
  let forceResume = false;
  if (prompt.startsWith('-r ')) {
    forceResume = true;
    prompt = prompt.substring(3).trim();
  }

  // Check for existing session
  const existingSession = (userState.sessionMode || forceResume) ? getSession(chatId) : null;
  let resumeSessionId = existingSession?.sessionId || null;

  // If project changed, clear session
  if (existingSession && existingSession.projectPath !== userState.currentPath) {
    clearSession(chatId);
    resumeSessionId = null;
  }

  // Send initial message
  const sessionIndicator = (!userState.sessionMode && !forceResume) ? '⚡' : (resumeSessionId ? '💬' : '🆕');
  let sentMsg;
  try {
    sentMsg = await bot.sendMessage(chatId, `${sessionIndicator} Thinking...`, { reply_to_message_id: msg.message_id });
  } catch (e) {
    userState.isProcessing = false;
    return;
  }

  let lastUpdate = Date.now();
  let lastText = '';

  // Apply style prompt based on voice mode
  let finalPrompt = prompt;
  const voiceModeNonInt = userState.voiceMode || 'off';
  if (voiceModeNonInt === 'auto') {
    // Voice auto mode - use voice style
    const stylePrompt = VOICE_STYLE_OPTIONS.find(r => r.id === userState.voiceSettings.responseLevel)?.prompt;
    if (stylePrompt) finalPrompt = `[${stylePrompt}]\n\n${prompt}`;
  } else {
    // Text mode (off/on) - use text style
    const textStyle = userState.voiceSettings.textStyle || 'off';
    const stylePrompt = TEXT_STYLE_OPTIONS.find(t => t.id === textStyle)?.prompt;
    if (stylePrompt) finalPrompt = `[${stylePrompt}]\n\n${prompt}`;
  }

  try {
    const result = await runClaudeStreaming(
      finalPrompt,
      userState.currentPath,
      async (text) => {
        // Update message every 1.5 seconds
        if (Date.now() - lastUpdate > 1500 && text !== lastText && text.length > 0) {
          lastUpdate = Date.now();
          lastText = text;
          try {
            const displayText = text.length > 4000 ? text.substring(0, 4000) + '...' : text;
            await bot.editMessageText(displayText + ' ▌', {
              chat_id: chatId,
              message_id: sentMsg.message_id
            });
          } catch (e) {}
        }
      },
      resumeSessionId,
      userState.currentMode,
      userState.currentProject,
      (proc) => { userState.currentClaudeProc = proc; }
    );

    userState.currentClaudeProc = null;

    // Save session
    if ((userState.sessionMode || forceResume) && result.sessionId) {
      if (existingSession) {
        incrementSession(chatId);
        // Update unified registry
        unifiedSessions.updateSession(result.sessionId, {
          lastUsed: new Date().toISOString(),
          messageCount: (existingSession.messageCount || 0) + 1
        });
      } else {
        setSession(chatId, result.sessionId, userState.currentPath, prompt);
        // Save to unified registry
        unifiedSessions.addSession({
          id: result.sessionId,
          source: 'telegram',
          sourceId: chatId.toString(),
          topic: prompt,
          projectPath: userState.currentPath,
          mode: userState.currentMode,
          flags: getModeFlag(userState.currentMode) ? [getModeFlag(userState.currentMode).trim()] : [],
          messageCount: 1
        });
      }
    }

    const response = result.text;

    // Final update
    if (response.length <= 4000) {
      await bot.editMessageText(response, {
        chat_id: chatId,
        message_id: sentMsg.message_id
      });
    } else {
      await bot.deleteMessage(chatId, sentMsg.message_id);
      await sendLongMessage(bot, chatId, response, msg.message_id);
    }

    // Send voice if voiceMode is 'auto'
    if ((userState.voiceMode || 'off') === 'auto' && response.length > 0) {
      await sendVoiceResponse(bot, chatId, response, userState);
    }
  } catch (error) {
    userState.currentClaudeProc = null;
    try {
      await bot.editMessageText(`❌ Error: ${error.message}`, {
        chat_id: chatId,
        message_id: sentMsg.message_id
      });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
  } finally {
    userState.isProcessing = false;
  }
}

/**
 * Send voice response with chunking and progress
 */
async function sendVoiceResponse(bot, chatId, response, userState) {
  const engineName = TTS_ENGINES[userState.voiceSettings.ttsEngine || 'edge'].name;
  const lines = response.split('\n').filter(l => l.trim().length > 0);
  const presetName = userState.voiceSettings.chunkPreset || 'medium';

  // Determine if chunking is needed
  const needsChunking = presetName !== 'none' && lines.length > 10;

  if (needsChunking) {
    // Send progress message
    let progressMsg = null;
    try {
      progressMsg = await bot.sendMessage(chatId, `🎙 Processing VM 1/? with ${engineName}...`);
    } catch (e) {}

    let sentCount = 0;
    try {
      await generateVoiceChunked(
        response,
        userState.voiceSettings,
        async (buffer, format, chunkNum, totalChunks) => {
          try {
            await bot.sendVoice(chatId, buffer, {
              caption: totalChunks > 1 ? `🔊 ${chunkNum}/${totalChunks}` : undefined
            }, {
              filename: `response_${chunkNum}.${format}`,
              contentType: format === 'wav' ? 'audio/wav' : 'audio/mpeg'
            });
            sentCount++;
          } catch (sendErr) {
            console.log(`Voice send error (chunk ${chunkNum}):`, sendErr?.message);
          }
        },
        async (statusText) => {
          if (progressMsg && statusText) {
            try {
              await bot.editMessageText(statusText, {
                chat_id: chatId,
                message_id: progressMsg.message_id
              });
            } catch (e) {}
          }
        }
      );

      // Delete progress message when done
      if (progressMsg) {
        try { await bot.deleteMessage(chatId, progressMsg.message_id); } catch (e) {}
      }

      if (sentCount === 0) {
        bot.sendMessage(chatId, '🔇 _Voice generation failed_', { parse_mode: 'Markdown' });
      }
    } catch (voiceError) {
      console.log('Chunked voice error:', voiceError?.message || voiceError);
      if (progressMsg) {
        try { await bot.deleteMessage(chatId, progressMsg.message_id); } catch (e) {}
      }
      bot.sendMessage(chatId, `🔇 _Voice failed: ${voiceError?.message || 'unknown error'}_`, { parse_mode: 'Markdown' });
    }
  } else {
    // Single voice message
    try {
      const result = await generateVoice(response, userState.voiceSettings);
      if (result && result.buffer) {
        await bot.sendVoice(chatId, result.buffer, {}, {
          filename: `response.${result.format}`,
          contentType: result.format === 'wav' ? 'audio/wav' : 'audio/mpeg'
        });
      } else {
        bot.sendMessage(chatId, '🔇 _Voice generation failed - text too short_', { parse_mode: 'Markdown' });
      }
    } catch (voiceError) {
      console.log('Voice error:', voiceError?.message || voiceError);
      bot.sendMessage(chatId, `🔇 _Voice failed: ${voiceError?.message || 'unknown error'}_`, { parse_mode: 'Markdown' });
    }
  }
}

/**
 * Handle Claude-related callbacks
 */
async function handleCallback(bot, query, userState) {
  const data = query.data;
  const chatId = query.message.chat.id;

  // ===== Session management card (inner menu) =====
  if (data.startsWith('sd:')) {
    sendSessionDetail(bot, chatId, data.substring(3));
    bot.answerCallbackQuery(query.id);
    return true;
  }
  if (data.startsWith('speek:')) {
    sendSessionPreview(bot, chatId, data.substring(6));
    bot.answerCallbackQuery(query.id, { text: '👁 הצצה' });
    return true;
  }
  if (data.startsWith('speekf:')) {
    // Open the full paginated transcript as a fresh window (newest page first).
    sendSessionScroll(bot, chatId, data.substring(7), null, null);
    bot.answerCallbackQuery(query.id, { text: '📜 כל ההודעות' });
    return true;
  }
  if (data.startsWith('speekp:')) {
    // Navigate the paginated transcript in place (edit the same window).
    const parts = data.split(':'); // speekp : <short> : <page>
    sendSessionScroll(bot, chatId, parts[1], parseInt(parts[2], 10), query.message.message_id);
    bot.answerCallbackQuery(query.id);
    return true;
  }
  if (data === 'sarclist') {
    sendArchivedList(bot, chatId);
    bot.answerCallbackQuery(query.id);
    return true;
  }
  if (data.startsWith('snote:')) {
    const short = data.substring(6);
    const s = unifiedSessions.findSessionByShortId(short);
    if (!s) { bot.answerCallbackQuery(query.id, { text: '❌ Not found' }); return true; }
    pendingSessionNotes.set(chatId, s.id);
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, '📝 Note for this session:', {
      reply_markup: { force_reply: true, selective: true }
    });
    return true;
  }
  if (data.startsWith('sarc:')) {
    const short = data.substring(5);
    const s = unifiedSessions.findSessionByShortId(short);
    if (s) sessionMeta.archive(s.id);
    bot.answerCallbackQuery(query.id, { text: '🗄 Archived' });
    sendSessionDetail(bot, chatId, short);
    return true;
  }
  if (data.startsWith('sunarc:')) {
    const short = data.substring(7);
    const s = unifiedSessions.findSessionByShortId(short);
    if (s) sessionMeta.unarchive(s.id);
    bot.answerCallbackQuery(query.id, { text: '↩ Unarchived' });
    sendSessionDetail(bot, chatId, short);
    return true;
  }
  if (data.startsWith('smac:')) {
    const short = data.substring(5);
    const s = unifiedSessions.findSessionByShortId(short);
    if (!s) { bot.answerCallbackQuery(query.id, { text: '❌ Not found' }); return true; }
    const flags = s.flags?.join(' ') || '--dangerously-skip-permissions';
    const resumeCmd = `cd "${s.projectPath}" && claude --resume '${s.id}' ${flags}`.trim();
    bot.answerCallbackQuery(query.id, { text: '🖥 Move to Mac' });
    bot.sendMessage(chatId, `🖥 *Resume on Mac:*\n\`\`\`bash\n${resumeCmd}\n\`\`\``, { parse_mode: 'Markdown' });
    return true;
  }

  // Mode selection
  if (data.startsWith('mode:')) {
    const newMode = data.substring(5);
    userState.currentMode = newMode;
    scheduleSave();

    const modeNames = { 'default': '🔒 Default', 'fast': '⚡ Fast', 'plan': '📋 Plan', 'yolo': '🔥 YOLO' };
    bot.answerCallbackQuery(query.id, { text: `✅ Mode: ${modeNames[newMode]}` });
    bot.sendMessage(chatId, `✅ Mode changed to *${modeNames[newMode]}*`, { parse_mode: 'Markdown' });
    return true;
  }

  // Model selection — restart a running session on the new model, keeping context via --resume
  if (data.startsWith('model:')) {
    const raw = data.substring(6);
    const newModel = raw === 'default' ? null : raw;
    userState.model = newModel;
    scheduleSave();

    const label = modelLabel(newModel);
    bot.answerCallbackQuery(query.id, { text: `✅ Model: ${label}` });

    if (userState.interactiveProc) {
      const resumeId = userState.interactiveSessionId;
      stopInteractiveSession(userState);
      if (resumeId) {
        bot.sendMessage(chatId, `🤖 Switching to *${label}* and resuming this conversation…`, { parse_mode: 'Markdown' });
        startInteractiveSession(userState, chatId, bot, resumeId);
      } else {
        bot.sendMessage(chatId, `🤖 Model set to *${label}*. Next message starts a session on it.`, { parse_mode: 'Markdown' });
      }
    } else {
      bot.sendMessage(chatId, `🤖 Model set to *${label}*. It applies to your next session.`, { parse_mode: 'Markdown' });
    }
    return true;
  }

  // Session mode toggle
  if (data.startsWith('session:')) {
    const mode = data.substring(8);
    if (mode === 'on') {
      userState.sessionMode = true;
      scheduleSave();
      bot.answerCallbackQuery(query.id, { text: '✅ Session mode enabled' });
      bot.sendMessage(chatId, '💬 *Session mode enabled*\nMessages will continue conversation.', { parse_mode: 'Markdown' });
    } else {
      stopInteractiveSession(userState);  // Stop interactive when switching to on-demand
      userState.sessionMode = false;
      clearSession(chatId);
      scheduleSave();
      bot.answerCallbackQuery(query.id, { text: '✅ On-demand mode' });
      bot.sendMessage(chatId, '⚡ *On-demand mode enabled*\nEach message is independent.', { parse_mode: 'Markdown' });
    }
    return true;
  }

  // Interactive mode toggle
  if (data.startsWith('interactive:')) {
    const mode = data.substring(12);
    if (mode === 'on') {
      userState.interactiveMode = true;
      scheduleSave();
      bot.answerCallbackQuery(query.id, { text: '✅ Interactive mode enabled' });
      bot.sendMessage(chatId, '🔄 *Interactive mode enabled*\nClaude will run as persistent process.', { parse_mode: 'Markdown' });
    } else if (mode === 'cancel') {
      // Cancel current request
      if (userState.interactiveProc) {
        userState.interactiveProc.kill();
        bot.answerCallbackQuery(query.id, { text: '🛑 Cancelled' });
        // Delete thinking message
        if (userState.interactiveThinkingMsgId) {
          try { bot.deleteMessage(chatId, userState.interactiveThinkingMsgId); } catch (e) {}
          userState.interactiveThinkingMsgId = null;
        }
        bot.sendMessage(chatId, '🛑 Request cancelled');
      } else {
        bot.answerCallbackQuery(query.id, { text: 'Nothing to cancel' });
      }
    } else {
      stopInteractiveSession(userState);
      userState.interactiveMode = false;
      scheduleSave();
      bot.answerCallbackQuery(query.id, { text: '✅ Interactive mode disabled' });
      bot.sendMessage(chatId, '⚡ *Interactive mode disabled*\nEach message spawns new process.', { parse_mode: 'Markdown' });
    }
    return true;
  }

  // Terminal mode toggle
  if (data.startsWith('terminal:')) {
    const mode = data.substring(9);
    if (mode === 'on') {
      userState.showTerminal = true;
      scheduleSave();
      bot.answerCallbackQuery(query.id, { text: '✅ Terminal enabled' });
      bot.sendMessage(chatId, '🖥 *Terminal mode enabled*\nClaude will open in visible iTerm window.', { parse_mode: 'Markdown' });
    } else {
      userState.showTerminal = false;
      scheduleSave();
      bot.answerCallbackQuery(query.id, { text: '✅ Terminal disabled' });
      bot.sendMessage(chatId, '🔇 *Terminal mode disabled*\nClaude runs in background.', { parse_mode: 'Markdown' });
    }
    return true;
  }

  // Get voice for last message (clickable button)
  if (data.startsWith('getvoice:')) {
    const voiceId = data.substring(9);
    const text = pendingLogs.get(voiceId);
    if (text && text.length > 10) {
      bot.answerCallbackQuery(query.id, { text: '🔊 Generating voice...' });
      try {
        const voiceResult = await generateVoice(text, userState.voiceSettings);
        if (voiceResult && voiceResult.buffer) {
          await bot.sendVoice(chatId, voiceResult.buffer, {
            caption: '🔊 Voice response'
          }, {
            filename: `response.${voiceResult.format}`,
            contentType: voiceResult.format === 'wav' ? 'audio/wav' : 'audio/mpeg'
          });
          // Remove the voice button after generating
          try {
            const currentText = query.message.text;
            const remainingButtons = query.message.reply_markup?.inline_keyboard?.[0]?.filter(
              b => !b.callback_data.startsWith('getvoice:')
            ) || [];
            if (remainingButtons.length > 0) {
              bot.editMessageReplyMarkup({ inline_keyboard: [remainingButtons] }, {
                chat_id: chatId,
                message_id: query.message.message_id
              });
            } else {
              bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                chat_id: chatId,
                message_id: query.message.message_id
              });
            }
          } catch (e) {}
        }
      } catch (err) {
        bot.sendMessage(chatId, `❌ Voice error: ${err.message}`);
      }
      pendingLogs.delete(voiceId);
    } else {
      bot.answerCallbackQuery(query.id, { text: '❌ Text expired' });
    }
    return true;
  }

  // Show process log (clickable button)
  if (data.startsWith('showlog:')) {
    const logId = data.substring(8);
    const log = pendingLogs.get(logId);
    if (log && Array.isArray(log) && log.length > 0) {
      const logLines = log.map((step, i) => `${i + 1}. ${step}`).join('\n');
      const logText = `🧠 *Thought Process:*\n\`\`\`\n${logLines}\n\`\`\``;
      bot.answerCallbackQuery(query.id, { text: '🧠 Showing log' });

      // Check if voice button exists (same timestamp)
      const timestamp = logId.substring(4); // Remove 'log_' prefix
      const voiceId = `voice_${timestamp}`;
      const voiceText = pendingLogs.get(voiceId);

      // Build keyboard - keep voice button if available
      const keyboard = voiceText ? [[{ text: 'voice', callback_data: `getvoice:${voiceId}` }]] : [];

      // Edit the message to include the log
      try {
        const currentText = query.message.text;
        await bot.editMessageText(`${currentText}\n\n${logText}`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined
        });
      } catch (e) {
        // If edit fails, send as new message
        bot.sendMessage(chatId, logText, { parse_mode: 'Markdown' });
      }
      pendingLogs.delete(logId);
    } else {
      bot.answerCallbackQuery(query.id, { text: '❌ Log expired' });
    }
    return true;
  }

  // Thought process log mode (off/on/auto)
  if (data.startsWith('thought:')) {
    const mode = data.substring(8);
    console.log(`[thought callback] data=${data}, mode=${mode}`);
    userState.thoughtMode = mode;
    scheduleSave();
    const modeIcons = { off: '🔇', on: '🧠', auto: '✨' };
    const modeNames = { off: 'OFF', on: 'ON', auto: 'AUTO' };
    bot.answerCallbackQuery(query.id, { text: `${modeIcons[mode]} Thought ${modeNames[mode]}` });
    bot.sendMessage(chatId, `${modeIcons[mode]} Thought log *${modeNames[mode]}*`, { parse_mode: 'Markdown' });
    return true;
  }

  // Persist session toggle
  if (data.startsWith('persist:')) {
    const mode = data.substring(8);
    if (mode === 'on') {
      userState.persistSession = true;
      scheduleSave();
      bot.answerCallbackQuery(query.id, { text: '✅ Persistence enabled' });
      bot.sendMessage(chatId, '💾 *Session persistence enabled*\nYour session will survive bot restarts.', { parse_mode: 'Markdown' });
    } else {
      userState.persistSession = false;
      scheduleSave();
      bot.answerCallbackQuery(query.id, { text: '✅ Persistence disabled' });
      bot.sendMessage(chatId, '🔄 *Session persistence disabled*\nBot restarts will start fresh.', { parse_mode: 'Markdown' });
    }
    return true;
  }

  // Unified session resume (from unified registry)
  if (data.startsWith('uresume:')) {
    const shortId = data.substring(8);
    const session = unifiedSessions.findSessionByShortId(shortId);

    if (!session) {
      bot.answerCallbackQuery(query.id, { text: '❌ Session not found' });
      return true;
    }

    // Guard: a session whose origin folder is gone can't be resumed. Bail out
    // BEFORE mutating state / sending a misleading "resumed" message, so we
    // don't fall through and start an unrelated session.
    const originPath = findSessionProjectPath(session.id);
    if (!originPath) {
      unifiedSessions.removeSession?.(session.id);
      bot.answerCallbackQuery(query.id, { text: '❌ Session gone' });
      bot.sendMessage(chatId,
        `⚠️ Can't resume session \`${String(session.id).slice(0, 8)}\` — its project folder no longer exists, so this conversation is gone.\n\nI've removed it from the list.`,
        { parse_mode: 'Markdown' }
      );
      return true;
    }

    // Stop any existing interactive session
    stopInteractiveSession(userState);

    // Switch to the session's real origin project (not the possibly-stale
    // projectPath recorded in the registry).
    userState.currentPath = originPath;
    userState.currentProject = path.basename(originPath);
    userState.sessionMode = true;
    scheduleSave();

    // Set up local session tracking
    setSession(chatId, session.id, originPath, session.topic);

    // Update unified registry
    unifiedSessions.updateSession(session.id, {
      lastUsed: new Date().toISOString()
    });

    bot.answerCallbackQuery(query.id, { text: '✅ Session resumed' });

    const sourceIcon = session.source === 'telegram' ? '📱' : '🖥';
    const modeIcon = unifiedSessions.getModeIcon(session.mode);

    // If interactive mode, start with resume
    if (userState.interactiveMode) {
      const started = startInteractiveSession(userState, chatId, bot, session.id);
      if (!started) return true;  // abort already messaged the user
      bot.sendMessage(chatId,
        `${sourceIcon} *Resuming session*\n\n` +
        `📝 Topic: ${session.topic || '(none)'}\n` +
        `📁 Project: *${userState.currentProject}*\n` +
        `💬 Messages: ${session.messageCount} ${modeIcon}\n\n` +
        `Interactive session started with --resume.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      bot.sendMessage(chatId,
        `${sourceIcon} *Session resumed*\n\n` +
        `📝 Topic: ${session.topic || '(none)'}\n` +
        `📁 Project: *${userState.currentProject}*\n` +
        `💬 Messages: ${session.messageCount} ${modeIcon}\n\n` +
        `Type your next message to continue.`,
        { parse_mode: 'Markdown' }
      );
    }
    return true;
  }

  // Move to Mac - show resume command for terminal
  if (data === 'cmd:move_to_mac') {
    const currentSession = getSession(chatId);
    if (!currentSession) {
      bot.answerCallbackQuery(query.id, { text: '❌ No active session' });
      bot.sendMessage(chatId, '❌ No active session to move');
      return true;
    }

    const uSession = unifiedSessions.findSession(currentSession.sessionId);
    const flags = uSession?.flags?.join(' ') || getModeFlag(userState.currentMode) || '';
    const resumeCmd = `cd "${currentSession.projectPath}" && claude --resume '${currentSession.sessionId}' ${flags}`.trim();
    const shortId = currentSession.sessionId.substring(0, 8);

    bot.answerCallbackQuery(query.id, { text: '🖥 Move to Mac' });
    bot.sendMessage(chatId,
      `🖥 *Session ready on Mac!*\n\n` +
      `*Topic:* ${currentSession.topic || '(none)'}\n` +
      `*Path:* \`${currentSession.projectPath}\`\n` +
      `*Mode:* ${userState.currentMode}\n\n` +
      `*Run this command:*\n\`\`\`bash\n${resumeCmd}\n\`\`\``,
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  // Session resume
  if (data.startsWith('resume:')) {
    const shortId = data.substring(7);

    if (shortId === 'clear') {
      clearHistory(chatId);
      bot.answerCallbackQuery(query.id, { text: '✅ History cleared' });
      bot.sendMessage(chatId, '🗑 Session history cleared.');
      return true;
    }

    const session = getSessionByShortId(chatId, shortId);
    if (!session) {
      bot.answerCallbackQuery(query.id, { text: '❌ Session not found' });
      return true;
    }

    resumeSession(chatId, session);
    userState.sessionMode = true;
    userState.currentPath = session.projectPath;
    userState.currentProject = path.basename(session.projectPath);
    scheduleSave();

    bot.answerCallbackQuery(query.id, { text: '✅ Session resumed' });
    bot.sendMessage(chatId,
      `💬 *Session resumed*\n\n` +
      `📁 Project: *${userState.currentProject}*\n` +
      `📝 Topic: ${session.topic || '(none)'}\n` +
      `💬 Messages: ${session.messageCount}\n\n` +
      `Type your next message to continue.`,
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  // CLI session resume (Mac sessions)
  if (data.startsWith('cli:')) {
    const shortId = data.substring(4);

    // Find the CLI session
    const cliSessions = getCliSessions(userState.currentPath, 20);
    const session = cliSessions.find(s => s.sessionId.startsWith(shortId));

    if (!session) {
      bot.answerCallbackQuery(query.id, { text: '❌ Session not found' });
      return true;
    }

    // Stop any existing interactive session
    stopInteractiveSession(userState);

    // Enable session mode and set the CLI session to resume
    userState.sessionMode = true;
    userState.pendingCliResume = session.sessionId;  // Store for next message
    scheduleSave();

    bot.answerCallbackQuery(query.id, { text: '✅ Mac session selected' });

    // If interactive mode, start with resume
    if (userState.interactiveMode) {
      const started = startInteractiveSession(userState, chatId, bot, session.sessionId);
      if (!started) return true;  // abort already messaged the user
      bot.sendMessage(chatId,
        `🖥 *Resuming Mac session*\n\n` +
        `📝 Topic: ${session.topic || '(none)'}\n` +
        `💬 Messages: ${session.messageCount}\n\n` +
        `Interactive session started with --resume.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      // For non-interactive, store sessionId and use on next message
      setSession(chatId, session.sessionId, userState.currentPath, session.topic);
      bot.sendMessage(chatId,
        `🖥 *Mac session ready to resume*\n\n` +
        `📝 Topic: ${session.topic || '(none)'}\n` +
        `💬 Messages: ${session.messageCount}\n\n` +
        `Send your next message to continue this session.`,
        { parse_mode: 'Markdown' }
      );
    }
    return true;
  }

  // CLI browse - list projects or show project sessions
  if (data.startsWith('clibrowse:')) {
    const action = data.substring(10);

    if (action === 'list') {
      bot.answerCallbackQuery(query.id, { text: '📂 Projects' });
      sendProjectsSessionsMenu(bot, chatId);
      return true;
    }

    if (action === 'back') {
      bot.answerCallbackQuery(query.id, { text: '⬅️ Back' });
      sendSessionsMenu(bot, chatId);
      return true;
    }

    // Show sessions for specific project
    bot.answerCallbackQuery(query.id, { text: '📁 Loading...' });
    sendProjectSessionsList(bot, chatId, action);
    return true;
  }

  // CLI project session resume (from browse)
  if (data.startsWith('cliproj:')) {
    const parts = data.substring(8).split(':');
    const encodedPath = parts[0];
    const shortId = parts[1];

    // Find project and session
    const projects = getCliProjects();
    const project = projects.find(p => p.encoded.startsWith(encodedPath));

    if (!project) {
      bot.answerCallbackQuery(query.id, { text: '❌ Project not found' });
      return true;
    }

    const sessions = getCliSessions(project.decoded, 20);
    const session = sessions.find(s => s.sessionId.startsWith(shortId));

    if (!session) {
      bot.answerCallbackQuery(query.id, { text: '❌ Session not found' });
      return true;
    }

    // Stop any existing interactive session
    stopInteractiveSession(userState);

    // Switch to the project and set up session
    userState.currentPath = project.decoded;
    userState.currentProject = project.name;
    userState.sessionMode = true;
    scheduleSave();

    bot.answerCallbackQuery(query.id, { text: '✅ Session selected' });

    // If interactive mode, start with resume
    if (userState.interactiveMode) {
      const started = startInteractiveSession(userState, chatId, bot, session.sessionId);
      if (!started) return true;  // abort already messaged the user
      bot.sendMessage(chatId,
        `🖥 *Resuming session from ${project.name}*\n\n` +
        `📝 Topic: ${session.topic || '(none)'}\n` +
        `💬 Messages: ${session.messageCount}\n\n` +
        `Interactive session started with --resume.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      setSession(chatId, session.sessionId, project.decoded, session.topic);
      bot.sendMessage(chatId,
        `🖥 *Session ready from ${project.name}*\n\n` +
        `📝 Topic: ${session.topic || '(none)'}\n` +
        `💬 Messages: ${session.messageCount}\n\n` +
        `📁 Switched to: ${project.decoded}\n\n` +
        `Send your next message to continue.`,
        { parse_mode: 'Markdown' }
      );
    }
    return true;
  }

  // Command callbacks
  if (data === 'cmd:sessions') {
    bot.answerCallbackQuery(query.id, { text: '/sessions' });
    sendSessionsMenu(bot, chatId);
    return true;
  }

  if (data === 'cmd:session') {
    bot.answerCallbackQuery(query.id, { text: '/session' });
    const session = getSession(chatId);
    const modeIcon = userState.sessionMode ? '💬' : '⚡';
    const modeName = userState.sessionMode ? 'Session' : 'On-Demand';
    let statusText = `⚙️ *Conversation Mode*\n\nCurrent: ${modeIcon} *${modeName}*\n`;
    if (userState.sessionMode && session) {
      statusText += `\n📍 Active session:\nID: \`${session.sessionId.substring(0, 8)}...\`\nMessages: ${session.messageCount}\n`;
    } else if (userState.sessionMode) {
      statusText += `\nNo active session yet. Send a message to start one.\n`;
    }
    statusText += `\n⚡ On-demand = each message independent\n💬 Session = Claude remembers context`;
    const keyboard = [[
      { text: userState.sessionMode ? '⚡ Switch to On-Demand' : '✓ ⚡ On-Demand', callback_data: 'session:off' },
      { text: userState.sessionMode ? '✓ 💬 Session' : '💬 Switch to Session', callback_data: 'session:on' }
    ]];
    bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    return true;
  }

  if (data === 'cmd:new') {
    bot.answerCallbackQuery(query.id, { text: '/new' });
    stopInteractiveSession(userState);  // Stop interactive when starting fresh
    clearSession(chatId);
    bot.sendMessage(chatId, '🆕 Started fresh session. Claude won\'t remember previous messages.');
    return true;
  }

  // Telegram Project - jump into the dedicated session rooted in the bot folder
  if (data === 'cmd:tgproject') {
    bot.answerCallbackQuery(query.id, { text: '🛠 Telegram Project' });
    const tgPath = path.join(require('os').homedir(), '.claude', 'telegram-bot');

    stopInteractiveSession(userState);
    userState.currentPath = tgPath;
    userState.currentProject = 'telegram-bot';
    userState.sessionMode = true;
    userState.interactiveMode = true;

    // Resume the latest session in the bot folder; start fresh if there is none
    const tgSessions = getCliSessions(tgPath, 20);
    const latest = tgSessions && tgSessions[0];
    scheduleSave();

    if (latest) {
      const started = startInteractiveSession(userState, chatId, bot, latest.sessionId);
      if (!started) return true;  // abort already messaged the user
      bot.sendMessage(chatId,
        `🛠 *Telegram Project*\n\n` +
        `📁 ${tgPath}\n` +
        `📝 Topic: ${latest.topic || '(none)'}\n` +
        `💬 Messages: ${latest.messageCount}\n\n` +
        `Resumed our project session. Just type to continue.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      const started = startInteractiveSession(userState, chatId, bot, null);
      if (!started) return true;
      bot.sendMessage(chatId,
        `🛠 *Telegram Project*\n\n` +
        `📁 ${tgPath}\n\n` +
        `No session yet — started a fresh one here. Just type to begin.`,
        { parse_mode: 'Markdown' }
      );
    }
    return true;
  }

  if (data === 'cmd:interactive') {
    bot.answerCallbackQuery(query.id, { text: '/interactive' });
    const modeIcon = userState.interactiveMode ? '🔄' : '⚡';
    const modeName = userState.interactiveMode ? 'ON' : 'OFF';
    const keyboard = [[
      { text: userState.interactiveMode ? '⚡ Turn OFF' : '🔄 Turn ON', callback_data: userState.interactiveMode ? 'interactive:off' : 'interactive:on' }
    ]];
    bot.sendMessage(chatId,
      `🔄 *Interactive Mode*\n\nCurrent: ${modeIcon} *${modeName}*`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
    return true;
  }

  if (data === 'cmd:terminal') {
    bot.answerCallbackQuery(query.id, { text: '/terminal' });
    const modeIcon = userState.showTerminal ? '🖥' : '🔇';
    const modeName = userState.showTerminal ? 'iTerm' : 'Background';
    const keyboard = [[
      { text: userState.showTerminal ? '🔇 Background' : '🖥 iTerm', callback_data: userState.showTerminal ? 'terminal:off' : 'terminal:on' }
    ]];
    bot.sendMessage(chatId,
      `🖥 *Terminal Display*\n\nCurrent: ${modeIcon} *${modeName}*`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
    return true;
  }

  if (data === 'cmd:resume') {
    bot.answerCallbackQuery(query.id, { text: '/resume' });
    sendSessionsMenu(bot, chatId);
    return true;
  }

  if (data === 'cmd:mode') {
    bot.answerCallbackQuery(query.id, { text: '/mode' });
    sendModeMenu(bot, chatId, userState);
    return true;
  }

  if (data === 'cmd:cancel') {
    bot.answerCallbackQuery(query.id, { text: '/cancel' });
    if (userState.currentClaudeProc) {
      userState.currentClaudeProc.kill();
      userState.currentClaudeProc = null;
      userState.isProcessing = false;
      bot.sendMessage(chatId, '🛑 Cancelled your request');
    } else if (userState.interactiveProc) {
      userState.interactiveProc.kill();
      bot.sendMessage(chatId, '🛑 Cancelled interactive request');
    } else {
      bot.sendMessage(chatId, '✅ Nothing to cancel');
    }
    return true;
  }

  if (data === 'cmd:persist') {
    bot.answerCallbackQuery(query.id, { text: '/persist' });
    const persistIcon = userState.persistSession ? '💾' : '🔄';
    const persistName = userState.persistSession ? 'ON' : 'OFF';
    const keyboard = [[
      { text: userState.persistSession ? '🔄 Disable' : '💾 Enable', callback_data: userState.persistSession ? 'persist:off' : 'persist:on' }
    ]];
    bot.sendMessage(chatId,
      `💾 *Session Persistence*\n\nCurrent: ${persistIcon} *${persistName}*\n\n` +
      `When ON, your active session survives bot restarts.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
    return true;
  }

  if (data === 'cmd:thought') {
    bot.answerCallbackQuery(query.id, { text: '/thought' });
    const mode = userState.thoughtMode || 'off';
    const modeIcons = { off: '🔇', on: '🧠', auto: '✨' };
    const modeNames = { off: 'OFF', on: 'ON (button)', auto: 'AUTO' };
    const keyboard = [
      [
        { text: mode === 'off' ? '✓ 🔇 Off' : '🔇 Off', callback_data: 'thought:off' },
        { text: mode === 'on' ? '✓ 🧠 On' : '🧠 On', callback_data: 'thought:on' },
        { text: mode === 'auto' ? '✓ ✨ Auto' : '✨ Auto', callback_data: 'thought:auto' }
      ]
    ];
    bot.sendMessage(chatId,
      `🧠 *Thought Process Log*\n\nCurrent: ${modeIcons[mode]} *${modeNames[mode]}*\n\n` +
      `🔇 *Off* - No thought log\n` +
      `🧠 *On* - Click button to view\n` +
      `✨ *Auto* - Shows automatically`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
    return true;
  }

  return false;
}

module.exports = {
  register,
  handleMessage,
  handleCallback,
  handleNoteReply,
  sendSessionsMenu,
  sendModeMenu,
  runClaude,
  runClaudeStreaming,
  startInteractiveSession,
  stopInteractiveSession,
  sendToInteractive
};

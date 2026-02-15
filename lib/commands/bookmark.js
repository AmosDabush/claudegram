/**
 * Bookmark Command
 * /bookmark - Save current session as a resumable bookmark with inline button
 */

const path = require('path');
const { getUserState, scheduleSave } = require('../state');
const { getSession } = require('../sessions');
const unifiedSessions = require('../unified-sessions');

// Track users waiting to provide bookmark description
const pendingBookmarks = new Map();

/**
 * Register bookmark commands
 */
function register(bot, isAuthorized) {

  bot.onText(/\/bookmark(?:\s+(.+))?/, (msg, match) => {
    if (!isAuthorized(msg)) return;

    const chatId = msg.chat.id;
    const userState = getUserState(chatId);
    const description = match[1] || null;

    const localSession = getSession(chatId);
    const sessionId = userState.interactiveSessionId || (localSession && localSession.sessionId);

    if (!sessionId) {
      bot.sendMessage(chatId, 'No active session to bookmark.');
      return;
    }

    if (description) {
      sendBookmark(bot, chatId, userState, sessionId, description);
    } else {
      // Ask for description with force reply
      pendingBookmarks.set(chatId, { sessionId });
      bot.sendMessage(chatId, 'Describe this session:', {
        reply_markup: { force_reply: true, selective: true }
      });
    }
  });
}

/**
 * Check if a message is a bookmark reply
 */
function handleReply(msg, bot) {
  const chatId = msg.chat.id;
  if (!pendingBookmarks.has(chatId)) return false;
  if (!msg.reply_to_message || !msg.reply_to_message.text) return false;
  if (msg.reply_to_message.text !== 'Describe this session:') return false;

  const { sessionId } = pendingBookmarks.get(chatId);
  pendingBookmarks.delete(chatId);

  const userState = getUserState(chatId);
  const description = msg.text;

  if (!description) return true;

  sendBookmark(bot, chatId, userState, sessionId, description);
  return true;
}

/**
 * Send the bookmark message with resume button
 */
function sendBookmark(bot, chatId, userState, sessionId, description) {
  const shortId = sessionId.substring(0, 8);
  const project = userState.currentProject || path.basename(userState.currentPath);
  const date = new Date().toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const localSession = getSession(chatId);
  const unified = unifiedSessions.findSession(sessionId);
  const msgCount = (localSession && localSession.messageCount) || (unified && unified.messageCount) || 0;

  let text = `*Session Bookmark*\n\n` +
    `Project: *${project}*\n` +
    `Date: ${date}\n`;
  if (msgCount > 0) text += `Messages: ${msgCount}\n`;
  text += `Session: \`${shortId}\`\n\n` +
    `${description}\n\n` +
    `Tap to resume:`;

  bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{
        text: 'Resume Session',
        callback_data: `uresume:${shortId}`
      }]]
    }
  });
}

/**
 * Handle callbacks - bookmark uses existing uresume: handler in claude.js
 */
function handleCallback() {
  return false;
}

module.exports = { register, handleCallback, handleReply, pendingBookmarks };

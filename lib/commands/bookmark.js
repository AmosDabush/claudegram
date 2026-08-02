/**
 * Bookmark Command
 * /bookmark - Save current session as a resumable bookmark with inline button
 */

const path = require('path');
const { getUserState, scheduleSave } = require('../state');
const { getSession } = require('../sessions');
const unifiedSessions = require('../unified-sessions');
const bookmarksStore = require('../bookmarks-store');

// Track users waiting to provide bookmark description
const pendingBookmarks = new Map();

/**
 * Register bookmark commands
 */
function register(bot, isAuthorized) {

  // Anchored so it won't also fire on /bookmarks (plural).
  bot.onText(/\/bookmark(?:\s+(.+))?$/, (msg, match) => {
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

  // /bookmarks - show the full, persistent bookmark history (Mac-backed)
  bot.onText(/\/bookmarks$/, (msg) => {
    if (!isAuthorized(msg)) return;
    sendBookmarksList(bot, msg.chat.id);
  });
}

/**
 * Show all saved bookmarks as resume buttons, rebuilt fresh on demand.
 * This is the whole point: the list never scrolls away — summon it anytime.
 */
function sendBookmarksList(bot, chatId) {
  const items = bookmarksStore.list(chatId);

  if (!items.length) {
    bot.sendMessage(chatId, '🔖 No bookmarks yet.\nSave one with /bookmark while in a session.');
    return;
  }

  const keyboard = [];
  for (const b of items) {
    const shortId = String(b.shortId || b.id).substring(0, 8);

    // Ensure the resume path can resolve this session via the unified registry.
    if (!unifiedSessions.findSession(b.id)) {
      unifiedSessions.addSession({
        id: b.id,
        source: 'telegram',
        sourceId: String(chatId),
        topic: b.description,
        projectPath: b.projectPath,
        mode: b.mode || 'default',
        flags: [],
        messageCount: b.messageCount || 0,
        createdAt: b.createdAt,
        lastUsed: b.createdAt
      });
    }

    const label = String(b.description || '(no description)').substring(0, 38);
    const project = b.projectPath ? path.basename(b.projectPath) : '?';
    keyboard.push([
      { text: `🔖 ${label} · ${project}`, callback_data: `uresume:${shortId}` },
      { text: '🗑', callback_data: `bmdel:${shortId}` }
    ]);
  }

  bot.sendMessage(chatId, `🔖 *Your Bookmarks* (${items.length})\n\nTap to resume · 🗑 to remove:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
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

  // Persist to the on-disk bookmark history (source of truth, never scrolls away)
  bookmarksStore.add(chatId, {
    id: sessionId,
    shortId,
    projectPath: userState.currentPath,
    description,
    messageCount: msgCount,
    mode: userState.currentMode || 'default',
    createdAt: new Date().toISOString()
  });

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
 * Handle callbacks.
 * Resume itself uses the existing uresume: handler in claude.js.
 * Here we only handle removing a bookmark from the persistent list.
 */
function handleCallback(bot, query) {
  const data = query.data;
  if (!data) return false;

  if (data.startsWith('bmdel:')) {
    const shortId = data.substring(6);
    const chatId = query.message.chat.id;
    bookmarksStore.remove(chatId, shortId);
    bot.answerCallbackQuery(query.id, { text: '🗑 Removed' });
    // Re-render the list in place so it stays fresh
    bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    sendBookmarksList(bot, chatId);
    return true;
  }

  return false;
}

module.exports = { register, handleCallback, handleReply, pendingBookmarks };

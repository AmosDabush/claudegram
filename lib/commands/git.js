/**
 * Git Commands
 * /status, /gs, /branch, /branches, /repo, /ls, /tree, /files
 */

const { getUserState } = require('../state');
const { runQuickCommand } = require('../utils');
const sh = require('../shell-compat');
const path = require('path');

/**
 * Register git/file commands
 */
function register(bot, isAuthorized) {

  // /status or /gs - git status
  bot.onText(/\/(status|gs)/, async (msg) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const output = await runQuickCommand('git status', userState.currentPath);
    bot.sendMessage(msg.chat.id, `📊 Git Status:\n\`\`\`\n${output.substring(0, 3500)}\n\`\`\``, { parse_mode: 'Markdown' });
  });

  // /branch - current branch
  bot.onText(/\/branch$/, async (msg) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const branch = await runQuickCommand('git branch --show-current', userState.currentPath);
    const remote = await runQuickCommand(sh.REMOTE_URL, userState.currentPath);
    bot.sendMessage(msg.chat.id, `🌿 Branch: *${branch}*\n🔗 Remote: \`${remote}\``, { parse_mode: 'Markdown' });
  });

  // /branches - all branches
  bot.onText(/\/branches/, async (msg) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const output = await runQuickCommand('git branch -a', userState.currentPath);
    bot.sendMessage(msg.chat.id, `🌿 Branches:\n\`\`\`\n${output.substring(0, 3500)}\n\`\`\``, { parse_mode: 'Markdown' });
  });

  // /repo - git repo info
  bot.onText(/\/repo/, async (msg) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);

    const [branch, remote, lastCommit, status] = await Promise.all([
      runQuickCommand('git branch --show-current', userState.currentPath),
      runQuickCommand(sh.REMOTE_URL, userState.currentPath),
      runQuickCommand('git log -1 --pretty=format:"%h - %s (%ar)"', userState.currentPath),
      runQuickCommand(sh.head('git status --short', 10), userState.currentPath)
    ]);

    let msg_text = `📦 *Repo Info*\n\n`;
    msg_text += `📁 Project: *${userState.currentProject}*\n`;
    msg_text += `🌿 Branch: *${branch}*\n`;
    msg_text += `🔗 Remote: \`${remote}\`\n`;
    msg_text += `📝 Last commit: ${lastCommit}\n`;
    if (status && status !== 'No output') {
      msg_text += `\n📊 Changes:\n\`\`\`\n${status}\n\`\`\``;
    } else {
      msg_text += `\n✅ Working tree clean`;
    }

    bot.sendMessage(msg.chat.id, msg_text, { parse_mode: 'Markdown' });
  });

  // /ls - quick folder listing
  bot.onText(/\/ls(?:\s+(.+))?/, async (msg, match) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const subpath = match[1] ? path.resolve(userState.currentPath, match[1]) : userState.currentPath;
    const output = await runQuickCommand(sh.listDir(subpath), userState.currentPath);
    bot.sendMessage(msg.chat.id, `📂 \`${subpath}\`\n\`\`\`\n${output.substring(0, 3500)}\n\`\`\``, { parse_mode: 'Markdown' });
  });

  // /tree - folder structure
  bot.onText(/\/tree(?:\s+(.+))?/, async (msg, match) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const depth = match[1] || '2';
    const output = await runQuickCommand(
      sh.tree(Number(depth)),
      userState.currentPath
    );
    bot.sendMessage(msg.chat.id, `🌳 *${userState.currentProject}* (depth ${depth}):\n\`\`\`\n${output.substring(0, 3500)}\n\`\`\``, { parse_mode: 'Markdown' });
  });

  // /files - list files
  bot.onText(/\/files(?:\s+(.+))?/, async (msg, match) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const pattern = match[1] || '*';
    const output = await runQuickCommand(sh.findFiles(pattern, 50), userState.currentPath);
    bot.sendMessage(msg.chat.id, `📄 Files (${pattern}):\n\`\`\`\n${output.substring(0, 3500)}\n\`\`\``, { parse_mode: 'Markdown' });
  });

  // /git - git commands menu
  bot.onText(/\/git$/, async (msg) => {
    if (!isAuthorized(msg)) return;
    sendGitMenu(bot, msg.chat.id);
  });
}

/**
 * Send git commands menu
 */
function sendGitMenu(bot, chatId) {
  const keyboard = [
    [{ text: '📊 Status', callback_data: 'cmd:status' }],
    [{ text: '🌿 Branch', callback_data: 'cmd:branch' }, { text: '🌲 All Branches', callback_data: 'cmd:branches' }],
    [{ text: '📦 Repo Info', callback_data: 'cmd:repo' }],
    [{ text: '📂 List Files (ls)', callback_data: 'cmd:ls' }],
    [{ text: '🌳 Tree View', callback_data: 'cmd:tree' }, { text: '🔍 Find Files', callback_data: 'cmd:files' }]
  ];

  bot.sendMessage(chatId, `🌿 *Git Commands*\n\nSelect an action:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

/**
 * Handle git-related callbacks
 */
function handleCallback(bot, query, userState) {
  const data = query.data;
  const chatId = query.message.chat.id;

  if (data === 'cmd:status') {
    bot.answerCallbackQuery(query.id, { text: '/status' });
    runQuickCommand('git status', userState.currentPath).then(output => {
      bot.sendMessage(chatId, `📊 Git Status:\n\`\`\`\n${output.substring(0, 3500)}\n\`\`\``, { parse_mode: 'Markdown' });
    });
    return true;
  }

  if (data === 'cmd:branch') {
    bot.answerCallbackQuery(query.id, { text: '/branch' });
    Promise.all([
      runQuickCommand('git branch --show-current', userState.currentPath),
      runQuickCommand(sh.REMOTE_URL, userState.currentPath)
    ]).then(([branch, remote]) => {
      bot.sendMessage(chatId, `🌿 Branch: *${branch}*\n🔗 Remote: \`${remote}\``, { parse_mode: 'Markdown' });
    });
    return true;
  }

  if (data === 'cmd:branches') {
    bot.answerCallbackQuery(query.id, { text: '/branches' });
    runQuickCommand('git branch -a', userState.currentPath).then(output => {
      bot.sendMessage(chatId, `🌿 Branches:\n\`\`\`\n${output.substring(0, 3500)}\n\`\`\``, { parse_mode: 'Markdown' });
    });
    return true;
  }

  if (data === 'cmd:repo') {
    bot.answerCallbackQuery(query.id, { text: '/repo' });
    Promise.all([
      runQuickCommand('git branch --show-current', userState.currentPath),
      runQuickCommand(sh.REMOTE_URL, userState.currentPath),
      runQuickCommand('git log -1 --pretty=format:"%h - %s (%ar)"', userState.currentPath),
      runQuickCommand(sh.head('git status --short', 10), userState.currentPath)
    ]).then(([branch, remote, lastCommit, status]) => {
      let msg_text = `📦 *Repo Info*\n\n`;
      msg_text += `📁 Project: *${userState.currentProject}*\n`;
      msg_text += `🌿 Branch: *${branch}*\n`;
      msg_text += `🔗 Remote: \`${remote}\`\n`;
      msg_text += `📝 Last commit: ${lastCommit}\n`;
      if (status && status !== 'No output') {
        msg_text += `\n📊 Changes:\n\`\`\`\n${status}\n\`\`\``;
      } else {
        msg_text += `\n✅ Working tree clean`;
      }
      bot.sendMessage(chatId, msg_text, { parse_mode: 'Markdown' });
    });
    return true;
  }

  if (data === 'cmd:ls') {
    bot.answerCallbackQuery(query.id, { text: '/ls' });
    runQuickCommand(sh.listDir(userState.currentPath), userState.currentPath).then(output => {
      bot.sendMessage(chatId, `📂 \`${userState.currentPath}\`\n\`\`\`\n${output.substring(0, 3500)}\n\`\`\``, { parse_mode: 'Markdown' });
    });
    return true;
  }

  if (data === 'cmd:tree') {
    bot.answerCallbackQuery(query.id, { text: '/tree' });
    runQuickCommand(
      sh.tree(2),
      userState.currentPath
    ).then(output => {
      bot.sendMessage(chatId, `🌳 *${userState.currentProject}* (depth 2):\n\`\`\`\n${output.substring(0, 3500)}\n\`\`\``, { parse_mode: 'Markdown' });
    });
    return true;
  }

  if (data === 'cmd:files') {
    bot.answerCallbackQuery(query.id, { text: '/files' });
    runQuickCommand(sh.findFiles('*', 50), userState.currentPath).then(output => {
      bot.sendMessage(chatId, `📄 Files:\n\`\`\`\n${output.substring(0, 3500)}\n\`\`\``, { parse_mode: 'Markdown' });
    });
    return true;
  }

  if (data === 'cmd:git') {
    bot.answerCallbackQuery(query.id, { text: '/git' });
    sendGitMenu(bot, chatId);
    return true;
  }

  return false;
}

module.exports = { register, handleCallback, sendGitMenu };

/**
 * Navigation Commands
 * /projects, /browse, /cd, /pwd, /project, /add
 */

const fs = require('fs');
const path = require('path');
const { getUserState } = require('../state');
const { getProjects, addProject, getProjectPath, hasProject } = require('../state');
const { isGitRepo, getBrowseContents, cachePath, getPathFromCache } = require('../utils');
const { stopInteractiveSession } = require('./claude');

/**
 * Register navigation commands
 */
function register(bot, isAuthorized) {

  // /projects - show clickable project buttons
  bot.onText(/\/projects/, (msg) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const projects = getProjects();
    const projectNames = Object.keys(projects);

    // Create buttons in rows of 2
    const keyboard = [];
    for (let i = 0; i < projectNames.length; i += 2) {
      const row = [];
      row.push({
        text: projectNames[i] === userState.currentProject ? `✓ ${projectNames[i]}` : projectNames[i],
        callback_data: `proj:${projectNames[i]}`
      });
      if (projectNames[i + 1]) {
        row.push({
          text: projectNames[i + 1] === userState.currentProject ? `✓ ${projectNames[i + 1]}` : projectNames[i + 1],
          callback_data: `proj:${projectNames[i + 1]}`
        });
      }
      keyboard.push(row);
    }

    bot.sendMessage(msg.chat.id, `📁 *Select a project:*\n\nCurrent: *${userState.currentProject}*`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  });

  // /project <name> - switch to project
  bot.onText(/\/project\s+(.+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const projectName = match[1].trim().toLowerCase();
    const projectPath = getProjectPath(projectName);

    if (projectPath) {
      userState.currentProject = projectName;
      userState.currentPath = projectPath;
      bot.sendMessage(msg.chat.id, `✅ Switched to *${projectName}*\n\`${userState.currentPath}\``, { parse_mode: 'Markdown' });
    } else if (fs.existsSync(projectName) || fs.existsSync(path.resolve(userState.currentPath, projectName))) {
      // Allow direct path
      const fullPath = fs.existsSync(projectName) ? projectName : path.resolve(userState.currentPath, projectName);
      userState.currentProject = path.basename(fullPath);
      userState.currentPath = fullPath;
      bot.sendMessage(msg.chat.id, `✅ Switched to *${userState.currentProject}*\n\`${userState.currentPath}\``, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(msg.chat.id, `❌ Project "${projectName}" not found.\nUse /projects to see available projects or /add to add one.`);
    }
  });

  // /add <name> <path> - add project
  bot.onText(/\/add\s+(\S+)\s+(.+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;

    const name = match[1].trim().toLowerCase();
    let projectPath = match[2].trim();

    // Expand ~
    if (projectPath.startsWith('~')) {
      projectPath = projectPath.replace('~', process.env.HOME);
    }

    if (!fs.existsSync(projectPath)) {
      bot.sendMessage(msg.chat.id, `❌ Path does not exist: \`${projectPath}\``, { parse_mode: 'Markdown' });
      return;
    }

    addProject(name, projectPath);
    bot.sendMessage(msg.chat.id, `✅ Added project *${name}*\n\`${projectPath}\``, { parse_mode: 'Markdown' });
  });

  // /pwd - show current path and mode
  bot.onText(/\/pwd/, (msg) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const modeIcon = userState.sessionMode ? '💬' : '⚡';
    const modeName = userState.sessionMode ? 'Session' : 'On-Demand';
    const voiceIcon = userState.voiceEnabled ? '🔊' : '🔇';

    bot.sendMessage(msg.chat.id,
      `📁 Current: *${userState.currentProject}*\n\`${userState.currentPath}\`\nMode: ${modeIcon} ${modeName} | ${voiceIcon}`,
      { parse_mode: 'Markdown' }
    );
  });

  // /cd <path> - change directory
  bot.onText(/\/cd\s+(.+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    let newPath = match[1].trim();

    // Expand ~
    if (newPath.startsWith('~')) {
      newPath = newPath.replace('~', process.env.HOME);
    }

    // Resolve relative paths
    if (!path.isAbsolute(newPath)) {
      newPath = path.resolve(userState.currentPath, newPath);
    }

    if (!fs.existsSync(newPath)) {
      bot.sendMessage(msg.chat.id, `❌ Path does not exist: \`${newPath}\``, { parse_mode: 'Markdown' });
      return;
    }

    userState.currentPath = newPath;
    userState.currentProject = path.basename(newPath);
    bot.sendMessage(msg.chat.id, `✅ Changed to: \`${userState.currentPath}\``, { parse_mode: 'Markdown' });
  });

  // /browse - navigate folders with buttons
  bot.onText(/\/browse(?:\s+(.+))?/, (msg, match) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    let browsePath = match[1] ? match[1].trim() : userState.currentPath;

    if (browsePath.startsWith('~')) {
      browsePath = browsePath.replace('~', process.env.HOME);
    }

    if (!fs.existsSync(browsePath)) {
      bot.sendMessage(msg.chat.id, `❌ Path not found: ${browsePath}`);
      return;
    }

    const keyboard = buildBrowseKeyboard(browsePath);
    const isGit = isGitRepo(browsePath);

    bot.sendMessage(msg.chat.id,
      `📂 *Browse:* \`${browsePath}\`\n${isGit ? '📦 This is a git repo' : '📁 Navigate to select a folder'}\n\n📦 = git repo (click to select)\n📁 = folder (click to enter)`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
  });
}

/**
 * Build browse keyboard for a directory
 */
function buildBrowseKeyboard(dirPath) {
  const { folders } = getBrowseContents(dirPath);
  const keyboard = [];

  // Cache paths and use short IDs
  const selectId = cachePath(dirPath);

  // Select current path button
  keyboard.push([{
    text: '✅ SELECT THIS PATH',
    callback_data: `bs:${selectId}`
  }]);

  // Go up button if not at root
  const parentPath = path.dirname(dirPath);
  if (parentPath !== dirPath) {
    const upId = cachePath(parentPath);
    keyboard.push([{
      text: '⬆️ .. (go up)',
      callback_data: `bn:${upId}`
    }]);
  }

  // Folder buttons
  for (const f of folders) {
    const icon = f.isGit ? '📦' : '📁';
    const action = f.isGit ? 'bs' : 'bn';
    const folderId = cachePath(f.path);
    keyboard.push([{
      text: `${icon} ${f.name}`,
      callback_data: `${action}:${folderId}`
    }]);
  }

  return keyboard;
}

/**
 * Handle navigation callbacks
 */
function handleCallback(bot, query, userState) {
  const data = query.data;
  const chatId = query.message.chat.id;

  // Project selection
  if (data.startsWith('proj:')) {
    const projectName = data.substring(5);
    const projectPath = getProjectPath(projectName);

    if (projectPath) {
      // Stop interactive session when changing projects
      stopInteractiveSession(userState);

      userState.currentProject = projectName;
      userState.currentPath = projectPath;
      bot.answerCallbackQuery(query.id, { text: `✅ Switched to ${projectName}` });
      bot.sendMessage(chatId, `✅ Switched to *${projectName}*\n\`${userState.currentPath}\``, { parse_mode: 'Markdown' });
      return true;
    }
  }

  // Browse navigation
  if (data.startsWith('bn:')) {
    const pathId = data.substring(3);
    const navPath = getPathFromCache(pathId);

    if (!navPath || !fs.existsSync(navPath)) {
      bot.answerCallbackQuery(query.id, { text: '❌ Path not found - try /browse again' });
      return true;
    }

    const keyboard = buildBrowseKeyboard(navPath);
    const isGit = isGitRepo(navPath);

    bot.answerCallbackQuery(query.id, { text: `📂 ${path.basename(navPath)}` });

    try {
      bot.editMessageText(
        `📂 *Browse:* \`${navPath}\`\n${isGit ? '📦 This is a git repo' : '📁 Navigate to select a folder'}\n\n📦 = git repo (click to select)\n📁 = folder (click to enter)`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        }
      );
    } catch (e) {}
    return true;
  }

  // Browse selection
  if (data.startsWith('bs:')) {
    const pathId = data.substring(3);
    const selectPath = getPathFromCache(pathId);

    if (!selectPath) {
      bot.answerCallbackQuery(query.id, { text: '❌ Path expired - try /browse again' });
      return true;
    }

    // Stop interactive session when changing path
    stopInteractiveSession(userState);

    userState.currentPath = selectPath;
    userState.currentProject = path.basename(selectPath);

    bot.answerCallbackQuery(query.id, { text: `✅ Selected ${userState.currentProject}` });
    bot.sendMessage(chatId, `✅ Switched to *${userState.currentProject}*\n\`${userState.currentPath}\``, { parse_mode: 'Markdown' });
    return true;
  }

  return false;
}

module.exports = {
  register,
  handleCallback,
  buildBrowseKeyboard
};

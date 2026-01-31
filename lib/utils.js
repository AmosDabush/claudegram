/**
 * Utility Functions
 * Common helpers used across the bot
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { BOT_DIR } = require('./config');

/**
 * Send long messages in chunks (Telegram has 4096 char limit)
 * @param {Object} options - Optional Telegram options (parse_mode, reply_to_message_id, etc.)
 */
async function sendLongMessage(bot, chatId, text, options = {}) {
  const MAX_LENGTH = 4000;
  const chunks = [];

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point (newline)
    let breakPoint = remaining.lastIndexOf('\n', MAX_LENGTH);
    if (breakPoint === -1 || breakPoint < MAX_LENGTH / 2) {
      breakPoint = MAX_LENGTH;
    }

    chunks.push(remaining.substring(0, breakPoint));
    remaining = remaining.substring(breakPoint);
  }

  for (let i = 0; i < chunks.length; i++) {
    await bot.sendMessage(chatId, chunks[i], options);
  }
}

/**
 * Run a quick shell command and return output
 */
function runQuickCommand(cmd, cwd, timeout = 10000) {
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', cmd], { cwd, env: process.env });
    let output = '';

    proc.stdout.on('data', (data) => output += data.toString());
    proc.stderr.on('data', (data) => output += data.toString());

    proc.on('close', () => resolve(output.trim() || 'No output'));

    setTimeout(() => {
      proc.kill();
      resolve('Timeout');
    }, timeout);
  });
}

/**
 * Get mode flags for Claude CLI
 */
function getModeFlag(mode = 'default') {
  switch (mode) {
    case 'yolo': return '--dangerously-skip-permissions';
    case 'plan': return '--permission-mode plan';
    case 'fast': return '--tools ""';
    default: return '';
  }
}

/**
 * Check if directory is a git repo
 */
function isGitRepo(dirPath) {
  return fs.existsSync(path.join(dirPath, '.git'));
}

/**
 * Detect if text contains Hebrew
 */
function containsHebrew(text) {
  return /[\u0590-\u05FF]/.test(text);
}

/**
 * Format text for Telegram Markdown
 * Parse code blocks manually and escape inner backticks
 */
function formatForTelegram(text) {
  if (!text) return text;

  // Remove language specifier: ```javascript -> ```
  let result = text.replace(/```\w+\n/g, '```\n');

  // Manual parsing: find opening ```, then find closing ``` that's at start of line or after newline
  const parts = [];
  let i = 0;
  while (i < result.length) {
    const openIdx = result.indexOf('```\n', i);
    if (openIdx === -1) {
      parts.push(result.slice(i));
      break;
    }

    // Add text before code block
    parts.push(result.slice(i, openIdx));

    // Find the closing ``` - must be preceded by newline or be at very end
    const codeStart = openIdx + 4; // after ```\n
    let closeIdx = -1;
    let searchFrom = codeStart;

    while (searchFrom < result.length) {
      const nextBackticks = result.indexOf('```', searchFrom);
      if (nextBackticks === -1) break;

      // Check if this ``` is at start of line (preceded by \n) or is the actual closer
      if (nextBackticks === codeStart || result[nextBackticks - 1] === '\n') {
        closeIdx = nextBackticks;
        break;
      }
      searchFrom = nextBackticks + 3;
    }

    if (closeIdx === -1) {
      // No proper closing found, treat rest as code
      const code = result.slice(codeStart).replace(/`/g, "'");
      parts.push('```\n' + code + '```');
      break;
    }

    // Extract code and escape backticks inside
    const code = result.slice(codeStart, closeIdx).replace(/`/g, "'");
    parts.push('```\n' + code + '```');
    i = closeIdx + 3;
  }

  return parts.join('');
}

/**
 * Send message with Markdown, fallback to plain text on error
 */
async function sendMessageSafe(bot, chatId, text, options = {}) {
  const formatted = formatForTelegram(text);
  try {
    return await bot.sendMessage(chatId, formatted, { ...options, parse_mode: 'Markdown' });
  } catch (e) {
    console.log('Markdown FAILED:', e.message);
    return await bot.sendMessage(chatId, text, options);
  }
}

/**
 * Edit message with Markdown, fallback to plain text on error
 */
async function editMessageSafe(bot, chatId, messageId, text, options = {}) {
  const formatted = formatForTelegram(text);
  console.log('=== EDIT ===');
  console.log('Before:', JSON.stringify(text.substring(0, 200)));
  console.log('After:', JSON.stringify(formatted.substring(0, 200)));
  try {
    return await bot.editMessageText(formatted, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      ...options
    });
  } catch (e) {
    console.log('Markdown edit FAILED:', e.message);
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...options
    });
  }
}

/**
 * Clean text for natural TTS reading
 */
function cleanTextForTTS(text) {
  return text
    // Remove streaming cursor
    .replace(/▌/g, '')

    // Remove markdown tables entirely (they don't make sense in speech)
    .replace(/\|[^\n]+\|/g, '')
    .replace(/^[-|:\s]+$/gm, '')

    // Remove horizontal rules
    .replace(/^-{3,}$/gm, '')
    .replace(/^_{3,}$/gm, '')
    .replace(/^\*{3,}$/gm, '')

    // Markdown cleanup
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
    .replace(/#{1,6}\s*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, ' image ')

    // Punctuation that gets read literally
    .replace(/:/g, ',')
    .replace(/;/g, ',')
    .replace(/\.\.\./g, ', ')
    .replace(/—|–/g, ', ')
    .replace(/\//g, ' or ')
    .replace(/&/g, ' and ')
    .replace(/@/g, ' at ')
    .replace(/\+/g, ' plus ')
    .replace(/=/g, ' equals ')
    .replace(/=>/g, ' ')
    .replace(/->/g, ' ')

    // Brackets and quotes
    .replace(/[\[\]{}()]/g, ' ')
    .replace(/["""'']/g, '')
    .replace(/[<>]/g, ' ')

    // Code-like patterns
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\b\w+\.(js|ts|py|json|md|yml|yaml|sh|css|html)\b/gi, ' file ')
    .replace(/https?:\/\/[^\s]+/g, ' link ')
    .replace(/[\/\\][\w\/\\.-]+/g, ' path ')

    // Numbers and special formats
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, '$1 $2 $3')
    .replace(/\b(\d+),(\d{3})\b/g, '$1$2')

    // Cleanup bullets and lists
    .replace(/^[\s]*[-*•]\s*/gm, '')
    .replace(/^\s*\d+\.\s*/gm, '')

    // Whitespace normalization
    .replace(/\n+/g, '. ')
    .replace(/\s+/g, ' ')
    .replace(/\.\s*\./g, '.')
    .replace(/,\s*,/g, ',')
    .trim();
}

/**
 * Get directory contents for browsing
 */
function getBrowseContents(dirPath) {
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    const folders = [];
    const files = [];

    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, item.name);

      if (item.isDirectory()) {
        folders.push({
          name: item.name,
          path: fullPath,
          isGit: isGitRepo(fullPath)
        });
      } else {
        files.push(item.name);
      }
    }

    // Sort: git repos first, then folders, then by name
    folders.sort((a, b) => {
      if (a.isGit && !b.isGit) return -1;
      if (!a.isGit && b.isGit) return 1;
      return a.name.localeCompare(b.name);
    });

    return { folders, files };
  } catch (e) {
    return { folders: [], files: [] };
  }
}

/**
 * Clean up old temp audio files
 */
function cleanupTempFiles() {
  try {
    const files = fs.readdirSync(BOT_DIR);
    const tempFiles = files.filter(f => f.startsWith('temp_audio_'));
    let cleaned = 0;

    for (const file of tempFiles) {
      try {
        fs.unlinkSync(path.join(BOT_DIR, file));
        cleaned++;
      } catch (e) {
        // Ignore errors
      }
    }

    if (cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} temp audio files`);
    }
  } catch (e) {
    // Ignore errors
  }
}

/**
 * Path cache for browse buttons (Telegram has 64 byte callback_data limit)
 */
const pathCache = new Map();
let pathCacheId = 0;

function cachePath(fullPath) {
  // Check if already cached
  for (const [id, p] of pathCache) {
    if (p === fullPath) return id;
  }
  const id = `p${pathCacheId++}`;
  pathCache.set(id, fullPath);

  // Keep cache size reasonable
  if (pathCache.size > 500) {
    const firstKey = pathCache.keys().next().value;
    pathCache.delete(firstKey);
  }
  return id;
}

function getPathFromCache(id) {
  return pathCache.get(id);
}

module.exports = {
  sendLongMessage,
  runQuickCommand,
  getModeFlag,
  isGitRepo,
  containsHebrew,
  cleanTextForTTS,
  formatForTelegram,
  sendMessageSafe,
  editMessageSafe,
  getBrowseContents,
  cleanupTempFiles,
  cachePath,
  getPathFromCache
};

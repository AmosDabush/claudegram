/**
 * Utility Functions
 * Common helpers used across the bot
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const platform = require('./platform');
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
    // bash -c on macOS, powershell -Command on Windows. Callers that build
    // POSIX-only command strings must go through buildCommand() below.
    const { file, args } = platform.shellCommand(cmd);
    const proc = spawn(file, args, { cwd, env: process.env });
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
 * Get mode flags for Claude CLI, as a shell fragment.
 * Kept for callers that still build a command string.
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
 * The same flags as argv, for spawning claude without a shell.
 *
 * Each entry is what the shell fragment above expands to — `--tools ""` is one
 * flag plus one EMPTY argument, which is why this cannot be produced by
 * splitting getModeFlag() on whitespace (that yields a literal two-quote
 * string). Spawning by argv is what lets Windows skip a shell entirely, so
 * prompts carrying quotes, newlines or Hebrew need no escaping at all.
 */
function getModeArgs(mode = 'default') {
  switch (mode) {
    case 'yolo': return ['--dangerously-skip-permissions'];
    case 'plan': return ['--permission-mode', 'plan'];
    case 'fast': return ['--tools', ''];
    default: return [];
  }
}

/**
 * Last N lines of a file — what `tail -n` was doing.
 *
 * In Node rather than a shell: `tail` has no Windows equivalent worth shelling
 * out for, and the log is read on every /logs, so skipping a process spawn is
 * free. Reads the whole file, which is fine at the sizes bot.log reaches.
 */
function tailFile(file, lines = 50) {
  try {
    if (!fs.existsSync(file)) return '';
    const all = fs.readFileSync(file, 'utf-8').split('\n');
    if (all[all.length - 1] === '') all.pop();   // trailing newline
    return all.slice(-lines).join('\n');
  } catch (e) {
    return `(could not read ${path.basename(file)}: ${e.message})`;
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
  if (process.env.DEBUG_EDITS === '1') {
    console.log('=== EDIT ===');
    console.log('Before:', JSON.stringify(text.substring(0, 200)));
    console.log('After:', JSON.stringify(formatted.substring(0, 200)));
  }
  const attempt = (body, extra) =>
    bot.editMessageText(body, { chat_id: chatId, message_id: messageId, ...extra, ...options });

  try {
    return await attempt(formatted, { parse_mode: 'Markdown' });
  } catch (e) {
    // Telegram throttles a group far harder than a private chat, and this is usually the
    // edit that puts the finished answer on screen. Swallowing a 429 here is what leaves a
    // turn reading "Processing..." forever with the answer already written. Wait out the
    // delay it asks for and try once more before falling back.
    const retryAfter = e && e.response && e.response.body &&
      e.response.body.parameters && e.response.body.parameters.retry_after;
    if (retryAfter) {
      console.log(`Edit rate limited, waiting ${retryAfter}s before retrying`);
      await new Promise(resolve => setTimeout(resolve, (retryAfter + 1) * 1000));
      try {
        return await attempt(formatted, { parse_mode: 'Markdown' });
      } catch (eRetry) {
        console.log('Edit after backoff FAILED:', eRetry.message);
      }
    }
    console.log('Markdown edit FAILED:', e.message);
    // The plain-text retry can fail too — "message is not modified", or a 429
    // when we are already being throttled. Unguarded it became an unhandled
    // rejection that aborted whatever was rendering the turn.
    try {
      return await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...options
      });
    } catch (e2) {
      console.log('Plain edit FAILED too:', e2.message);
      return null;
    }
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
 * Path encoding for browse buttons (Telegram has 64 byte callback_data limit)
 * Encode path directly in callback_data using ~ shorthand.
 * Falls back to in-memory cache only for very long paths.
 */
const pathCache = new Map();
let pathCacheId = 0;
const homeDir = platform.HOME;

function encodePath(fullPath) {
  // Replace home dir with ~ to shorten
  let short = fullPath;
  if (homeDir && fullPath.startsWith(homeDir)) {
    short = '~' + fullPath.slice(homeDir.length);
  }
  // 61 bytes max (64 - 3 for prefix like "bs:")
  if (Buffer.byteLength(short, 'utf8') <= 61) {
    return short;
  }
  // Fallback to cache for very long paths
  for (const [id, p] of pathCache) {
    if (p === fullPath) return id;
  }
  const id = `p${pathCacheId++}`;
  pathCache.set(id, fullPath);
  if (pathCache.size > 500) {
    const firstKey = pathCache.keys().next().value;
    pathCache.delete(firstKey);
  }
  return id;
}

function decodePath(encoded) {
  // If it starts with p and looks like a cache ID, use cache
  if (/^p\d+$/.test(encoded)) {
    return pathCache.get(encoded) || null;
  }
  // Otherwise it's a direct path - expand ~ back
  if (encoded.startsWith('~')) {
    return homeDir + encoded.slice(1);
  }
  return encoded;
}

// Keep old names as aliases for compatibility
function cachePath(fullPath) {
  return encodePath(fullPath);
}

function getPathFromCache(id) {
  return decodePath(id);
}

module.exports = {
  sendLongMessage,
  runQuickCommand,
  getModeFlag,
  getModeArgs,
  tailFile,
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

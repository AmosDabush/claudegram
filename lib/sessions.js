/**
 * Session Management
 * Handles Claude conversation sessions and history
 */

const fs = require('fs');
const path = require('path');
const platform = require('./platform');
const { toChatKey } = require('./topic-bot');
const { FILES, MAX_SESSION_HISTORY } = require('./config');

// Claude CLI sessions directory
const CLAUDE_PROJECTS_DIR = platform.PROJECTS_DIR;

// In-memory state
const sessions = new Map();       // chatId -> active session
const sessionHistory = new Map(); // chatId -> array of past sessions

/**
 * Load session history from file
 */
function loadSessionHistory() {
  try {
    if (fs.existsSync(FILES.sessions)) {
      const data = JSON.parse(fs.readFileSync(FILES.sessions, 'utf-8'));
      for (const [chatId, history] of Object.entries(data)) {
        sessionHistory.set(toChatKey(chatId), history);
      }
      console.log(`📂 Loaded ${sessionHistory.size} chat histories from file`);
    }
  } catch (e) {
    console.log('⚠️ Could not load session history:', e.message);
  }
}

/**
 * Save session history to file
 */
function saveSessionHistory() {
  try {
    const data = {};
    for (const [chatId, history] of sessionHistory) {
      data[chatId] = history;
    }
    fs.writeFileSync(FILES.sessions, JSON.stringify(data, null, 2));
  } catch (e) {
    console.log('⚠️ Could not save session history:', e.message);
  }
}

/**
 * Get active session for a chat
 */
function getSession(chatId) {
  return sessions.get(chatId) || null;
}

/**
 * Set/create a new session
 */
function setSession(chatId, sessionId, projectPath, topic = '') {
  const session = {
    sessionId,
    projectPath,
    topic: topic.substring(0, 50),
    messageCount: 1,
    startedAt: new Date().toISOString()
  };
  sessions.set(chatId, session);

  // Add to history
  if (!sessionHistory.has(chatId)) {
    sessionHistory.set(chatId, []);
  }
  const history = sessionHistory.get(chatId);

  // Remove if same session already exists
  const existingIdx = history.findIndex(s => s.sessionId === sessionId);
  if (existingIdx >= 0) history.splice(existingIdx, 1);

  // Add to front
  history.unshift({ ...session });

  // Keep only MAX_SESSION_HISTORY
  if (history.length > MAX_SESSION_HISTORY) history.pop();

  saveSessionHistory();
}

/**
 * Clear active session for a chat
 */
function clearSession(chatId) {
  sessions.delete(chatId);
}

/**
 * Increment message count for active session
 */
function incrementSession(chatId) {
  const session = sessions.get(chatId);
  if (session) {
    session.messageCount++;

    // Update in history too
    const history = sessionHistory.get(chatId);
    if (history) {
      const histItem = history.find(s => s.sessionId === session.sessionId);
      if (histItem) {
        histItem.messageCount = session.messageCount;
        saveSessionHistory();
      }
    }
  }
}

/**
 * Get session history for a chat
 */
function getSessionHistory(chatId) {
  return sessionHistory.get(chatId) || [];
}

/**
 * Find session in history by ID
 */
function getSessionById(chatId, sessionId) {
  const history = sessionHistory.get(chatId) || [];
  return history.find(s => s.sessionId === sessionId) || null;
}

/**
 * Find session by short ID prefix
 */
function getSessionByShortId(chatId, shortId) {
  const history = sessionHistory.get(chatId) || [];
  return history.find(s => s.sessionId.startsWith(shortId)) || null;
}

/**
 * Resume a session from history
 */
function resumeSession(chatId, session) {
  sessions.set(chatId, {
    sessionId: session.sessionId,
    projectPath: session.projectPath,
    topic: session.topic,
    messageCount: session.messageCount,
    startedAt: session.startedAt
  });
}

/**
 * Clear all history for a chat
 */
function clearHistory(chatId) {
  sessionHistory.delete(chatId);
  clearSession(chatId);
  saveSessionHistory();
}

/**
 * Encode a path to Claude CLI's folder name format
 * /home/user/projects -> -home-user-projects   (darwin, unchanged)
 * C:\Users\amos       -> C--Users-amos         (win32: ':' and '\' also map to '-')
 */
const encodeProjectPath = platform.encodeProjectPath;

/**
 * Get all CLI sessions for a project path
 * Returns array of { sessionId, topic, messageCount, timestamp, source: 'cli' }
 */
function getCliSessions(projectPath, limit = 10) {
  const encodedPath = encodeProjectPath(projectPath);
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, encodedPath);

  if (!fs.existsSync(projectDir)) {
    return [];
  }

  try {
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const filePath = path.join(projectDir, f);
        const stats = fs.statSync(filePath);
        return {
          sessionId: f.replace('.jsonl', ''),
          filePath,
          mtime: stats.mtime
        };
      })
      .sort((a, b) => b.mtime - a.mtime)  // Most recent first
      .slice(0, limit);

    // Parse each file to get topic
    return files.map(f => {
      const info = parseCliSessionFile(f.filePath);
      return {
        sessionId: f.sessionId,
        projectPath: projectPath,
        topic: info.topic || '(no topic)',
        messageCount: info.messageCount,
        timestamp: f.mtime.toISOString(),
        source: 'cli'
      };
    }).filter(s => s.messageCount > 0);  // Skip empty sessions

  } catch (e) {
    console.log('Error reading CLI sessions:', e.message);
    return [];
  }
}

/**
 * Turn raw first-message text into a human-readable title, or '' if it's
 * just machine noise. This is what makes the sessions list actually usable:
 * we strip injected style prompts, decode escaped unicode, and reject
 * tool-results / system wrappers that were showing up as garbage titles.
 */
/**
 * Strip injected style/voice directive blocks anywhere in the text. These are
 * the big [STYLE_MODE = "..." ...] / [Respond in natural conversational speech...]
 * prompts (and short [telegram bro mode]-style tags) that ride in front of the
 * real message. We never want them saved or shown — titles, previews, all of it.
 */
function stripInjectedDirectives(s) {
  if (!s || typeof s !== 'string') return '';
  s = s.replace(/\[STYLE_MODE\b[\s\S]*?\]/gi, ' ');
  s = s.replace(/\[Respond\b[\s\S]*?\]/gi, ' ');
  s = s.replace(/\[(?:telegram\s+)?bro\s*mode\]/gi, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function cleanTopicText(text) {
  if (!text || typeof text !== 'string') return '';
  let s = text;

  // Decode escaped unicode (e.g. dropped file paths stored as א...)
  if (/\\u[0-9a-fA-F]{4}/.test(s)) {
    try { s = s.replace(/\\u[0-9a-fA-F]{4}/g, m => String.fromCharCode(parseInt(m.slice(2), 16))); } catch (e) {}
  }

  // Strip injected style/voice directive blocks wherever they sit
  s = stripInjectedDirectives(s);

  s = s.replace(/\s+/g, ' ').trim();

  // Reject machine/meta content that isn't a real title
  const NOISE = /^(<command-|<local-command|<bash-|<user-|<task-notification|<system-reminder|Caveat:|\[Request interrupted|\[SYSTEM NOTIFICATION|This session is being continued|API Error|\{"type"|\{")/;
  if (!s || NOISE.test(s)) return '';

  return s;
}

/**
 * Parse a CLI session file to extract info
 */
function parseCliSessionFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    let topic = '';
    let summary = '';
    let messageCount = 0;
    const userMessages = [];

    for (const line of lines) {
      try {
        const json = JSON.parse(line);

        // A resumed/compacted session may carry a real summary line — good fallback title
        if (!summary && json.type === 'summary' && json.summary) {
          summary = String(json.summary).replace(/\s+/g, ' ').trim();
        }

        if (json.type === 'user' && json.message?.content) {
          const msgContent = json.message.content;

          // Pull plain human text: raw string, or the first text block of an array
          let text = '';
          if (typeof msgContent === 'string') {
            text = msgContent;
          } else if (Array.isArray(msgContent)) {
            const tb = msgContent.find(b => b && b.type === 'text' && typeof b.text === 'string');
            if (tb) text = tb.text;
          }

          const clean = cleanTopicText(text);

          // First genuine human line wins the title
          if (!topic && !json.isMeta && clean) topic = clean.substring(0, 60);
          if (clean) userMessages.push(clean.substring(0, 200));

          messageCount++;
        }
      } catch (e) {
        // Skip invalid JSON lines
      }
    }

    return { topic: topic || summary.substring(0, 60), messageCount, userMessages };
  } catch (e) {
    return { topic: '', messageCount: 0, userMessages: [] };
  }
}

/**
 * Summarize a session using Claude
 * Returns a short (1-2 line) summary of what the session was about
 */
async function summarizeSession(filePath) {
  const { userMessages, messageCount } = parseCliSessionFile(filePath);
  if (userMessages.length === 0) return '(empty session)';

  // Take up to 15 user messages, trimmed
  const sample = userMessages.slice(0, 15).join('\n- ');

  try {
    const { execFileSync } = require('child_process');
    const prompt = `Here are the user messages from a coding session (${messageCount} messages total). Write a SHORT summary (1 sentence, max 80 chars, in the language of the messages) describing what this session was about. Just the summary, nothing else.\n\nMessages:\n- ${sample}`;

    // Was a shell string with single-quote escaping and 2>/dev/null. Passing
    // argv directly removes the quoting problem entirely — which mattered here,
    // since these prompts carry the user's own Hebrew text and quotes.
    const result = execFileSync(
      platform.claudeBin(),
      ['-p', prompt, '--max-turns', '1', '--output-format', 'text'],
      { timeout: 30000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], ...platform.spawnOpts() }
    ).trim();

    return result || '(no summary)';
  } catch (e) {
    // Fallback to first user message
    return userMessages[0]?.substring(0, 80) || '(no summary)';
  }
}

/**
 * Decode a Claude CLI encoded project path back to real path.
 * Claude encodes /Users/name/my-project as -Users-name-my-project
 * This is lossy (dashes in folder names become indistinguishable from path separators).
 * We resolve by trying paths from left to right, preferring existing directories.
 */
function decodeProjectPath(encoded) {
  // Only where the walk starts is platform-specific ('/' vs 'C:\'); the
  // filesystem-guided resolution below is identical on both.
  const { root, parts } = platform.decodeRoot(encoded);

  let currentPath = root;
  let i = 0;

  while (i < parts.length) {
    let matched = false;

    // Try joining multiple parts with dashes (longest match first)
    // Also try with dot prefix for hidden directories (.claude, .config, etc.)
    for (let len = Math.min(parts.length - i, 6); len >= 1; len--) {
      const candidate = parts.slice(i, i + len).join('-');

      // Try normal name first
      const testPath = path.join(currentPath, candidate);
      if (fs.existsSync(testPath)) {
        currentPath = testPath;
        i += len;
        matched = true;
        break;
      }

      // Try with dot prefix (hidden dirs like .claude, .config)
      const dotTestPath = path.join(currentPath, '.' + candidate);
      if (fs.existsSync(dotTestPath)) {
        currentPath = dotTestPath;
        i += len;
        matched = true;
        break;
      }
    }

    if (!matched) {
      // No existing path found, just use single part
      currentPath = path.join(currentPath, parts[i]);
      i++;
    }
  }

  return currentPath;
}

/**
 * Get all CLI project folders
 */
function getCliProjects() {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    return [];
  }

  try {
    return fs.readdirSync(CLAUDE_PROJECTS_DIR)
      .filter(f => {
        const fullPath = path.join(CLAUDE_PROJECTS_DIR, f);
        return fs.statSync(fullPath).isDirectory();
      })
      .map(encoded => {
        const decoded = decodeProjectPath(encoded);
        return {
          encoded,
          decoded,
          name: path.basename(decoded)
        };
      });
  } catch (e) {
    return [];
  }
}

/**
 * Find the original project directory of a Claude session by its ID.
 * Claude resolves `--resume <id>` against the project-key derived from the
 * cwd it's launched in, so resuming from the wrong cwd yields
 * "No conversation found". This scans ~/.claude/projects for the session's
 * .jsonl and returns the real on-disk directory it was created in.
 * Returns null if the session file can't be located.
 */
function findSessionProjectPath(sessionId) {
  if (!sessionId || !fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;
  try {
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
      const projDir = path.join(CLAUDE_PROJECTS_DIR, dir);
      if (!fs.statSync(projDir).isDirectory()) continue;
      if (fs.existsSync(path.join(projDir, `${sessionId}.jsonl`))) {
        const decoded = decodeProjectPath(dir);
        return fs.existsSync(decoded) ? decoded : null;
      }
    }
  } catch (e) {
    console.log(`⚠️ findSessionProjectPath failed: ${e.message}`);
  }
  return null;
}

/**
 * Get the first + last human messages of a session (for AI titling).
 */
function getSessionEndpoints(sessionId) {
  if (!sessionId || !fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;
  try {
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
      const fp = path.join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(fp)) {
        const info = parseCliSessionFile(fp);
        const msgs = info.userMessages || [];
        return {
          first: msgs[0] || '',
          last: msgs[msgs.length - 1] || '',
          messageCount: info.messageCount
        };
      }
    }
  } catch (e) {
    console.log(`⚠️ getSessionEndpoints failed: ${e.message}`);
  }
  return null;
}

// Initialize on module load
loadSessionHistory();

module.exports = {
  // Active sessions
  getSession,
  setSession,
  clearSession,
  incrementSession,
  resumeSession,

  // History
  getSessionHistory,
  getSessionById,
  getSessionByShortId,
  clearHistory,

  // Persistence
  loadSessionHistory,
  saveSessionHistory,

  // CLI Sessions (from Mac)
  getCliSessions,
  getCliProjects,
  findSessionProjectPath,
  encodeProjectPath,
  decodeProjectPath,
  summarizeSession,
  parseCliSessionFile,
  getSessionEndpoints,
  stripInjectedDirectives
};

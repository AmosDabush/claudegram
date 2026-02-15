/**
 * Session Management
 * Handles Claude conversation sessions and history
 */

const fs = require('fs');
const path = require('path');
const { FILES, MAX_SESSION_HISTORY } = require('./config');

// Claude CLI sessions directory
const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME || require('os').homedir(), '.claude', 'projects');

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
        sessionHistory.set(parseInt(chatId), history);
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
 * /home/user/projects -> -home-user-projects
 */
function encodeProjectPath(projectPath) {
  return projectPath.replace(/\//g, '-');
}

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
 * Parse a CLI session file to extract info
 */
function parseCliSessionFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    let topic = '';
    let messageCount = 0;
    const userMessages = [];

    for (const line of lines) {
      try {
        const json = JSON.parse(line);

        // Find first user message for topic
        if (json.type === 'user' && json.message?.content && !topic) {
          const msgContent = json.message.content;
          // Take first 50 chars of content
          topic = (typeof msgContent === 'string' ? msgContent : JSON.stringify(msgContent))
            .substring(0, 50)
            .replace(/\n/g, ' ');
        }

        // Collect user messages for summary
        if (json.type === 'user' && json.message?.content) {
          const msgContent = json.message.content;
          const text = (typeof msgContent === 'string' ? msgContent : JSON.stringify(msgContent))
            .substring(0, 200)
            .replace(/\n/g, ' ');
          userMessages.push(text);
        }

        // Count user messages
        if (json.type === 'user') {
          messageCount++;
        }
      } catch (e) {
        // Skip invalid JSON lines
      }
    }

    return { topic, messageCount, userMessages };
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
    const { execSync } = require('child_process');
    const homeDir = process.env.HOME || require('os').homedir();
    const prompt = `Here are the user messages from a coding session (${messageCount} messages total). Write a SHORT summary (1 sentence, max 80 chars, in the language of the messages) describing what this session was about. Just the summary, nothing else.\n\nMessages:\n- ${sample}`;

    const result = execSync(
      `"${homeDir}/.local/bin/claude" -p '${prompt.replace(/'/g, "'\\''")}' --max-turns 1 --output-format text 2>/dev/null`,
      { timeout: 30000, encoding: 'utf-8' }
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
  // Remove leading dash to get the raw parts
  const raw = encoded.replace(/^-/, '');
  const parts = raw.split('-');

  // Build path by trying to match existing directories
  let currentPath = '/';
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
  encodeProjectPath,
  summarizeSession,
  parseCliSessionFile
};

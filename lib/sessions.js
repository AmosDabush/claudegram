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

    for (const line of lines) {
      try {
        const json = JSON.parse(line);

        // Find first user message for topic
        if (json.type === 'user' && json.message?.content && !topic) {
          const content = json.message.content;
          // Take first 50 chars of content
          topic = (typeof content === 'string' ? content : JSON.stringify(content))
            .substring(0, 50)
            .replace(/\n/g, ' ');
        }

        // Count user messages
        if (json.type === 'user') {
          messageCount++;
        }
      } catch (e) {
        // Skip invalid JSON lines
      }
    }

    return { topic, messageCount };
  } catch (e) {
    return { topic: '', messageCount: 0 };
  }
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
        // Decode: -home-user-projects -> /home/user/projects
        const decoded = encoded.replace(/^-/, '/').replace(/-/g, '/');
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
  encodeProjectPath
};

/**
 * Unified Session Registry
 * Manages sessions from both Telegram and CLI sources
 * Provides a single view of all sessions across both interfaces
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const REGISTRY_FILE = path.join(DATA_DIR, 'unified-sessions.json');
const MAX_SESSIONS_PER_SOURCE = 20;

/**
 * Load registry from disk
 */
function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
      if (data && data.sessions) {
        return data;
      }
    }
  } catch (e) {
    console.log('⚠️ Could not load unified sessions registry:', e.message);
  }
  return { version: '1.0', sessions: [] };
}

/**
 * Save registry to disk (atomic write)
 */
function saveRegistry(registry) {
  try {
    const tmpFile = REGISTRY_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(registry, null, 2));
    fs.renameSync(tmpFile, REGISTRY_FILE);
  } catch (e) {
    console.log('⚠️ Could not save unified sessions registry:', e.message);
  }
}

/**
 * Add or update a session in the registry
 * If session with same ID exists, updates it. Otherwise adds new.
 * Auto-prunes old sessions per source.
 */
function addSession(session) {
  const registry = loadRegistry();

  // Validate required fields
  if (!session.id || !session.source) {
    console.log('⚠️ addSession: missing id or source');
    return;
  }

  // Remove existing session with same ID
  registry.sessions = registry.sessions.filter(s => s.id !== session.id);

  // Add new session
  registry.sessions.push({
    id: session.id,
    source: session.source,
    sourceId: session.sourceId || null,
    topic: (session.topic || '').substring(0, 50),
    projectPath: session.projectPath || '',
    mode: session.mode || 'default',
    flags: session.flags || [],
    messageCount: session.messageCount || 1,
    createdAt: session.createdAt || new Date().toISOString(),
    lastUsed: session.lastUsed || new Date().toISOString()
  });

  // Prune and save
  pruneSessions(registry);
  saveRegistry(registry);
}

/**
 * Get all sessions sorted by lastUsed (most recent first)
 */
function getAllSessions() {
  const registry = loadRegistry();
  return registry.sessions.sort((a, b) =>
    new Date(b.lastUsed) - new Date(a.lastUsed)
  );
}

/**
 * Get sessions filtered by source
 */
function getSessionsBySource(source) {
  return getAllSessions().filter(s => s.source === source);
}

/**
 * Update an existing session's fields
 */
function updateSession(sessionId, updates) {
  const registry = loadRegistry();
  const session = registry.sessions.find(s => s.id === sessionId);

  if (!session) return false;

  if (updates.lastUsed !== undefined) session.lastUsed = updates.lastUsed;
  if (updates.messageCount !== undefined) session.messageCount = updates.messageCount;
  if (updates.mode !== undefined) session.mode = updates.mode;
  if (updates.flags !== undefined) session.flags = updates.flags;
  if (updates.topic !== undefined) session.topic = updates.topic.substring(0, 50);
  if (updates.projectPath !== undefined) session.projectPath = updates.projectPath;

  saveRegistry(registry);
  return true;
}

/**
 * Find a session by its full ID
 */
function findSession(sessionId) {
  const registry = loadRegistry();
  return registry.sessions.find(s => s.id === sessionId) || null;
}

/**
 * Find a session by short ID prefix
 */
function findSessionByShortId(shortId) {
  const registry = loadRegistry();
  return registry.sessions.find(s => s.id.startsWith(shortId)) || null;
}

/**
 * Prune old sessions - keep MAX_SESSIONS_PER_SOURCE per source
 */
function pruneSessions(registry) {
  if (!registry) registry = loadRegistry();

  const sources = ['telegram', 'cli'];
  for (const source of sources) {
    const sourceSessions = registry.sessions
      .filter(s => s.source === source)
      .sort((a, b) => new Date(b.lastUsed) - new Date(a.lastUsed));

    if (sourceSessions.length > MAX_SESSIONS_PER_SOURCE) {
      const toRemove = sourceSessions.slice(MAX_SESSIONS_PER_SOURCE);
      const removeIds = new Set(toRemove.map(s => s.id));
      registry.sessions = registry.sessions.filter(s =>
        s.source !== source || !removeIds.has(s.id)
      );
    }
  }
}

/**
 * Format time ago string
 */
function formatTimeAgo(isoTimestamp) {
  const diff = Date.now() - new Date(isoTimestamp);
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

/**
 * Get mode icon
 */
function getModeIcon(mode) {
  const icons = {
    default: '',
    fast: '⚡',
    plan: '📋',
    yolo: '🔥'
  };
  return icons[mode] || '';
}

module.exports = {
  addSession,
  getAllSessions,
  getSessionsBySource,
  updateSession,
  findSession,
  findSessionByShortId,
  formatTimeAgo,
  getModeIcon,
  REGISTRY_FILE
};

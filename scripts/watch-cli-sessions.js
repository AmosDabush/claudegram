/**
 * CLI Session Watcher
 * Scans ~/.claude/projects/ for CLI sessions and adds to unified registry
 * Run on startup or on-demand before showing sessions list
 */

const { addSession, findSession, updateSession } = require('../lib/unified-sessions');
const { getCliProjects, getCliSessions } = require('../lib/sessions');

/**
 * Scan all CLI projects for sessions and sync to unified registry
 */
function scanCliSessions() {
  try {
    const projects = getCliProjects();

    let added = 0;
    let updated = 0;

    for (const project of projects) {
      const sessions = getCliSessions(project.decoded, 20);

      for (const session of sessions) {
        const existing = findSession(session.sessionId);

        if (existing) {
          const updates = {};
          // Bump activity/count only when the file is genuinely newer
          if (new Date(session.timestamp) > new Date(existing.lastUsed)) {
            updates.lastUsed = session.timestamp;
            updates.messageCount = session.messageCount;
          }
          // Self-heal old garbage titles: refresh whenever the freshly-parsed
          // topic differs, regardless of mtime
          if (session.topic && session.topic !== existing.topic) {
            updates.topic = session.topic;
          }
          if (Object.keys(updates).length) {
            updateSession(session.sessionId, updates);
            updated++;
          }
        } else {
          // Add new session
          addSession({
            id: session.sessionId,
            source: 'cli',
            sourceId: null,
            topic: session.topic || '(no topic)',
            projectPath: session.projectPath || project.decoded,
            mode: 'default',
            flags: [],
            messageCount: session.messageCount,
            createdAt: session.timestamp,
            lastUsed: session.timestamp
          });
          added++;
        }
      }
    }

    if (added > 0 || updated > 0) {
      console.log(`📋 CLI sessions sync: ${added} added, ${updated} updated`);
    }
  } catch (e) {
    console.log('⚠️ CLI session scan error:', e.message);
  }
}

// Run immediately when required
scanCliSessions();

module.exports = { scanCliSessions };

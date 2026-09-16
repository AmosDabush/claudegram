/**
 * User State Management with Persistence
 * Handles per-user state (project, mode, voice settings, etc.)
 */

const fs = require('fs');
const path = require('path');
const { FILES, DEFAULT_PROJECTS, DEFAULT_VOICE_SETTINGS } = require('./config');

// In-memory state
const userStates = new Map();
let projects = { ...DEFAULT_PROJECTS };

// Reference to sessions module (set later to avoid circular deps)
let sessionsModule = null;

/**
 * Set sessions module reference (called from bot.js)
 */
function setSessionsModule(mod) {
  sessionsModule = mod;
}

// Debounce save operations
let saveTimeout = null;
const SAVE_DEBOUNCE_MS = 2000;

/**
 * Get default state for a new user
 */
function getDefaultUserState() {
  return {
    currentProject: 'home',
    currentPath: projects.home || process.env.HOME || '/home/user',
    isProcessing: false,
    currentClaudeProc: null,
    currentMode: 'yolo',    // Telegram has no way to approve prompts — skip permissions by default
    sessionMode: true,
    persistSession: false,  // When true, active session survives bot restart
    voiceMode: 'off',       // 'off' = disabled, 'on' = show button, 'auto' = auto-generate
    voiceSettings: { ...DEFAULT_VOICE_SETTINGS },
    messageQueue: [],  // Queue for messages received during processing
    // Interactive mode settings
    interactiveMode: true,  // DEFAULT ON - Claude runs persistently
    interactiveProc: null,  // Reference to persistent Claude process
    showTerminal: false,    // Show in visible iTerm window
    interactiveLogFile: null,  // Log file path for terminal view
    thoughtMode: 'off',     // 'off' = disabled, 'on' = show button, 'auto' = auto-show
    streamMode: 'on',       // 'off' = wait for whole blocks, 'on' = type out the answer, 'live' = also type out the thinking
    model: null,            // Claude model id passed to --model (null = CLI default)
    // Runtime-only fields (never persisted, always reset)
    pendingMessage: null,
    interactiveThinkingMsgId: null,
    interactiveStartTime: null,
    interactiveToolsUsed: [],
    interactiveTimerInterval: null,
    interactiveSessionId: null
  };
}

/**
 * Get or create user state
 */
function getUserState(chatId) {
  if (!userStates.has(chatId)) {
    userStates.set(chatId, getDefaultUserState());
  }
  return userStates.get(chatId);
}

/**
 * Update user state and trigger save
 */
function updateUserState(chatId, updates) {
  const state = getUserState(chatId);
  Object.assign(state, updates);
  scheduleSave();
  return state;
}

/**
 * Get all user states (for iteration)
 */
function getAllUserStates() {
  return userStates;
}

/**
 * Load user states from file
 */
function loadUserStates() {
  try {
    if (fs.existsSync(FILES.userState)) {
      const data = JSON.parse(fs.readFileSync(FILES.userState, 'utf-8'));

      for (const [chatIdStr, state] of Object.entries(data.users || {})) {
        const chatId = parseInt(chatIdStr);
        // Merge with defaults to handle new fields
        const mergedState = {
          ...getDefaultUserState(),
          ...state,
          voiceSettings: {
            ...DEFAULT_VOICE_SETTINGS,
            ...(state.voiceSettings || {})
          },
          // Reset runtime-only state on load (but keep interactiveSessionId for resume!)
          isProcessing: false,
          currentClaudeProc: null,
          interactiveProc: null,
          interactiveLogFile: null,
          pendingMessage: null,
          interactiveThinkingMsgId: null,
          interactiveStartTime: null,
          interactiveToolsUsed: [],
          interactiveTimerInterval: null,
          // KEEP interactiveSessionId from saved state for auto-resume
          interactiveSessionId: state.interactiveSessionId || null,
          messageQueue: []
        };

        // Migrate old boolean fields to new mode strings
        if (typeof state.voiceEnabled === 'boolean') {
          mergedState.voiceMode = state.voiceEnabled ? 'auto' : 'off';
          delete mergedState.voiceEnabled;
        }
        if (typeof state.showProcessLog === 'boolean') {
          mergedState.thoughtMode = state.showProcessLog ? 'auto' : 'off';
          delete mergedState.showProcessLog;
        }

        userStates.set(chatId, mergedState);
      }

      console.log(`📂 Loaded ${userStates.size} user states from file`);
    }
  } catch (e) {
    console.log('⚠️ Could not load user states:', e.message);
  }
}

/**
 * Restore active sessions after loading user states
 * Must be called after sessions module is loaded
 */
function restoreActiveSessions() {
  if (!sessionsModule) {
    console.log('⚠️ Sessions module not set, cannot restore active sessions');
    return;
  }

  try {
    if (fs.existsSync(FILES.userState)) {
      const data = JSON.parse(fs.readFileSync(FILES.userState, 'utf-8'));
      let restored = 0;

      for (const [chatIdStr, state] of Object.entries(data.users || {})) {
        const chatId = parseInt(chatIdStr);
        // If user had persistSession enabled and has a saved activeSession, restore it
        if (state.persistSession && state.activeSession) {
          sessionsModule.resumeSession(chatId, state.activeSession);
          restored++;
        }
      }

      if (restored > 0) {
        console.log(`📂 Restored ${restored} active sessions`);
      }
    }
  } catch (e) {
    console.log('⚠️ Could not restore active sessions:', e.message);
  }
}

/**
 * Save user states to file
 */
function saveUserStates() {
  try {
    const data = {
      users: {},
      savedAt: new Date().toISOString()
    };

    for (const [chatId, state] of userStates) {
      // Don't persist runtime-only fields (but KEEP interactiveSessionId for resume!)
      const {
        isProcessing,
        currentClaudeProc,
        interactiveProc,
        interactiveLogFile,
        pendingMessage,
        interactiveThinkingMsgId,
        interactiveStartTime,
        interactiveToolsUsed,
        interactiveTimerInterval,
        // interactiveSessionId is KEPT for auto-resume after restart
        messageQueue,
        ...persistableState
      } = state;

      // If persistSession is enabled, save the active session too
      if (state.persistSession && sessionsModule) {
        const activeSession = sessionsModule.getSession(chatId);
        if (activeSession) {
          persistableState.activeSession = activeSession;
        }
      }

      data.users[chatId] = persistableState;
    }

    fs.writeFileSync(FILES.userState, JSON.stringify(data, null, 2));
  } catch (e) {
    console.log('⚠️ Could not save user states:', e.message);
  }
}

/**
 * Schedule a debounced save
 */
function scheduleSave() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(() => {
    saveUserStates();
    saveTimeout = null;
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Force immediate save (for shutdown)
 */
function saveNow() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  saveUserStates();
  saveProjects();
}

/**
 * Reset ALL runtime state for a user - COMPLETE cleanup
 * Call this when things are stuck or before restart
 *
 * Options:
 * - killProc: kill running Claude processes (default: true)
 * - clearSessions: clear session history (default: true)
 * - keepSessionId: keep interactiveSessionId for auto-resume (default: false)
 */
function resetUserRuntime(chatId, options = {}) {
  const state = getUserState(chatId);
  const { killProc = true, clearSessions = true, keepSessionId = false } = options;

  console.log(`🔄 [resetUserRuntime] Resetting user ${chatId} (keepSessionId: ${keepSessionId})`);

  // Kill any running Claude processes
  if (killProc) {
    if (state.interactiveProc) {
      console.log(`   Killing interactiveProc PID: ${state.interactiveProc.pid}`);
      try { state.interactiveProc.kill('SIGKILL'); } catch (e) {}
    }
    if (state.currentClaudeProc) {
      console.log(`   Killing currentClaudeProc PID: ${state.currentClaudeProc.pid}`);
      try { state.currentClaudeProc.kill('SIGKILL'); } catch (e) {}
    }
  }

  // Clear timer if running
  if (state.interactiveTimerInterval) {
    clearInterval(state.interactiveTimerInterval);
  }

  // Save sessionId if keeping
  const savedSessionId = keepSessionId ? state.interactiveSessionId : null;

  // Reset ALL runtime fields
  state.isProcessing = false;
  state.currentClaudeProc = null;
  state.interactiveProc = null;
  state.pendingMessage = null;
  state.interactiveThinkingMsgId = null;
  state.interactiveStartTime = null;
  state.interactiveToolsUsed = [];
  state.interactiveTimerInterval = null;
  state.interactiveSessionId = savedSessionId;  // Restore if keeping
  state.messageQueue = [];

  // Clear sessions if requested
  if (clearSessions && sessionsModule) {
    sessionsModule.clearSession(chatId);
    sessionsModule.clearHistory(chatId);
  }

  console.log(`   ✓ Runtime state reset complete${savedSessionId ? ` (kept session: ${savedSessionId.substring(0, 8)}...)` : ''}`);
  return state;
}

/**
 * Reset ALL users' runtime state
 */
function resetAllUsersRuntime(options = {}) {
  console.log(`🔄 [resetAllUsersRuntime] Resetting all ${userStates.size} users (keepSessionId: ${options.keepSessionId || false})`);
  for (const [chatId] of userStates) {
    resetUserRuntime(chatId, options);
  }
}

// ===== Project Management =====

/**
 * Load projects from file
 */
function loadProjects() {
  try {
    if (fs.existsSync(FILES.projects)) {
      const data = JSON.parse(fs.readFileSync(FILES.projects, 'utf-8'));
      // Merge with defaults (user projects override defaults)
      projects = { ...DEFAULT_PROJECTS, ...data.projects };
      console.log(`📂 Loaded ${Object.keys(data.projects || {}).length} custom projects`);
    }
  } catch (e) {
    console.log('⚠️ Could not load projects:', e.message);
  }
}

/**
 * Save projects to file
 */
function saveProjects() {
  try {
    // Only save projects that aren't in defaults or have different paths
    const customProjects = {};
    for (const [name, projectPath] of Object.entries(projects)) {
      if (!DEFAULT_PROJECTS[name] || DEFAULT_PROJECTS[name] !== projectPath) {
        customProjects[name] = projectPath;
      }
    }

    const data = {
      projects: customProjects,
      savedAt: new Date().toISOString()
    };

    fs.writeFileSync(FILES.projects, JSON.stringify(data, null, 2));
  } catch (e) {
    console.log('⚠️ Could not save projects:', e.message);
  }
}

/**
 * Get all projects
 */
function getProjects() {
  return projects;
}

/**
 * Add or update a project
 */
function addProject(name, projectPath) {
  projects[name.toLowerCase()] = projectPath;
  saveProjects();
}

/**
 * Remove a project
 */
function removeProject(name) {
  const key = name.toLowerCase();
  if (projects[key]) {
    delete projects[key];
    saveProjects();
    return true;
  }
  return false;
}

/**
 * Check if project exists
 */
function hasProject(name) {
  return !!projects[name.toLowerCase()];
}

/**
 * Get project path
 */
function getProjectPath(name) {
  return projects[name.toLowerCase()];
}

// Initialize on module load
loadUserStates();
loadProjects();

module.exports = {
  // User state
  getUserState,
  updateUserState,
  getAllUserStates,
  getDefaultUserState,

  // Persistence
  loadUserStates,
  saveUserStates,
  saveNow,
  scheduleSave,
  setSessionsModule,
  restoreActiveSessions,

  // Reset/cleanup
  resetUserRuntime,
  resetAllUsersRuntime,

  // Projects
  getProjects,
  addProject,
  removeProject,
  hasProject,
  getProjectPath,
  loadProjects,
  saveProjects
};

/**
 * platform.js — every place the bot touches the OS, in one file.
 *
 * The bot runs on a Mac and on a Windows PC, each with its own token, off the
 * same code. Everything that differs lives here; nothing else should branch on
 * process.platform.
 *
 * THE RULE: on darwin every function below returns exactly what the inline code
 * it replaced returned. This file adds a win32 branch; it never changes the Mac.
 * scripts/parity-check.js asserts that, and is meant to be run on the Mac before
 * any of this is merged.
 *
 * Scope: the resume pipe. The attach pipe (lib/commands/attach.js and its
 * scripts) is macOS-only and is not touched here — Claude on Windows opens no
 * per-session socket to inject into.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/**
 * Home directory.
 *
 * Was `process.env.HOME || '/home/user'` in ~20 places. On macOS HOME is always
 * set, so os.homedir() is the same string. On Windows HOME is unset for a
 * Scheduled Task, and that '/home/user' fallback would silently produce a path
 * that does not exist — every ~-relative lookup would miss and return empty.
 */
const HOME = os.homedir();

const CLAUDE_DIR = path.join(HOME, '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

/**
 * Claude encodes a project's absolute path into one folder name under
 * ~/.claude/projects. The rule differs per platform, and getting it wrong fails
 * silently — the folder is simply not found and /sessions comes back empty.
 *
 *   darwin : /Users/amos/git/foo  ->  -Users-amos-git-foo
 *   win32  : C:\Users\amos        ->  C--Users-amos      (both ':' and '\' -> '-')
 */
function encodeProjectPath(projectPath) {
  return IS_WIN
    ? projectPath.replace(/[\\/:]/g, '-')
    : projectPath.replace(/\//g, '-');
}

/**
 * Split an encoded folder name into where the path walk starts and the
 * ambiguous '-'-joined parts after it. The walk itself stays in sessions.js,
 * which already resolves '-' against the filesystem and handles hidden dirs;
 * only the starting point is platform-specific.
 *
 *   darwin : -Users-amos-git  ->  { root: '/',    parts: ['Users','amos','git'] }
 *   win32  : C--Users-amos    ->  { root: 'C:\\', parts: ['Users','amos'] }
 */
function decodeRoot(encoded) {
  if (IS_WIN) {
    const m = /^([A-Za-z])--(.*)$/.exec(encoded);
    if (m) return { root: `${m[1]}:\\`, parts: m[2].split('-') };
    // Transcript copied from the Mac, or a UNC path: no drive letter.
    return { root: path.sep, parts: encoded.replace(/^-/, '').split('-') };
  }
  return { root: '/', parts: encoded.replace(/^-/, '').split('-') };
}

/**
 * The claude executable.
 *
 * On Windows this MUST resolve to the real claude.exe, never the claude.cmd
 * shim npm puts on PATH. A .cmd can only be run through a shell, and spawning
 * with shell:true concatenates argv without quoting (node DEP0190) — so a
 * prompt would be split at its first space and Claude would receive one word.
 * Every Telegram message has spaces, so that is not an edge case.
 *
 * CLAUDE_BIN_PATH from .env still wins on both platforms, as it did before.
 */
function claudeBin() {
  const configured = process.env.CLAUDE_BIN_PATH;
  if (configured) {
    const p = configured.replace(/^~/, HOME);
    for (const c of [path.join(p, IS_WIN ? 'claude.exe' : 'claude'), p]) {
      try { if (fs.statSync(c).isFile()) return c; } catch (e) {}
    }
  }
  const candidates = IS_WIN
    ? [path.join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules',
                 '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
       path.join(HOME, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe')]
    : [path.join(HOME, '.local', 'bin', 'claude'),
       '/opt/homebrew/bin/claude',
       '/usr/local/bin/claude'];
  return candidates.find(c => fs.existsSync(c)) || 'claude';
}

/** Directory prepended to PATH so spawned processes find claude. */
function claudeBinDir() {
  return path.dirname(claudeBin());
}

/**
 * Extra spawn options for running claude.
 *
 * Empty on BOTH platforms, and that is the point: claudeBin() always returns a
 * real executable, so nothing here ever needs shell:true. Kept as a seam so
 * call sites do not have to change if that stops being true.
 */
function spawnOpts(extra = {}) {
  return { ...extra };
}

/** Where to redirect stdin from so claude does not wait on a terminal. */
const NULL_DEVICE = IS_WIN ? 'NUL' : '/dev/null';

/**
 * A shell one-liner, as {file, args} for spawn().
 *
 * The bot ran `bash -c <cmd>` in several places. Windows cannot use that:
 * system32\bash.exe is WSL, a separate filesystem where C:\Users\amos is not
 * even the same path. PowerShell is the equivalent surface there.
 */
function shellCommand(cmd) {
  return IS_WIN
    ? { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', cmd] }
    : { file: 'bash', args: ['-c', cmd] };
}

/**
 * Pids whose command line contains every one of `needles`, excluding our own.
 *
 * Replaces `pgrep -f`, which does not exist on Windows. Used at startup to
 * clear orphaned instances — Telegram allows only one long-poll per token, so
 * a survivor would fight the new process for updates in a 409 loop.
 */
function findProcesses(needles) {
  const terms = Array.isArray(needles) ? needles : [needles];
  const { execFileSync } = require('child_process');
  try {
    if (IS_WIN) {
      const ps = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | '
               + 'ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }';
      const out = execFileSync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', ps],
        { encoding: 'utf-8', timeout: 15000 });
      return out.split('\n')
        .map(l => l.split('\t'))
        .filter(([pid, cmd]) => pid && cmd && terms.every(t => cmd.includes(t)))
        .map(([pid]) => Number(pid.trim()))
        .filter(pid => pid && pid !== process.pid);
    }
    const out = execFileSync('pgrep', ['-f', terms.join('.*')], { encoding: 'utf-8' });
    return out.trim().split('\n').map(Number).filter(pid => pid && pid !== process.pid);
  } catch (e) {
    return [];   // pgrep exits 1 when nothing matched; not an error
  }
}

/** Terminate a pid. process.kill maps to TerminateProcess on Windows. */
function killPid(pid) {
  try { process.kill(Number(pid)); return true; }
  catch (e) { return false; }
}

/** Is this pid running? Replaces `ps -p` / `pgrep` probes. */
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // alive, just not ours to signal
}

/**
 * Live Claude sessions on this machine: {pid, cwd, sessionId, name, status}.
 *
 * Both platforms register them as ~/.claude/sessions/<pid>.json. Read directly
 * rather than shelling out to `claude agents --json`: no spawn, and it cannot
 * block behind a busy CLI.
 */
function liveSessions() {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (s && s.pid && isAlive(s.pid)) out.push(s);
    } catch (e) { /* half-written file: skip */ }
  }
  return out;
}

module.exports = {
  IS_WIN,
  IS_MAC,
  HOME,
  CLAUDE_DIR,
  PROJECTS_DIR,
  NULL_DEVICE,
  encodeProjectPath,
  decodeRoot,
  claudeBin,
  claudeBinDir,
  spawnOpts,
  shellCommand,
  findProcesses,
  killPid,
  isAlive,
  liveSessions
};

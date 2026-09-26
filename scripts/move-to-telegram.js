#!/usr/bin/env node
/**
 * Move the terminal session you are sitting in to Telegram.
 *
 * Sends a message carrying a short summary and a Resume button. Tapping it picks the
 * session back up in the bot with its context intact, so the conversation continues from
 * the phone. It resumes rather than joining live: once it has moved, typing in the
 * terminal too puts two writers in one session.
 *
 * The counterpart of the Mac's scripts/move-to-telegram.sh, in node so one file serves
 * both platforms. The session folder is named after the working directory, and the two
 * platforms spell that differently — /Users/amos/git -> -Users-amos-git against
 * C:\Users\amos -> C--Users-amos — so the encoding is taken from lib/platform rather than
 * assumed.
 *
 *   node scripts/move-to-telegram.js
 *   node scripts/move-to-telegram.js --cwd "C:\\Users\\amos\\git\\claudegram" --summary "..."
 *   node scripts/move-to-telegram.js --chat -1004306041139 --thread 41
 *   node scripts/move-to-telegram.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const BOT_DIR = path.join(__dirname, '..');
const platform = require(path.join(BOT_DIR, 'lib', 'platform'));
const unifiedSessions = require(path.join(BOT_DIR, 'lib', 'unified-sessions'));

// ── .env, read the same way bot.js reads it ──────────────────────────────────
const envPath = path.join(BOT_DIR, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length && !key.trim().startsWith('#')) process.env[key.trim()] = rest.join('=').trim();
  }
}

// ── Arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const has = (name) => argv.includes(`--${name}`);

const cwd = flag('cwd') || process.cwd();
const thread = flag('thread');
const dryRun = has('dry-run');

const allowed = (process.env.ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const chatId = flag('chat') || allowed[0];

if (!chatId) {
  console.error('No chat to send to: pass --chat, or set ALLOWED_USER_IDS in .env');
  process.exit(1);
}

// A group or a topic can only be reached by the bot that is a member of it.
const toGroup = String(chatId).startsWith('-');
const token = toGroup && process.env.GROUP_BOT_TOKEN ? process.env.GROUP_BOT_TOKEN : process.env.BOT_TOKEN;
if (!token) {
  console.error(`No token for that destination (${toGroup ? 'GROUP_BOT_TOKEN' : 'BOT_TOKEN'} is missing from .env)`);
  process.exit(1);
}

// ── Which session ────────────────────────────────────────────────────────────
function newestSession(projectDir) {
  if (!fs.existsSync(projectDir)) return null;
  const transcripts = fs.readdirSync(projectDir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => ({ id: name.replace(/\.jsonl$/, ''), file: path.join(projectDir, name) }))
    .map(entry => ({ ...entry, mtime: fs.statSync(entry.file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return transcripts[0] || null;
}

const projectDir = path.join(platform.PROJECTS_DIR, platform.encodeProjectPath(cwd));
const explicitId = flag('session');
const found = explicitId
  ? { id: explicitId, file: path.join(projectDir, `${explicitId}.jsonl`) }
  : newestSession(projectDir);

if (!found) {
  console.error(`No session transcript under ${projectDir}`);
  console.error('Pass --cwd with the directory the session was started in.');
  process.exit(1);
}

// ── Summary ──────────────────────────────────────────────────────────────────
// Given one, use it. Otherwise quote what was last asked, which is enough to recognise
// the conversation on a phone without pretending to be a real summary.
function lastAsked(file, count = 3) {
  try {
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    const asks = [];
    for (let i = lines.length - 1; i >= 0 && asks.length < count; i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch (e) { continue; }
      if (entry.type !== 'user') continue;
      const content = entry.message && entry.message.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.map(p => (p && p.text) || '').join(' ') : '';
      const clean = text.replace(/\s+/g, ' ').trim();
      if (clean && !clean.startsWith('[')) asks.unshift(clean.slice(0, 120));
    }
    return asks.join(' · ');
  } catch (e) {
    return '';
  }
}

const summary = flag('summary') || lastAsked(found.file) || '(no summary)';
const shortId = found.id.slice(0, 8);

// ── Register, so the button can resolve ──────────────────────────────────────
// uresume: looks the short id up in the unified registry. Skipping this is what makes a
// freshly moved session answer "Session not found" when the button is tapped. A dry run
// registers nothing: it is there to show what would happen, not to half do it.
if (!dryRun) {
  unifiedSessions.addSession({
    id: found.id,
    source: 'cli',
    projectPath: cwd,
    topic: summary.slice(0, 50),
    messageCount: 1,
  });
}

const text = [
  '🖥➡📱 Session from Terminal',
  '',
  `📁 Project: ${path.basename(cwd)}`,
  `🔗 Session: ${shortId}`,
  '',
  `💬 ${summary}`,
  '',
  'Tap the button to continue:',
].join('\n');

const payload = {
  chat_id: toGroup ? Number(chatId) : chatId,
  text,
  reply_markup: { inline_keyboard: [[{ text: '▶️ Resume Session', callback_data: `uresume:${shortId}` }]] },
  ...(thread ? { message_thread_id: Number(thread) } : {}),
};

if (dryRun) {
  console.log(`would send to ${chatId}${thread ? ` (topic ${thread})` : ''} via ${toGroup ? 'group' : 'main'} bot:\n`);
  console.log(text);
  console.log(`\nbutton: uresume:${shortId}`);
  console.log(`would register: ${found.id}`);
  process.exit(0);
}

const body = JSON.stringify(payload);
const req = https.request({
  host: 'api.telegram.org',
  path: `/bot${token}/sendMessage`,
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
}, (res) => {
  let data = '';
  res.setEncoding('utf8');
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(data); } catch (e) {}
    if (parsed && parsed.ok) console.log(`Session sent to Telegram (${shortId})`);
    else {
      console.error(`Telegram refused it: ${(parsed && parsed.description) || data.slice(0, 200)}`);
      process.exit(1);
    }
  });
});
req.on('error', (err) => { console.error(`Could not reach Telegram: ${err.message}`); process.exit(1); });
req.end(body);

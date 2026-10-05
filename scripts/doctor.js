#!/usr/bin/env node
/**
 * Check this install and say what is wrong with it.
 *
 *   node scripts/doctor.js
 *
 * Every failure mode this project has is quiet. A bot token that is fine but a group
 * token that is not; a bot in the group that was never made an admin; Group Privacy
 * left on, so it only ever sees messages beginning with a slash; a second machine
 * polling the same token until both get 409s. None of these announce themselves. They
 * show up as "I sent it a message and nothing happened", which is the hardest sentence
 * to debug from the other end of a chat.
 *
 * So every check here ends in a line somebody can act on, and the exit code is the
 * number of things that are actually broken. Warnings do not count — plenty of this is
 * optional and being without it is a choice.
 *
 * Nothing here writes anything. Tokens are masked in the output, so the result is safe
 * to paste into an issue.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const platform = require('../lib/platform');
// Loaded here rather than where it is used, so its "Loaded N chat histories" line lands
// above the report instead of in the middle of it.
const { decodeProjectPath } = require('../lib/sessions');

const IS_WIN = process.platform === 'win32';

const C = {
  reset: '\x1b[0m', bright: '\x1b[1m', red: '\x1b[31m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m'
};

let bad = 0, warned = 0;

const head = (t) => console.log(`\n${C.bright}${t}${C.reset}\n${C.dim}${'-'.repeat(t.length)}${C.reset}`);
const pass = (t, d) => console.log(`  ${C.green}ok${C.reset}    ${t}${d ? `  ${C.dim}${d}${C.reset}` : ''}`);
const warn = (t, fix) => { warned++; console.log(`  ${C.yellow}warn${C.reset}  ${t}`); if (fix) console.log(`        ${C.cyan}${fix}${C.reset}`); };
const fail = (t, fix) => { bad++; console.log(`  ${C.red}FAIL${C.reset}  ${t}`); if (fix) console.log(`        ${C.cyan}${fix}${C.reset}`); };
const info = (t) => console.log(`  ${C.dim}${t}${C.reset}`);

/** Enough of a token to recognise, not enough to use. */
const mask = (t) => !t ? '(empty)' : `${t.slice(0, t.indexOf(':') + 1)}${'*'.repeat(8)}${t.slice(-4)}`;

function callTelegram(token, method, params = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify(params);
    const req = https.request({
      host: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ ok: false, description: 'unreadable response' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, description: 'timed out reaching api.telegram.org' }); });
    req.on('error', e => resolve({ ok: false, description: e.message }));
    req.end(body);
  });
}

// ─── the host ────────────────────────────────────────────────────────────────

function checkHost() {
  head('This machine');

  const major = parseInt(process.version.slice(1).split('.')[0], 10);
  if (major >= 18) pass(`Node ${process.version}`);
  else fail(`Node ${process.version} is too old`, 'Needs 18 or newer: https://nodejs.org');

  if (fs.existsSync(path.join(ROOT, 'node_modules'))) pass('Dependencies installed');
  else fail('node_modules is missing', `Run: ${IS_WIN ? 'npm install' : 'npm install'} in ${ROOT}`);

  // The real executable, not the npm shim. A .cmd can only run through a shell, and a
  // shell concatenates argv without quoting -- so every message with a space in it
  // reaches Claude as its first word only.
  const bin = platform.claudeBin();
  if (path.isAbsolute(bin) && fs.existsSync(bin)) {
    pass('Claude CLI', bin);
  } else {
    fail(`Claude CLI not found (looked for ${IS_WIN ? 'claude.exe' : 'claude'})`,
      'npm install -g @anthropic-ai/claude-code, then set CLAUDE_BIN_PATH in .env to the folder holding it');
  }
}

// ─── .env ────────────────────────────────────────────────────────────────────

function checkEnv() {
  head('Configuration');

  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    fail('.env does not exist', 'Run: node setup.js');
    return false;
  }
  pass('.env found');

  if (!process.env.BOT_TOKEN) {
    fail('BOT_TOKEN is empty', 'Get one from @BotFather, or re-run node setup.js');
  } else if (!/^\d+:[A-Za-z0-9_-]+$/.test(process.env.BOT_TOKEN)) {
    fail('BOT_TOKEN is not shaped like a token', 'Expected 1234567890:ABCdef...');
  } else {
    pass('BOT_TOKEN', mask(process.env.BOT_TOKEN));
  }

  const ids = (process.env.ALLOWED_USER_IDS || '').trim();
  if (!ids) {
    fail('ALLOWED_USER_IDS is empty — nobody can use the bot', 'Get your id from @userinfobot and put it in .env');
  } else if (!/^\d+(,\d+)*$/.test(ids)) {
    fail('ALLOWED_USER_IDS must be numbers, comma separated', `Got: ${ids}`);
  } else {
    pass(`ALLOWED_USER_IDS`, `${ids.split(',').length} user(s)`);
  }

  // Sharing one token between the two bots is the single most common way to break this,
  // and the symptom -- both loops dying in 409s -- names neither cause nor cure.
  if (process.env.GROUP_BOT_TOKEN && process.env.GROUP_BOT_TOKEN === process.env.BOT_TOKEN) {
    fail('BOT_TOKEN and GROUP_BOT_TOKEN are the same bot',
      'Telegram serves getUpdates to one consumer per token. Make a second bot with @BotFather.');
  }

  return true;
}

// ─── the bots ────────────────────────────────────────────────────────────────

async function checkDirectBot() {
  head('Direct chat bot');

  const token = process.env.BOT_TOKEN;
  if (!token) { info('skipped, no BOT_TOKEN'); return; }

  const me = await callTelegram(token, 'getMe');
  if (!me.ok) {
    fail(`Telegram rejected BOT_TOKEN: ${me.description}`, 'Check the token, or /revoke and /token in @BotFather');
    return;
  }
  pass(`@${me.result.username}`, `id ${me.result.id}`);
}

async function checkGroupBot() {
  head('Group bot (a topic per session)');

  const token = (process.env.GROUP_BOT_TOKEN || '').trim();
  if (!token) {
    info('Not configured. The direct chat works without it; you just do not get');
    info('one topic per session. Re-run node setup.js to add it.');
    return;
  }

  const me = await callTelegram(token, 'getMe');
  if (!me.ok) {
    fail(`Telegram rejected GROUP_BOT_TOKEN: ${me.description}`, 'Check the token in @BotFather');
    return;
  }
  pass(`@${me.result.username}`, `id ${me.result.id}`);

  // Privacy on means it only receives messages that begin with a slash. Everything else
  // -- which is to say, everything you actually want to say to Claude -- is dropped by
  // Telegram before it ever reaches the bot, silently.
  if (me.result.can_read_all_group_messages === false) {
    fail('Group Privacy is ON, so it only sees messages starting with "/"',
      '@BotFather -> /mybots -> this bot -> Bot Settings -> Group Privacy -> Turn off, then remove and re-add it to the group');
  } else if (me.result.can_read_all_group_messages === true) {
    pass('Group Privacy is off (it can read the conversation)');
  }

  const chatId = (process.env.GROUP_CHAT_ID || '').trim();
  if (!chatId) {
    warn('GROUP_CHAT_ID is empty',
      'Sessions moved from the terminal go to the direct chat instead of a topic. Re-run node setup.js to detect it.');
    return;
  }

  const chat = await callTelegram(token, 'getChat', { chat_id: Number(chatId) });
  if (!chat.ok) {
    fail(`Cannot see the group ${chatId}: ${chat.description}`,
      'Is the bot still a member? Is GROUP_CHAT_ID right? It should start with -100.');
    return;
  }
  pass(`Group "${chat.result.title}"`, chatId);

  if (chat.result.type !== 'supergroup') {
    fail(`That chat is a ${chat.result.type}, and topics need a supergroup`,
      'Group settings -> turn Topics on. Telegram converts it automatically.');
  } else if (!chat.result.is_forum) {
    fail('Topics are off in that group, so every session shares one thread',
      'Group settings -> Topics -> on');
  } else {
    pass('Topics are on');
  }

  const member = await callTelegram(token, 'getChatMember', { chat_id: Number(chatId), user_id: me.result.id });
  if (!member.ok) {
    warn(`Could not read the bot's membership: ${member.description}`);
  } else if (member.result.status !== 'administrator') {
    fail(`The bot is in the group as "${member.result.status}", not an admin — it cannot open a topic`,
      'Group settings -> Administrators -> add it, with "Manage Topics"');
  } else if (!member.result.can_manage_topics) {
    fail('It is an admin but without "Manage Topics"',
      'Group settings -> Administrators -> this bot -> enable Manage Topics');
  } else {
    pass('Admin, with Manage Topics');
  }
}

// ─── more than one machine ───────────────────────────────────────────────────

function checkMachines() {
  head('Machines');

  const thisHost = (process.env.HOST_NAME || '').trim() ||
    (IS_WIN ? 'windows' : process.platform === 'darwin' ? 'mac' : os.hostname());
  const remotes = (process.env.REMOTE_HOSTS || '').trim();
  const sendOnly = (process.env.GROUP_BOT_SEND_ONLY || '').trim();
  const fallback = (process.env.GROUP_FALLBACK_HOST || '').trim();

  pass('This machine is called', thisHost);

  if (!remotes) {
    info('No other machines configured. Everything runs here, which is what');
    info('one machine means. Nothing below applies.');
    return;
  }

  const names = remotes.split(',').map(e => e.split('=')[0].trim()).filter(Boolean);
  pass('Other machines', names.join(', '));

  // Both halves of this have to agree across machines, and only a human comparing two
  // .env files can see that. All the doctor can do is say what this one believes.
  if (!fallback) {
    fail(`GROUP_FALLBACK_HOST is empty, so "${thisHost}" claims every topic nobody bound`,
      'With two machines both claiming them, every message is answered twice. Set the SAME name in both .env files.');
  } else {
    pass('Unclaimed topics go to', fallback + (fallback === thisHost ? ' (this machine)' : ''));
  }

  if (process.env.GROUP_BOT_TOKEN && !sendOnly) {
    warn(`This machine POLLS the group token`,
      'Exactly one machine may. On every other one set GROUP_BOT_SEND_ONLY=1, or they fight until both get 409s.');
  } else if (sendOnly) {
    pass('Send-only: holds the group token without polling it');
  }
}

// ─── workspaces ──────────────────────────────────────────────────────────────

function checkWorkspaces() {
  head('Topic workspaces');

  const base = process.env.CLAUDEGRAM_CHATS_DIR || path.join(platform.HOME, 'claudegram-topics');
  try {
    fs.mkdirSync(base, { recursive: true });
    fs.accessSync(base, fs.constants.W_OK);
    pass('Writable', base);
  } catch (e) {
    fail(`Cannot write to ${base}: ${e.message}`, 'Set CLAUDEGRAM_CHATS_DIR in .env to a folder you own');
  }

  // The round trip that decides whether a session survives a restart. If this is wrong
  // the bot looks fine right up until it is restarted, and then every conversation is
  // gone -- which is exactly how it was found.
  try {
    const probe = path.join(base, '-1001234567890_1');
    fs.mkdirSync(probe, { recursive: true });
    const back = decodeProjectPath(platform.encodeProjectPath(probe));
    fs.rmdirSync(probe);
    if (back === probe) pass('A topic folder survives the encode/decode round trip');
    else fail(`Topic folders do not round-trip, so sessions will not resume after a restart\n        got ${back}`,
      'Run node scripts/qa-paths.js and open an issue with the output');
  } catch (e) {
    warn(`Could not test the round trip: ${e.message}`);
  }
}

// ─── already running? ────────────────────────────────────────────────────────

function checkRunning() {
  head('Running instances');

  // Telegram allows one long-poll per token. A survivor from a previous start fights the
  // new process for updates in a 409 loop, and the bot looks dead for no visible reason.
  try {
    const pids = platform.findProcesses(['node', 'bot.js']);
    if (!pids.length) info('Not running.');
    else if (pids.length === 1) pass('One instance running', `pid ${pids[0]}`);
    else warn(`${pids.length} instances running (${pids.join(', ')})`,
      'Only one may poll a token. Stop the extras, or run the start script, which clears them.');
  } catch (e) {
    info(`Could not check: ${e.message}`);
  }
}

// ─── run ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C.bright}claudegram doctor${C.reset}  ${C.dim}${process.platform} · node ${process.version}${C.reset}`);

  checkHost();
  const haveEnv = checkEnv();

  if (haveEnv) {
    await checkDirectBot();
    await checkGroupBot();
    checkMachines();
    checkWorkspaces();
  }
  checkRunning();

  console.log('');
  if (bad) {
    console.log(`${C.red}${bad} problem(s)${C.reset}${warned ? `, ${warned} warning(s)` : ''}. Each one above has the fix under it.\n`);
  } else if (warned) {
    console.log(`${C.green}Nothing broken${C.reset}, ${warned} warning(s) — all optional.\n`);
  } else {
    console.log(`${C.green}All good.${C.reset}\n`);
  }
  process.exit(bad ? 1 : 0);
}

main();

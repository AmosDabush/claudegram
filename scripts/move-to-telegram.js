#!/usr/bin/env node
/**
 * Move the terminal session you are sitting in to Telegram.
 *
 * Sends a message carrying a short summary and a Resume button. Tapping it picks the
 * session back up in the bot with its context intact, so the conversation continues from
 * the phone. It resumes rather than joining live: once it has moved, typing in the
 * terminal too puts two writers in one session.
 *
 * Where it goes, when nothing is specified: back to the topic this session was last used
 * in, and if it has never been in one, into a topic created for it. A session that has a
 * thread belongs in that thread — that is where its history reads — and one that does not
 * should not have to interrupt somebody else's.
 *
 * Wherever it lands, the direct chat also gets a copy, so the session is reachable from the
 * chat the phone opens on: the same Resume button, plus a link into the topic it went to.
 *
 * The counterpart of the Mac's scripts/move-to-telegram.sh, in node so one file serves
 * both platforms. The session folder is named after the working directory, and the two
 * platforms spell that differently — /Users/amos/git -> -Users-amos-git against
 * C:\Users\amos -> C--Users-amos — so the encoding is taken from lib/platform rather than
 * assumed.
 *
 *   node scripts/move-to-telegram.js                     back to its topic, or a new one
 *   node scripts/move-to-telegram.js --dm                to the direct chat instead
 *   node scripts/move-to-telegram.js --thread 41         into one particular topic
 *   node scripts/move-to-telegram.js --new-topic "name"  always a fresh topic
 *   node scripts/move-to-telegram.js --list-topics       what the bot has handled
 *   node scripts/move-to-telegram.js --dry-run           show it, send nothing
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const BOT_DIR = path.join(__dirname, '..');
const platform = require(path.join(BOT_DIR, 'lib', 'platform'));
const unifiedSessions = require(path.join(BOT_DIR, 'lib', 'unified-sessions'));
const topics = require(path.join(BOT_DIR, 'lib', 'topics'));

// ── .env, read the same way bot.js reads it ──────────────────────────────────
const envPath = path.join(BOT_DIR, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (!key || !rest.length || key.trim().startsWith('#')) continue;
    // Anything already in the environment wins. A file that overwrites it cannot be
    // overridden for a single run — not to point at a test fixture, not to send somewhere
    // else once — and that is the opposite of what setting a variable is supposed to do.
    if (process.env[key.trim()] === undefined) process.env[key.trim()] = rest.join('=').trim();
  }
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const has = (name) => argv.includes(`--${name}`);

const cwd = flag('cwd') || process.cwd();
const dryRun = has('dry-run');
const allowed = (process.env.ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// Through config, not a hardcoded 'data': lib/topics already resolves that way, and a
// script that reads half its state from one directory and half from another cannot be
// pointed at a test fixture — or at a second checkout — without lying about what it found.
const { DATA_DIR } = require(path.join(BOT_DIR, 'lib', 'config'));

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8')); } catch (e) { return null; }
};

// ── Which chats the bot knows ────────────────────────────────────────────────
// Telegram will not list a group's topics to a bot — the API creates, edits and closes
// them but never enumerates them — so the only list available is the one the bot builds
// from what it has handled. Three places record it, and all three are worth reading: a
// topic may have been used before any of them existed.
function knownChatKeys() {
  const keys = new Set(Object.keys(topics.all()));
  const state = readJson('user-state.json');
  if (state) Object.keys(state.users || {}).forEach(key => keys.add(key));
  const sessions = readJson('sessions.json');
  if (sessions) Object.keys(sessions).forEach(key => keys.add(key));
  return [...keys].filter(key => key.includes(':'));
}

if (has('list-topics')) {
  const named = topics.all();
  const keys = knownChatKeys();
  if (!keys.length) {
    console.log('No topics seen yet. The bot learns one when a message arrives from it,');
    console.log('and --new-topic needs none of this.');
  } else {
    console.log('Topics this bot has handled:\n');
    for (const key of keys.sort()) {
      const [chat, thread] = key.split(':');
      console.log(`  --chat ${chat} --thread ${thread}   ${named[key] || '(name not seen yet)'}`);
    }
    console.log('\nNames fill in as messages arrive from each topic.');
  }
  process.exit(0);
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
let found = null;

if (explicitId) {
  // Check it is really there. Taking the id on trust sends a Resume button for a session
  // that cannot be resumed, and the tap fails minutes later on the phone — the exact
  // failure this is supposed to prevent. A transcript lives in the folder named after the
  // directory its session ran in, so a wrong --cwd looks the same as a wrong id.
  const file = path.join(projectDir, `${explicitId}.jsonl`);
  if (fs.existsSync(file)) found = { id: explicitId, file };
} else {
  found = newestSession(projectDir);
}

if (!found) {
  console.error(explicitId
    ? `No transcript for session ${explicitId} under ${projectDir}`
    : `No session transcript under ${projectDir}`);
  console.error('Pass --cwd with the directory the session was started in.');
  process.exit(1);
}

// ── Has this session been in a topic before? ─────────────────────────────────
// Three records answer it, written at different times by different parts of the bot. The
// per-chat state is the freshest — it holds the session each chat is on right now — so it
// is asked first, then the history, then the registry.
function previousTopicOf(sessionId) {
  const state = readJson('user-state.json');
  if (state) {
    for (const [key, value] of Object.entries(state.users || {})) {
      if (key.includes(':') && value && value.interactiveSessionId === sessionId) return key;
    }
  }

  const sessions = readJson('sessions.json');
  if (sessions) {
    for (const [key, history] of Object.entries(sessions)) {
      if (key.includes(':') && Array.isArray(history) && history.some(h => h && h.sessionId === sessionId)) return key;
    }
  }

  try {
    const match = unifiedSessions.getAllSessions()
      .find(s => s.id === sessionId && s.sourceId && String(s.sourceId).includes(':'));
    if (match) return String(match.sourceId);
  } catch (e) {}

  return null;
}

// ── Where to send ────────────────────────────────────────────────────────────
const explicitChat = flag('chat');
const explicitThread = flag('thread');
const wantsNewTopic = has('new-topic');
const newTopicName = flag('new-topic');

// Every topic key carries its group, so the group id never has to be configured.
const groupId = process.env.GROUP_CHAT_ID ||
  (knownChatKeys()[0] || '').split(':')[0] ||
  null;

const previous = previousTopicOf(found.id);

let chatId;
let thread = explicitThread;
let createTopic = false;
let reason;

if (explicitChat || explicitThread) {
  chatId = explicitChat || (previous || '').split(':')[0] || groupId;
  createTopic = wantsNewTopic;
  reason = wantsNewTopic ? 'a new topic, as asked' : 'the topic you named';
} else if (wantsNewTopic) {
  chatId = groupId;
  createTopic = true;
  reason = 'a new topic, as asked';
} else if (has('dm')) {
  chatId = allowed[0];
  reason = 'the direct chat, as asked';
} else if (previous) {
  [chatId, thread] = previous.split(':');
  const name = topics.nameFor(previous);
  reason = `the topic this session was last in${name ? ` — ${name}` : ''}`;
} else if (groupId) {
  chatId = groupId;
  createTopic = true;
  reason = 'a new topic: this session has never been in one';
} else {
  chatId = allowed[0];
  reason = 'the direct chat: no group is known';
}

if (!chatId) {
  console.error('Nowhere to send: pass --chat, or set ALLOWED_USER_IDS in .env');
  process.exit(1);
}

const toGroup = String(chatId).startsWith('-');
const token = toGroup && process.env.GROUP_BOT_TOKEN ? process.env.GROUP_BOT_TOKEN : process.env.BOT_TOKEN;
if (!token) {
  console.error(`No token for that destination (${toGroup ? 'GROUP_BOT_TOKEN' : 'BOT_TOKEN'} is missing from .env)`);
  process.exit(1);
}

// ── Summary ──────────────────────────────────────────────────────────────────
// Given one, use it. Otherwise quote what was last asked, which is enough to recognise the
// conversation on a phone without pretending to be a real summary.
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

// uresume: carries only the short id and resolves it in the unified registry. Skipping
// this is what makes a freshly moved session answer "Session not found" when tapped. A dry
// run registers nothing: it is there to show what would happen, not to half do it.
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

// ── The copy that always goes to the direct chat ─────────────────────────────
// A session that moved into a topic is easy to lose: the phone opens on the chat list, not
// on thread 158 of a group. So the direct chat keeps the index — every move leaves a line
// there carrying both ways in, the Resume button and a link straight to the message in its
// topic. The two buttons share one callback, so tapping both really does put two chats on
// one session; that is the cost of having the session reachable from the chat you open
// first, and it is the chosen trade.
const dmChat = allowed[0];
const dmCopyWanted = Boolean(dmChat) && String(chatId) !== String(dmChat);

// t.me/c is how a private group addresses itself: the -100 prefix Telegram uses in the API
// is not part of the link, and the thread id sits where a message id would in a group
// without topics. Appending the message id lands on the button rather than the top of the
// thread.
function topicLink(chat, threadId, messageId) {
  const internal = String(chat).replace(/^-100/, '').replace(/^-/, '');
  return `https://t.me/c/${internal}/${threadId}${messageId ? `/${messageId}` : ''}`;
}

function dmPayload(link, topicName) {
  const rows = [[{ text: '▶️ Resume Session', callback_data: `uresume:${shortId}` }]];
  if (link) rows.push([{ text: '📂 Open in topic', url: link }]);
  return {
    chat_id: dmChat,
    text: [
      '🖥➡📱 Session from Terminal',
      '',
      `📁 Project: ${path.basename(cwd)}`,
      `🔗 Session: ${shortId}`,
      topicName ? `🧵 Topic: ${topicName}` : null,
      '',
      `💬 ${summary}`,
      '',
      link ? `Resume here, or open it where it landed:\n${link}` : 'Tap the button to continue:',
    ].filter(v => v !== null).join('\n'),
    reply_markup: { inline_keyboard: rows },
  };
}

if (dryRun) {
  console.log(`would send to ${chatId}${thread ? ` topic ${thread}` : ''} via the ${toGroup ? 'group' : 'main'} bot`);
  console.log(`because: ${reason}${createTopic ? ' (created on send)' : ''}\n`);
  console.log(text);
  console.log(`\nbutton: uresume:${shortId}`);
  console.log(`would register: ${found.id}`);
  if (dmCopyWanted) {
    const link = topicLink(chatId, thread || '<new topic>', '<message id>');
    console.log(`\n── and a copy to the direct chat (${dmChat}) ──`);
    console.log(dmPayload(link, createTopic ? '<created on send>' : topics.nameFor(`${chatId}:${thread}`)).text);
    console.log(`\nbuttons: uresume:${shortId} | ${link}`);
  } else {
    console.log('\nno direct-chat copy: this is already going to the direct chat');
  }
  process.exit(0);
}

function call(method, params, useToken = token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req = https.request({
      host: 'api.telegram.org',
      path: `/bot${useToken}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) {}
        if (parsed && parsed.ok) resolve(parsed.result);
        else reject(new Error((parsed && parsed.description) || data.slice(0, 200)));
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  try {
    if (createTopic) {
      // Named for the work, so the thread is recognisable in the list later. The bot needs
      // can_manage_topics in the group, which it has as an admin.
      const name = (newTopicName || `${path.basename(cwd)} · ${summary}`).replace(/\s+/g, ' ').trim().slice(0, 128);
      const created = await call('createForumTopic', { chat_id: Number(chatId), name });
      payload.message_thread_id = created.message_thread_id;
      topics.remember({
        chat: { id: Number(chatId) },
        message_thread_id: created.message_thread_id,
        forum_topic_created: { name },
      });
      console.log(`Created topic "${name}" (${created.message_thread_id})`);
    }

    const sent = await call('sendMessage', payload);

    // Remember where it landed, or "go back to its topic" can never come true: nothing
    // else records this. The bot writes a session against a chat only once that chat runs
    // a turn, and a message carrying a button has not run one yet — so the next move would
    // open a second topic for a session that already has one.
    if (payload.message_thread_id) {
      unifiedSessions.addSession({
        id: found.id,
        source: 'cli',
        sourceId: `${chatId}:${payload.message_thread_id}`,
        projectPath: cwd,
        topic: summary.slice(0, 50),
        messageCount: 1,
      });
    }

    const where = payload.message_thread_id ? ` → topic ${payload.message_thread_id}` : '';
    console.log(`Session sent to Telegram (${shortId})${where}`);
    console.log(`Sent to ${reason}.`);

    // The copy goes out after the real send, and its failure is reported but not fatal: the
    // session has already moved by this point, and exiting non-zero over a missing index
    // line would read as "it did not move".
    if (dmCopyWanted) {
      const dmToken = process.env.BOT_TOKEN;
      if (!dmToken) {
        console.error('No copy to the direct chat: BOT_TOKEN is missing from .env');
      } else {
        const link = payload.message_thread_id
          ? topicLink(chatId, payload.message_thread_id, sent && sent.message_id)
          : null;
        const name = payload.message_thread_id ? topics.nameFor(`${chatId}:${payload.message_thread_id}`) : null;
        try {
          await call('sendMessage', dmPayload(link, name), dmToken);
          console.log(`Also in the direct chat${link ? `, with a link to the topic` : ''}.`);
        } catch (err) {
          // Telegram rejects a url button it will not render — an old client, a link shape
          // it does not accept. The link is in the text too, so drop the button and retry
          // rather than leave the direct chat without the session at all.
          if (/BUTTON_URL/i.test(err.message)) {
            await call('sendMessage', dmPayload(null, name), dmToken);
            console.log('Also in the direct chat (link button refused, link is in the text).');
          } else {
            console.error(`No copy to the direct chat: ${err.message}`);
          }
        }
      }
    }
  } catch (err) {
    console.error(`Telegram refused it: ${err.message}`);
    process.exit(1);
  }
})();

#!/usr/bin/env node
/**
 * QA harness — drive the real bot with synthetic updates and check where replies land.
 *
 * Why this exists rather than a script that talks to Telegram: a bot cannot drive itself.
 * Telegram never delivers one bot's messages to another, and an inline button can only be
 * pressed by a person, so the obvious "send a command and read the reply" loop is not
 * available to us. Every routing bug we have chased — a command answered in General, a
 * menu missing inside a topic, a reply that went to the direct chat instead of the thread
 * it was asked from — is decided before any network call, in which chat id a handler
 * replies to. That is exactly what this measures.
 *
 * The real bot.js is loaded with CLAUDEGRAM_QA=1, so it neither polls nor takes the
 * running instance's place, and writes to data-qa/ instead of data/. Outgoing API calls
 * are captured instead of sent, so a run is free and leaves nothing behind.
 *
 *   node scripts/qa.js            run every case
 *   node scripts/qa.js topic      run cases whose name contains "topic"
 */

process.env.CLAUDEGRAM_QA = '1';

const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const childProcess = require('child_process');
const TelegramBot = require('node-telegram-bot-api');

// ── Stand in for the Claude CLI ──────────────────────────────────────────────
// Patched before bot.js is loaded, because lib/commands/claude.js destructures spawn at
// require time. A turn then runs end to end in milliseconds and costs nothing, and the
// working directory each session is started in — the thing that decides whether two chats
// share a memory — becomes something a test can assert on.
const spawns = [];
const realSpawn = childProcess.spawn;
let fakePid = 5000;

childProcess.spawn = function (file, args, options) {
  if (!/claude/i.test(String(file))) return realSpawn.apply(this, arguments);

  const proc = new EventEmitter();
  proc.pid = ++fakePid;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; proc.emit('close', 0, null); return true; };

  const sessionId = `qa-session-${proc.pid}`;
  spawns.push({ pid: proc.pid, sessionId, cwd: (options && options.cwd) || null, args: args || [] });

  const emit = (obj, delay) => setTimeout(() => {
    if (!proc.killed) proc.stdout.write(JSON.stringify(obj) + '\n');
  }, delay);

  emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: options && options.cwd }, 10);
  emit({ type: 'result', subtype: 'success', session_id: sessionId, result: 'QA answer' }, 60);

  return proc;
};

// ── Capture every outgoing call ──────────────────────────────────────────────
const sent = [];
let nextMessageId = 1000;

const record = (method, chatId, options, text) => {
  sent.push({
    method,
    chat: String(chatId),
    thread: (options && options.message_thread_id) != null ? options.message_thread_id : null,
    text: typeof text === 'string' ? text : '',
  });
};

const stub = (name, impl) => { TelegramBot.prototype[name] = impl; };

// Chat-first senders: (chatId, payload, options)
for (const name of ['sendMessage', 'sendPhoto', 'sendDocument', 'sendVoice', 'sendAudio', 'sendSticker']) {
  stub(name, function (chatId, payload, options) {
    record(name, chatId, options, payload);
    const id = ++nextMessageId;
    return Promise.resolve({ message_id: id, chat: { id: chatId }, text: String(payload) });
  });
}

stub('sendChatAction', function (chatId, action, options) {
  record('sendChatAction', chatId, options, action);
  return Promise.resolve(true);
});

for (const name of ['editMessageText', 'editMessageCaption', 'editMessageReplyMarkup']) {
  stub(name, function (payload, options = {}) {
    record(name, options.chat_id, options, payload);
    return Promise.resolve({ message_id: options.message_id, chat: { id: options.chat_id } });
  });
}

stub('deleteMessage', function (chatId, messageId) {
  record('deleteMessage', chatId, null, String(messageId));
  return Promise.resolve(true);
});

stub('answerCallbackQuery', function () { return Promise.resolve(true); });
stub('setMyCommands', function () { return Promise.resolve(true); });
stub('getMe', function () {
  return Promise.resolve({ id: 42, is_bot: true, username: GROUP_BOT_USERNAME, first_name: 'QA' });
});

const GROUP_BOT_USERNAME = 'qa_group_bot';
const OTHER_BOT_USERNAME = 'qa_other_bot';

// ── Boot the real bot ────────────────────────────────────────────────────────
const botModule = require(path.join(__dirname, '..', 'bot.js'));
const { bot, groupBot } = botModule;

const USER_ID = (process.env.ALLOWED_USER_IDS || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean)[0];
const STRANGER_ID = 999000111;
const DM_CHAT = USER_ID;
const GROUP_CHAT = -1001111111111;

if (!USER_ID) {
  console.error('ALLOWED_USER_IDS is empty — the harness needs an authorised id to act as.');
  process.exit(1);
}
if (!groupBot) {
  console.error('GROUP_BOT_TOKEN is not set, so there is no group bot to test.');
  process.exit(1);
}

// ── Update factories ─────────────────────────────────────────────────────────
let nextUpdateId = 1;

const message = (chat, text, { thread = null, from = USER_ID } = {}) => ({
  update_id: nextUpdateId++,
  message: {
    message_id: nextUpdateId,
    from: { id: from, is_bot: false, first_name: 'QA' },
    chat: { id: chat, type: chat < 0 ? 'supergroup' : 'private' },
    date: 1700000000,
    text,
    ...(thread != null ? { message_thread_id: thread, is_topic_message: true } : {}),
  },
});

const callback = (chat, data, { thread = null, from = USER_ID } = {}) => ({
  update_id: nextUpdateId++,
  callback_query: {
    id: String(nextUpdateId),
    from: { id: from, is_bot: false, first_name: 'QA' },
    data,
    message: {
      message_id: nextUpdateId,
      chat: { id: chat, type: chat < 0 ? 'supergroup' : 'private' },
      date: 1700000000,
      ...(thread != null ? { message_thread_id: thread, is_topic_message: true } : {}),
    },
  },
});

// Which bot Telegram would hand this update to: the group bot owns groups.
const deliver = async (update, { wait = 250, keep = false } = {}) => {
  if (!keep) { sent.length = 0; spawns.length = 0; }
  const holder = update.message || (update.callback_query && update.callback_query.message);
  const target = holder.chat.id < 0 ? groupBot : bot;
  target.processUpdate(update);
  await new Promise(resolve => setTimeout(resolve, wait));
  return sent.slice();
};

// ── Expectations ─────────────────────────────────────────────────────────────
// A case asserts where the reply went, never the wording: the text is free to change,
// the destination is the thing that keeps breaking.
const repliedTo = (calls, chat, thread) =>
  calls.some(c => c.chat === String(chat) && c.thread === thread && c.method !== 'sendChatAction');

const CASES = [
  {
    name: 'dm: /settings answers in the direct chat',
    update: () => message(DM_CHAT, '/settings'),
    check: (calls) => repliedTo(calls, DM_CHAT, null) || 'no reply reached the direct chat',
  },
  {
    name: 'dm: /menu answers in the direct chat',
    update: () => message(DM_CHAT, '/menu'),
    check: (calls) => repliedTo(calls, DM_CHAT, null) || 'no reply reached the direct chat',
  },
  {
    name: 'general: /settings answers in the group, not a thread',
    update: () => message(GROUP_CHAT, '/settings'),
    check: (calls) => repliedTo(calls, GROUP_CHAT, null) || 'no reply reached the group',
  },
  {
    name: 'topic: /settings answers inside the topic it was typed in',
    update: () => message(GROUP_CHAT, '/settings', { thread: 41 }),
    check: (calls) =>
      repliedTo(calls, GROUP_CHAT, 41) ||
      (repliedTo(calls, GROUP_CHAT, null) ? 'answered in General instead of topic 41' : 'no reply at all'),
  },
  {
    name: 'topic: /menu answers inside the topic',
    update: () => message(GROUP_CHAT, '/menu', { thread: 41 }),
    check: (calls) =>
      repliedTo(calls, GROUP_CHAT, 41) ||
      (repliedTo(calls, GROUP_CHAT, null) ? 'answered in General instead of topic 41' : 'no reply at all'),
  },
  {
    name: 'topic: /claude answers inside the topic',
    update: () => message(GROUP_CHAT, '/claude', { thread: 41 }),
    check: (calls) =>
      repliedTo(calls, GROUP_CHAT, 41) ||
      (repliedTo(calls, GROUP_CHAT, null) ? 'answered in General instead of topic 41' : 'no reply at all'),
  },
  {
    name: 'topic: two topics do not answer into each other',
    update: () => message(GROUP_CHAT, '/settings', { thread: 86 }),
    check: (calls) =>
      calls.every(c => c.thread === 86 || c.method === 'sendChatAction') ||
      `a reply escaped topic 86: ${JSON.stringify(calls.map(c => c.thread))}`,
  },
  {
    name: 'addressed: /settings@self is answered',
    update: () => message(GROUP_CHAT, `/settings@${GROUP_BOT_USERNAME}`, { thread: 41 }),
    check: (calls) => repliedTo(calls, GROUP_CHAT, 41) || 'the @self suffix stopped the command matching',
  },
  {
    name: 'addressed: /settings@other-bot is ignored',
    update: () => message(GROUP_CHAT, `/settings@${OTHER_BOT_USERNAME}`, { thread: 41 }),
    check: (calls) => calls.length === 0 || 'answered a command addressed to the other bot',
  },
  {
    name: 'anchored regex survives the @suffix (/stream)',
    update: () => message(GROUP_CHAT, `/stream@${GROUP_BOT_USERNAME}`, { thread: 41 }),
    check: (calls) => repliedTo(calls, GROUP_CHAT, 41) || 'an anchored regex still loses to the @suffix',
  },
  {
    // The refusal itself is intended. What matters is that it reaches the topic it was
    // triggered from — it used to be addressed to the raw "<chat>:<thread>" key, which
    // Telegram rejects — and that nothing else leaks to a stranger.
    name: 'auth: a stranger is refused, in the right topic, and told nothing else',
    update: () => message(GROUP_CHAT, '/settings', { thread: 41, from: STRANGER_ID }),
    check: (calls) =>
      calls.every(c => c.chat === String(GROUP_CHAT) && c.thread === 41 && /Unauthorized/.test(c.text)) ||
      `a stranger saw more than a refusal: ${JSON.stringify(calls.map(c => [c.chat, c.thread, c.text.slice(0, 40)]))}`,
  },
  {
    // An edit addresses an existing message by id, so it carries no thread — the id is
    // what places it. The chat still has to be the group itself, never the raw key.
    name: 'callback: a button pressed in a topic edits in the right chat',
    update: () => callback(GROUP_CHAT, 'all:settings', { thread: 41 }),
    check: (calls) =>
      calls.length === 0 ? 'the button press produced nothing' :
      calls.every(c => c.chat === String(GROUP_CHAT)) ||
      `a reply escaped the group: ${JSON.stringify(calls.map(c => [c.method, c.chat]))}`,
  },

  // ── Separate chats, separate sessions ──────────────────────────────────────
  {
    name: 'sessions: two topics start two different sessions',
    run: async () => {
      const a = await deliver(message(GROUP_CHAT, 'hello from 41', { thread: 41 }), { wait: 400 });
      const started41 = spawns.slice();
      const b = await deliver(message(GROUP_CHAT, 'hello from 86', { thread: 86 }), { wait: 400 });
      const started86 = spawns.slice();

      if (!started41.length || !started86.length) return 'a topic never started a session of its own';
      if (started41[0].sessionId === started86[0].sessionId) return 'both topics share one session';
      if (started41[0].cwd === started86[0].cwd) {
        return `both topics run in the same directory, so they share a memory: ${started41[0].cwd}`;
      }
      if (!a.some(c => c.thread === 41)) return 'topic 41 never saw its own answer';
      if (!b.some(c => c.thread === 86)) return 'topic 86 never saw its own answer';
      return true;
    },
  },
  {
    name: 'sessions: the direct chat is not the group\'s session',
    run: async () => {
      await deliver(message(DM_CHAT, 'hello from the direct chat'), { wait: 400 });
      const dm = spawns.slice();
      await deliver(message(GROUP_CHAT, 'hello from general'), { wait: 400 });
      const general = spawns.slice();

      if (!dm.length || !general.length) return 'one of them never started a session';
      if (dm[0].sessionId === general[0].sessionId) return 'the direct chat and General share a session';
      if (dm[0].cwd === general[0].cwd) return `both run in ${dm[0].cwd}, so they share a memory`;
      return true;
    },
  },
  {
    name: 'sessions: a topic answers only its own chat',
    run: async () => {
      const calls = await deliver(message(GROUP_CHAT, 'hello again from 41', { thread: 41 }), { wait: 400 });
      const strays = calls.filter(c => c.chat !== String(GROUP_CHAT) || (c.thread !== 41 && c.method !== 'editMessageText' && c.method !== 'deleteMessage'));
      return strays.length === 0 || `answers escaped topic 41: ${JSON.stringify(strays.map(c => [c.method, c.chat, c.thread]))}`;
    },
  },
];

// ── Run ──────────────────────────────────────────────────────────────────────
(async () => {
  const filter = process.argv[2];
  const cases = filter ? CASES.filter(c => c.name.includes(filter)) : CASES;
  let failed = 0;

  console.log(`\nQA: ${cases.length} case(s)\n`);

  for (const testCase of cases) {
    let calls = [];
    let verdict;
    if (testCase.run) {
      verdict = await testCase.run();
    } else {
      calls = await deliver(testCase.update());
      verdict = testCase.check(calls);
    }
    if (verdict === true) {
      console.log(`  ok    ${testCase.name}`);
    } else {
      failed++;
      console.log(`  FAIL  ${testCase.name}`);
      console.log(`        ${verdict}`);
      console.log(`        calls: ${JSON.stringify(calls.map(c => ({ m: c.method, chat: c.chat, thread: c.thread })))}`);
    }
  }

  console.log(`\n${cases.length - failed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();

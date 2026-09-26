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

  const write = (obj) => { if (!proc.killed) proc.stdout.write(JSON.stringify(obj) + '\n'); };
  setTimeout(() => write({ type: 'system', subtype: 'init', session_id: sessionId, cwd: options && options.cwd }), 10);

  // The answer quotes the prompt back. Two chats talking at once produce two identical
  // replies otherwise, and identical replies cannot show whether one landed in the other's
  // thread — which is the whole question being asked.
  // The prompt arrives as stream-json, one message per line, and content is a plain string
  // in some turns and a list of parts in others. Parse rather than pattern-match, and take
  // the tail: the bot prepends a style block, so what was actually typed is at the end.
  const promptOf = (line) => {
    try {
      const parsed = JSON.parse(line);
      const content = parsed && parsed.message && parsed.message.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.map(part => (part && part.text) || '').join(' ');
    } catch (e) {}
    return '';
  };

  let stdinBuf = '';
  let answered = false;
  const answer = () => {
    if (answered || proc.killed) return;
    answered = true;
    const prompts = stdinBuf.split('\n').map(promptOf).filter(Boolean);
    const echo = prompts.length ? prompts[prompts.length - 1].slice(-80) : '(no prompt seen)';
    write({ type: 'result', subtype: 'success', session_id: sessionId, result: `QA answer to: ${echo}` });
  };
  proc.stdin.on('data', (chunk) => { stdinBuf += chunk.toString(); setTimeout(answer, 40); });
  setTimeout(answer, 800);   // a turn must never be able to hang the run

  return proc;
};

// ── Capture every outgoing call ──────────────────────────────────────────────
const sent = [];
let nextMessageId = 1000;

const record = (method, chatId, options, text) => {
  const rows = (options && options.reply_markup && options.reply_markup.inline_keyboard) || [];
  sent.push({
    method,
    chat: String(chatId),
    thread: (options && options.message_thread_id) != null ? options.message_thread_id : null,
    text: typeof text === 'string' ? text : '',
    // Captured so a test can press what a menu actually offers, rather than a hand-kept
    // list that drifts the moment a button is added.
    buttons: rows.flat().map(b => b && b.callback_data).filter(Boolean),
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

// The bot publishes its own command list at startup. Capturing it here is what lets the
// suite run every command the menu advertises, instead of a copy kept in step by hand.
let registeredCommands = [];
stub('setMyCommands', function (commands) {
  if (Array.isArray(commands)) {
    registeredCommands = [...new Set([...registeredCommands, ...commands.map(c => c.command)])];
  }
  return Promise.resolve(true);
});
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

// Let whatever the last case set in motion finish and be discarded. A GaggiMate panel or a
// finished turn arriving a second late would otherwise be counted against the next case,
// and read exactly like a reply that escaped into the wrong chat.
const settle = async (ms = 900) => {
  await new Promise(resolve => setTimeout(resolve, ms));
  sent.length = 0;
  spawns.length = 0;
};

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

// Buttons that would end the run rather than test it: a restart or a close takes the
// process down, and a reset throws away the state the later cases rely on.
const DESTRUCTIVE = /restart|close|reset|clean|delete|remove|kill|shutdown|clearlog|forceresume|move_to_mac/i;

// Open a menu, then press everything it offers and check each answer comes back to the
// same chat. Reading the buttons off the menu itself means a button added later is tested
// without anyone remembering to add it here.
async function pressEveryButton(chat, thread) {
  const opened = await deliver(message(chat, '/menu', { thread }), { wait: 300 });
  const offered = [...new Set(opened.flatMap(c => c.buttons))];
  const pressable = offered.filter(data => !DESTRUCTIVE.test(data));

  if (!offered.length) return '/menu offered no buttons at all';
  if (!pressable.length) return `every button looked destructive: ${offered.join(', ')}`;

  const broken = [];
  for (const data of pressable) {
    await settle();
    let calls = await deliver(callback(chat, data, { thread }), { wait: 400 });
    if (!calls.length) {
      // A button that reaches something outside this process — the espresso machine, a
      // local HTTP service — answers later than one that only redraws a menu. Give it a
      // second window before calling it dead, or the suite fails on a slow network.
      await new Promise(resolve => setTimeout(resolve, 1200));
      calls = sent.slice();
    }
    if (!calls.length) { broken.push(`${data} → nothing happened`); continue; }
    const stray = calls.find(c => c.chat !== String(chat));
    if (stray) broken.push(`${data} → ${stray.method} to ${stray.chat}: ${JSON.stringify(stray.text.slice(0, 50))}`);
  }

  return broken.length === 0 ||
    `${broken.length} of ${pressable.length} buttons misbehaved: ${broken.slice(0, 6).join(' | ')}`;
}

// Type every command the bot advertises and see whether it answers, and where. A command
// in the published list that does nothing is a broken promise to whoever pressed it.
async function runEveryCommand(chat, thread) {
  const names = registeredCommands.filter(name => !DESTRUCTIVE.test(name));
  if (!names.length) return 'the bot published no commands to run';

  const silent = [];
  const strays = [];

  for (const name of names) {
    await settle(300);
    let calls = await deliver(message(chat, `/${name}`, { thread }), { wait: 400 });
    if (!calls.length) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      calls = sent.slice();
    }
    if (!calls.length) { silent.push(name); continue; }
    const wrong = calls.find(c => c.chat !== String(chat));
    if (wrong) strays.push(`/${name} → ${wrong.chat}`);
  }

  const problems = [];
  if (strays.length) problems.push(`answered the wrong chat: ${strays.join(', ')}`);
  if (silent.length) problems.push(`said nothing: ${silent.map(n => '/' + n).join(', ')}`);
  return problems.length === 0 || `${problems.join(' | ')} (of ${names.length} run)`;
}

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
  // ── Every button the menus actually offer ──────────────────────────────────
  {
    name: 'menu: every button pressed in a topic answers in that topic',
    run: () => pressEveryButton(GROUP_CHAT, 41),
  },
  {
    name: 'menu: every button pressed in a second topic stays there',
    run: () => pressEveryButton(GROUP_CHAT, 86),
  },
  {
    name: 'menu: every button pressed in the direct chat answers there',
    run: () => pressEveryButton(DM_CHAT, null),
  },

  // ── Every command the bot publishes ────────────────────────────────────────
  {
    name: 'commands: every published command answers inside a topic',
    run: () => runEveryCommand(GROUP_CHAT, 41),
  },
  {
    name: 'commands: every published command answers in the direct chat',
    run: () => runEveryCommand(DM_CHAT, null),
  },

  // ── The Resume button a moved session arrives with ─────────────────────────
  {
    // scripts/move-to-telegram.js registers the session and sends a uresume: button. The
    // registration is the part that is easy to lose — without it the tap comes back
    // "Session not found" — so the check is that a registered session resolves, and
    // resolves into the topic the button was tapped in.
    name: 'resume button: a moved session resumes in the topic it was tapped in',
    run: async () => {
      const unified = require(path.join(__dirname, '..', 'lib', 'unified-sessions'));
      const id = 'qa11111-2222-3333-4444-555566667777';
      unified.addSession({ id, source: 'cli', projectPath: process.cwd(), topic: 'QA moved session', messageCount: 1 });

      const calls = await deliver(callback(GROUP_CHAT, `uresume:${id.slice(0, 8)}`, { thread: 41 }), { wait: 700 });
      if (!calls.length) return 'tapping Resume did nothing';
      if (calls.some(c => /not found/i.test(c.text))) {
        return `the registered session did not resolve: ${calls.map(c => c.text.slice(0, 60)).join(' | ')}`;
      }
      const stray = calls.find(c => c.chat !== String(GROUP_CHAT));
      return !stray || `Resume answered elsewhere: ${stray.chat}`;
    },
  },

  // ── Session commands inside a topic ────────────────────────────────────────
  {
    name: 'topic: /new starts a fresh session for that topic alone',
    run: async () => {
      await deliver(message(GROUP_CHAT, 'first turn', { thread: 41 }), { wait: 500 });
      const before = spawns.slice();
      await deliver(message(GROUP_CHAT, '/new', { thread: 41 }), { wait: 300 });
      const after = await deliver(message(GROUP_CHAT, 'turn after new', { thread: 41 }), { wait: 500 });

      if (!before.length || !spawns.length) return '/new left the topic without a session';
      if (spawns[0].sessionId === before[0].sessionId) return '/new reused the old session';
      if (spawns[0].args.includes('--resume')) return '/new resumed instead of starting fresh';
      return after.some(c => c.thread === 41) || 'the new session did not answer in topic 41';
    },
  },
  {
    name: 'topic: /resume answers in the topic it was asked from',
    update: () => message(GROUP_CHAT, '/resume', { thread: 41 }),
    check: (calls) =>
      calls.length === 0 ? '/resume said nothing at all' :
      calls.every(c => c.chat === String(GROUP_CHAT)) ||
      `/resume answered elsewhere: ${JSON.stringify(calls.map(c => [c.method, c.chat, c.thread]))}`,
  },
  {
    name: 'topic: /sessions answers in the topic it was asked from',
    update: () => message(GROUP_CHAT, '/sessions', { thread: 86 }),
    check: (calls) =>
      calls.length === 0 ? '/sessions said nothing at all' :
      calls.every(c => c.chat === String(GROUP_CHAT)) ||
      `/sessions answered elsewhere: ${JSON.stringify(calls.map(c => [c.method, c.chat, c.thread]))}`,
  },

  // ── Two topics talking at the same time ────────────────────────────────────
  {
    // Delivered without waiting in between, so both turns are genuinely in flight. The
    // stub quotes each prompt back, which is what makes a crossed reply visible.
    name: 'concurrent: two topics at once never answer into each other',
    run: async () => {
      sent.length = 0;
      spawns.length = 0;
      groupBot.processUpdate(message(GROUP_CHAT, 'marker-alpha', { thread: 41 }));
      groupBot.processUpdate(message(GROUP_CHAT, 'marker-beta', { thread: 86 }));
      await new Promise(resolve => setTimeout(resolve, 1200));

      const calls = sent.slice();
      const answers = calls.filter(c => /marker-/.test(c.text));
      if (!answers.length) {
        return `neither turn produced an answer; saw ${JSON.stringify(calls.map(c => [c.method, c.thread, c.text.slice(0, 45)]))}`;
      }

      const crossed = answers.filter(c =>
        (c.thread === 41 && /marker-beta/.test(c.text)) ||
        (c.thread === 86 && /marker-alpha/.test(c.text)));
      if (crossed.length) {
        return `a reply landed in the wrong topic: ${JSON.stringify(crossed.map(c => [c.thread, c.text.slice(0, 40)]))}`;
      }

      const sessions = new Set(spawns.map(s => s.sessionId));
      if (spawns.length >= 2 && sessions.size < 2) return 'both turns ran in one session';
      const strays = calls.filter(c => c.chat !== String(GROUP_CHAT));
      return strays.length === 0 || `traffic escaped the group: ${JSON.stringify(strays.map(c => c.chat))}`;
    },
  },
  {
    name: 'concurrent: a topic and the direct chat at once stay apart',
    run: async () => {
      sent.length = 0;
      spawns.length = 0;
      groupBot.processUpdate(message(GROUP_CHAT, 'marker-group', { thread: 41 }));
      bot.processUpdate(message(DM_CHAT, 'marker-direct'));
      await new Promise(resolve => setTimeout(resolve, 1200));

      const answers = sent.filter(c => /marker-/.test(c.text));
      if (!answers.length) return 'neither turn produced an answer';
      const crossed = answers.filter(c =>
        (c.chat === String(DM_CHAT) && /marker-group/.test(c.text)) ||
        (c.chat === String(GROUP_CHAT) && /marker-direct/.test(c.text)));
      return crossed.length === 0 ||
        `a reply crossed between the group and the direct chat: ${JSON.stringify(crossed.map(c => [c.chat, c.text.slice(0, 40)]))}`;
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
    await settle();
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

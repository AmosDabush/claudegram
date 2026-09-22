/**
 * attach.js — the live-session pipe.
 *
 * Instead of `claude --resume <uuid>` (a NEW process over an old transcript),
 * this injects messages into a session that is already running, over its unix
 * socket. One process, no divergence, no context replay.
 *
 * Coexists with the resume pipe: while a chat is attached, messages go to the
 * live session; /detach hands the chat straight back to the normal flow.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sessionMeta = require('../session-meta');
const aiTitle = require('../ai-title');

const REGISTRY = path.join(os.homedir(), '.claude/telegram-bot/data/session-registry.json');
const ATTACHED = path.join(os.homedir(), '.claude/telegram-bot/data/attached.json');
const MODEFILE = path.join(os.homedir(), '.claude/telegram-bot/data/pipe-mode.json');

/**
 * Which pipe this chat is on. Deliberately a hard switch, not a fallback:
 * in 'attach' a failed delivery reports the error and stays put, it never
 * quietly reroutes into a resumed session.
 */
function getMode() {
  try { return JSON.parse(fs.readFileSync(MODEFILE, 'utf-8')).mode === 'attach' ? 'attach' : 'resume'; }
  catch (e) { return 'resume'; }
}
function setMode(m) {
  try { fs.writeFileSync(MODEFILE, JSON.stringify({ mode: m, ts: Date.now() }, null, 1)); } catch (e) {}
}
const PROJECTS = path.join(os.homedir(), '.claude/projects');

const CTL = path.join(os.homedir(), '.claude/telegram-bot/scripts/attach-ctl.sh');

// chatId -> pid. In-memory: an attachment is only meaningful while the target lives.
const attached = new Map();

function ctl(args, cb) {
  execFile('bash', [CTL, ...args], { timeout: 130000, stdio: ['ignore', 'pipe', 'pipe'] }, (err, stdout, stderr) =>
    cb(err, (stdout || '').trim(), (stderr || '').trim()));
}

/**
 * The attached target lives on disk, because it can also be set from the
 * terminal (remote-telegram.sh) and must survive a bot restart. The in-memory
 * map is only a cache.
 */
function currentTarget(chatId) {
  const mem = attached.get(chatId);
  if (mem && fs.existsSync(`/tmp/cc-socks/${mem}.sock`)) return mem;
  try {
    const pid = String(JSON.parse(fs.readFileSync(ATTACHED, 'utf-8')).pid);
    if (pid && fs.existsSync(`/tmp/cc-socks/${pid}.sock`)) {
      attached.set(chatId, pid);          // re-warm the cache
      return pid;
    }
  } catch (e) {}
  attached.delete(chatId);
  return null;
}

function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')) || {}; }
  catch (e) { return {}; }
}

function transcriptFor(sid) {
  try {
    for (const dir of fs.readdirSync(PROJECTS)) {
      const fp = path.join(PROJECTS, dir, sid + '.jsonl');
      if (fs.existsSync(fp)) return fp;
    }
  } catch (e) {}
  return null;
}

/** First real human line — the fallback when gemma has not titled it yet. */
function firstMessage(sid) {
  const fp = transcriptFor(sid);
  if (!fp) return null;
  try {
    for (const line of fs.readFileSync(fp, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch (e) { continue; }
      if (r.type !== 'user') continue;
      const c = r.message && r.message.content;
      const t = typeof c === 'string' ? c
              : Array.isArray(c) ? (c.find(x => x.type === 'text') || {}).text : null;
      if (!t) continue;
      if (t.startsWith('<') || t.startsWith('Caveat:')) continue;   // injected noise
      return t.replace(/\s+/g, ' ').trim().slice(0, 46);
    }
  } catch (e) {}
  return null;
}

/** note > gemma title > first message > folder name */
function titleFor(pid, cwd, reg) {
  const rec = reg[String(pid)];
  if (!rec) return null;
  const sid = rec.session_id;
  const note = sessionMeta.getNote(sid);
  if (note) return note;
  const ai = aiTitle.getCached(sid);
  if (ai) return ai;
  return firstMessage(sid);
}

function parseList(stdout) {
  return stdout.split('\n').slice(1)
    .map(l => l.trim().split(/\s+/))
    .filter(p => p.length >= 3 && /^\d+$/.test(p[0]))
    .map(p => ({ pid: p[0], age: p[1], cwd: p[p.length - 1] }));
}

function sendPicker(bot, chatId) {
  ctl(['list'], (err, stdout) => {
    if (err) return bot.sendMessage(chatId, '❌ Could not list sessions');
    const rows = parseList(stdout);
    if (!rows.length) return bot.sendMessage(chatId, '📭 No live Claude sessions to attach to.');

    const cur = currentTarget(chatId);
    const reg = loadRegistry();

    // Ask gemma for anything we have a session id for but no title yet.
    const untitled = rows.map(r => reg[String(r.pid)]).filter(Boolean)
      .map(rec => ({ id: rec.session_id, projectPath: rec.cwd }));
    if (untitled.length) { try { aiTitle.enqueue(untitled); } catch (e) {} }

    // Known sessions first, then by how recently the hook saw them.
    rows.sort((a, b) => (reg[String(b.pid)]?.ts || 0) - (reg[String(a.pid)]?.ts || 0));

    const keyboard = rows.map(r => {
      const title = titleFor(r.pid, r.cwd, reg);
      const proj = path.basename(r.cwd);
      const label = title ? `${title} · ${proj}` : `${proj} · ${r.pid} · ${r.age.split('-')[0]}d`;
      return [{ text: `${r.pid === cur ? '🔗 ' : ''}${label}`.slice(0, 64),
                callback_data: `uattach:${r.pid}` }];
    });
    if (cur) keyboard.push([{ text: '⏹ Detach (back to resume)', callback_data: 'udetach' }]);

    bot.sendMessage(chatId,
      `🔗 *Live sessions* (${rows.length})\n\nTap one to drive it directly — no resume, no new process.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
  });
}

function register(bot, isAuthorized) {
  bot.onText(/^\/attach$/, msg => {
    if (!isAuthorized(msg)) return;
    sendPicker(bot, msg.chat.id);
  });
  bot.onText(/^\/pipe$/, msg => {
    if (!isAuthorized(msg)) return;
    const c = pipeCard(msg.chat.id);
    bot.sendMessage(msg.chat.id, c.text, { parse_mode: 'Markdown', reply_markup: c.reply_markup });
  });
  bot.onText(/^\/detach$/, msg => {
    if (!isAuthorized(msg)) return;
    attached.delete(msg.chat.id);
    setMode('resume');
    ctl(['detach'], () => {});
    bot.sendMessage(msg.chat.id, '⏹ Detached — pipe switched back to RESUME.');
  });
}

function handleCallback(bot, query) {
  const data = query.data;
  const chatId = query.message.chat.id;

  if (data.startsWith('upipe:')) {
    const [, mode, ctx] = data.split(':');
    setMode(mode === 'attach' ? 'attach' : 'resume');
    const label = getMode() === 'attach' ? '🔗 REMOTE SES' : '📚 RESUME SESSIONS';
    bot.answerCallbackQuery(query.id, { text: label });

    const mid = query.message.message_id;
    if (ctx === 'remote') {
      const v = sectionView(chatId);
      bot.editMessageText(v.text, { chat_id: chatId, message_id: mid,
        parse_mode: 'Markdown', reply_markup: { inline_keyboard: v.keyboard } }).catch(() => {});
    } else if (ctx && renderers[ctx]) {
      renderers[ctx](bot, chatId, mid);            // redraw the screen it came from
    } else {
      const c = pipeCard(chatId);
      bot.editMessageText(c.text, { chat_id: chatId, message_id: mid,
        parse_mode: 'Markdown', reply_markup: c.reply_markup }).catch(() => {});
    }
    return true;
  }

  if (data === 'all:remote') {
    const v = sectionView(chatId);
    bot.answerCallbackQuery(query.id, { text: '🔗 Remote Ses' });
    bot.editMessageText(v.text, { chat_id: chatId, message_id: query.message.message_id,
      parse_mode: 'Markdown', reply_markup: { inline_keyboard: v.keyboard } }).catch(() => {});
    return true;
  }

  if (data === 'ulist') {
    bot.answerCallbackQuery(query.id, { text: '📋' });
    sendPicker(bot, chatId);
    return true;
  }

  if (data === 'udetach') {
    attached.delete(chatId);
    setMode('resume');
    ctl(['detach'], () => {});
    bot.answerCallbackQuery(query.id, { text: '⏹ Detached' });
    bot.sendMessage(chatId, '⏹ Detached — pipe switched back to RESUME.');
    return true;
  }

  if (data.startsWith('uattach:')) {
    const pid = data.substring(8);
    ctl(['attach', pid], (err, stdout, stderr) => {
      if (err) {
        bot.answerCallbackQuery(query.id, { text: '❌ Session is gone' });
        bot.sendMessage(chatId, `⚠️ Can't attach to \`${pid}\` — ${stderr || 'not a live session'}.\n\nUse a bookmark to resume instead.`,
          { parse_mode: 'Markdown' });
        return;
      }
      attached.set(chatId, pid);
      setMode('attach');                      // attaching implies you want the live pipe
      bot.answerCallbackQuery(query.id, { text: '🔗 Attached' });
      bot.sendMessage(chatId,
        `🔗 *Attached to a live session*\n\`\`\`\n${stdout}\n\`\`\`\nEverything you type now lands in that running session. /detach to stop.`,
        { parse_mode: 'Markdown' });
    });
    return true;
  }
  return false;
}

/** Returns true when the message was handled by the live pipe. */
function maybeRoute(bot, msg) {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith('/')) return false;      // commands always pass through
  if (getMode() !== 'attach') return false;             // resume mode: not ours

  const pid = currentTarget(chatId);
  if (!pid) {
    // ATTACH mode with no live target: refuse loudly rather than silently
    // handing the message to a resumed session.
    bot.sendMessage(chatId,
      '🔗 *Pipe is set to ATTACH but nothing is attached.*\n\nPick a session with /attach, or switch back with /pipe.',
      { parse_mode: 'Markdown' });
    return true;
  }

  bot.sendChatAction(chatId, 'typing').catch(() => {});
  ctl(['send', text], (err, stdout, stderr) => {
    if (err) {
      // Stay in attach mode and stay attached — report and let the user decide.
      bot.sendMessage(chatId,
        `⚠️ Delivery to \`${pid}\` failed — *still in ATTACH mode*, nothing was rerouted.\n\n\`${(stderr || err.message || '').slice(0, 300)}\`\n\n/attach to pick another · /pipe to switch to resume`,
        { parse_mode: 'Markdown' });
      return;
    }
    bot.sendMessage(chatId, `📨 → ${stdout}`);
  });
  return true;
}

// Renderers injected by bot.js so the toggle can redraw whatever screen it was
// pressed on (main menu, remote section, claude panel) instead of replacing it.
const renderers = {};
function setRenderers(r) { Object.assign(renderers, r); }

/**
 * The toggle row. Deliberately spells out both destinations — this switches
 * where your messages GO, so it must never be ambiguous.
 */
function toggleRow(ctx) {
  const on = getMode() === 'attach';
  const sfx = ctx ? ':' + ctx : '';
  return [
    { text: on ? '🔗 ✅ REMOTE SES' : '🔗 Remote Ses',      callback_data: 'upipe:attach' + sfx },
    { text: on ? '📚 Resume Sessions' : '📚 ✅ RESUME',      callback_data: 'upipe:resume' + sfx }
  ];
}

/** The "Remote Ses" section of the main menu. */
function sectionView(chatId) {
  const pid = currentTarget(chatId);
  const on = getMode() === 'attach';
  return {
    text: `🔗 *Remote Ses*\n\n` +
          `Drive a session that is *already running* instead of resuming a dead one.\n\n` +
          `Pipe: *${on ? 'REMOTE SES' : 'RESUME SESSIONS'}*\n` +
          `Attached: ${pid ? '`' + pid + '`' : '_nothing_'}\n\n` +
          `_From a terminal:_ \`/remote-telegram-current-session\` · \`/remote-telegram-all\``,
    keyboard: [
      toggleRow('remote'),
      [{ text: '📋 Pick a live session', callback_data: 'ulist' }],
      [{ text: '⏹ Detach', callback_data: 'udetach' }],
      [{ text: '⬅️ Back', callback_data: 'all:back' }]
    ]
  };
}

function pipeCard(chatId) {
  const mode = getMode();
  const pid = currentTarget(chatId);
  const on = mode === 'attach';
  return {
    text: `🔀 *Pipe: ${on ? 'ATTACH (live session)' : 'RESUME (normal flow)'}*\n\n` +
          (on
            ? `Messages go straight into ${pid ? '`' + pid + '`' : '_nothing attached_'}.\nA failed send reports the error — it never falls back to resume.`
            : 'Messages go through the normal resume/bookmark flow.'),
    reply_markup: { inline_keyboard: [[
      { text: on ? '● ATTACH' : 'ATTACH', callback_data: 'upipe:attach' },
      { text: on ? 'RESUME' : '● RESUME', callback_data: 'upipe:resume' }
    ], [
      { text: '📋 Sessions', callback_data: 'ulist' }
    ]] }
  };
}

module.exports = { register, handleCallback, maybeRoute, attached, getMode, setMode,
                   toggleRow, sectionView, setRenderers };

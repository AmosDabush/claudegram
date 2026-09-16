/**
 * Ask Command
 * /askhistory <question> - answer a question from your own Claude Code session history.
 *
 * Thin client over the sessions-ui ask endpoint: it owns the retrieval, the
 * vocabulary feedback round and the grounded answer. Here we only drive it and
 * report progress, because the flow takes ~45s and silence reads as a hang.
 */

const http = require('http');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const UI_PORT = Number(process.env.SESSIONS_UI_PORT || 4747);
const UI_HOST = '127.0.0.1';
const START_SCRIPT = path.join(os.homedir(), '.claude', 'sessions-ui', 'start.sh');
const ASK_TIMEOUT_MS = 6 * 60 * 1000;
const TG_LIMIT = 3800;

const PROMPT_TEXT = 'מה לחפש בהיסטוריה?';
const pendingAsks = new Map();
const running = new Set();

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: UI_HOST, port: UI_PORT, path: '/', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// The UI server is normally already up; if it is not, bring it up rather than
// making the user go to the Mac to start it.
async function ensureServer() {
  if (await ping()) return true;
  try {
    spawn('/bin/bash', [START_SCRIPT], { detached: true, stdio: 'ignore' }).unref();
  } catch { return false; }
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await ping()) return true;
  }
  return false;
}

function chunks(text, size) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

// Plain text on purpose. Telegram's Markdown trips over stray underscores and
// backticks, and identifiers with underscores are exactly what these answers are full of.
function send(bot, chatId, text, extra) {
  return bot.sendMessage(chatId, text, extra || {});
}

function askStream(question, onEvent) {
  return new Promise((resolve, reject) => {
    const url = `/api/ask?q=${encodeURIComponent(question)}`;
    const req = http.get({ host: UI_HOST, port: UI_PORT, path: url }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('ask endpoint returned ' + res.statusCode)); }
      res.setEncoding('utf8');
      let buf = '';
      let done = null;
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let ev = null, data = null;
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev = line.slice(7).trim();
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (!ev || data === null) continue;
          let parsed;
          try { parsed = JSON.parse(data); } catch { continue; }
          if (ev === 'done') done = parsed;
          else if (ev === 'error') return reject(new Error(parsed.error || 'ask failed'));
          else onEvent(ev, parsed);
        }
      });
      res.on('end', () => done ? resolve(done) : reject(new Error('stream ended with no answer')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(ASK_TIMEOUT_MS, () => { req.destroy(new Error('ask timed out')); });
  });
}

const STAGE_LABELS = {
  plan: 'מנסח מה לחפש',
  sweep: 'סורק את כל הארכיון',
  replan: 'לא נמצא כלום — מנסח מחדש',
  expand: 'עוקב אחרי החוט',
  read: 'קורא את הסשנים שהתאימו',
  answer: 'מנסח תשובה',
};

async function runAsk(bot, chatId, question) {
  if (running.has(chatId)) {
    send(bot, chatId, 'שאלה אחרת עוד רצה. חכה שהיא תיגמר.');
    return;
  }
  running.add(chatId);

  let statusId = null;
  const lines = [`✦ ${question}`, ''];
  let lastPaint = 0;

  const paint = async (force) => {
    const now = Date.now();
    if (!force && now - lastPaint < 1200) return;   // Telegram rate-limits edits
    lastPaint = now;
    if (!statusId) return;
    try {
      await bot.editMessageText(lines.join('\n').slice(0, TG_LIMIT), { chat_id: chatId, message_id: statusId });
    } catch { /* identical text or rate limit — not worth surfacing */ }
  };

  try {
    if (!(await ensureServer())) {
      send(bot, chatId, 'לא הצלחתי להרים את שרת הסשנים על המאק. תבדוק אותו ידנית.');
      return;
    }

    const status = await send(bot, chatId, lines.join('\n') + '\n· מתחיל…');
    statusId = status.message_id;

    const result = await askStream(question, (ev, d) => {
      if (ev === 'stage') {
        const label = STAGE_LABELS[d.stage] || d.stage;
        lines.push('· ' + label);
        paint();
      } else if (ev === 'plan') {
        lines.push('  מחפש: ' + (d.terms || []).join(', '));
        if ((d.nominated || []).length) lines.push('  ניחוש לפי כותרות: ' + d.nominated.length + ' סשנים');
        paint();
      } else if (ev === 'pruned' && (d.dropped || []).length) {
        lines.push('  נזרק כרעש: ' + d.dropped.join(', '));
        paint();
      } else if (ev === 'expanded') {
        lines.push('  מונחים אמיתיים מהארכיון: ' + (d.terms || []).join(', '));
        paint();
      } else if (ev === 'sessions') {
        lines.push('  ' + d.length + ' סשנים נקראו לעומק');
        paint();
      }
    });

    lines.push('', '✓ מוכן');
    await paint(true);

    if (!result.answer) {
      send(bot, chatId, 'לא נמצא כלום בארכיון על זה.\nנסה לנסח אחרת, או עם מונח שאתה בטוח שהופיע בשיחה.');
      return;
    }

    const parts = chunks(result.answer, TG_LIMIT);
    for (const part of parts) await send(bot, chatId, part);

    // sources, plus a button per cited session so the answer is one tap from the real thing
    const sources = result.sources || [];
    if (sources.length) {
      const bySession = [];
      for (const sc of sources) {
        let row = bySession.find(x => x.id === sc.id);
        if (!row) { row = { id: sc.id, title: sc.title, nums: [] }; bySession.push(row); }
        row.nums.push(sc.n);
      }
      let text = 'מקורות:\n';
      for (const row of bySession) {
        text += `[${row.nums.join('][')}] ${String(row.title || '').slice(0, 70)}\n`;
      }
      text += `\nנסרקו ${result.scannedSessions || 0} סשנים · ${Math.round((result.evidenceChars || 0) / 1000)}k תווים נקראו`;
      const keyboard = bySession.slice(0, 4).map(row => ([{
        text: `▶ ${String(row.title || row.id).slice(0, 40)}`,
        callback_data: `askres:${row.id.slice(0, 8)}`,
      }]));
      send(bot, chatId, text.slice(0, TG_LIMIT), { reply_markup: { inline_keyboard: keyboard } });
    }
  } catch (e) {
    send(bot, chatId, 'נפל: ' + String((e && e.message) || e));
  } finally {
    running.delete(chatId);
  }
}

function promptForQuestion(bot, chatId) {
  pendingAsks.set(chatId, true);
  bot.sendMessage(chatId, PROMPT_TEXT, { reply_markup: { force_reply: true, selective: true } });
}

function register(bot, isAuthorized) {
  // /ask stays accepted so muscle memory keeps working, but askhistory is the name.
  bot.onText(/^\/(?:askhistory|ask_history|ask)(?:\s+([\s\S]+))?$/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const chatId = msg.chat.id;
    const question = (match[1] || '').trim();
    if (question) {
      runAsk(bot, chatId, question);
    } else {
      promptForQuestion(bot, chatId);
    }
  });
}

function handleReply(msg, bot) {
  const chatId = msg.chat.id;
  if (!pendingAsks.has(chatId)) return false;
  if (!msg.reply_to_message || msg.reply_to_message.text !== PROMPT_TEXT) return false;
  pendingAsks.delete(chatId);
  const question = (msg.text || '').trim();
  if (question) runAsk(bot, chatId, question);
  return true;
}

// Resume a cited session in iTerm on the Mac, via the sessions-ui resume endpoint.
function handleCallback(bot, query) {
  const data = query.data;
  if (!data) return false;

  if (data === 'askhist:ask') {
    bot.answerCallbackQuery(query.id).catch(() => {});
    promptForQuestion(bot, query.message.chat.id);
    return true;
  }

  if (!data.startsWith('askres:')) return false;
  const shortId = data.slice(7);
  const chatId = query.message.chat.id;

  const lookup = http.get({ host: UI_HOST, port: UI_PORT, path: '/api/sessions' }, (res) => {
    let d = '';
    res.setEncoding('utf8');
    res.on('data', c => d += c);
    res.on('end', () => {
      let full = null;
      try { full = (JSON.parse(d).sessions || []).find(s => s.id.startsWith(shortId)); } catch {}
      if (!full) { bot.answerCallbackQuery(query.id, { text: 'הסשן לא נמצא' }); return; }
      const req = http.request({ host: UI_HOST, port: UI_PORT, path: `/api/resume/${full.id}`, method: 'POST' }, (r) => {
        r.resume();
        bot.answerCallbackQuery(query.id, { text: r.statusCode === 200 ? 'נפתח ב-iTerm' : 'נכשל' });
      });
      req.on('error', () => bot.answerCallbackQuery(query.id, { text: 'נכשל' }));
      req.end();
    });
  });
  lookup.on('error', () => bot.answerCallbackQuery(query.id, { text: 'שרת הסשנים לא זמין' }));
  return true;
}

module.exports = { register, handleReply, handleCallback };

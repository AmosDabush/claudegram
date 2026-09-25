/**
 * GaggiMate Commands
 * /gm, /gaggimate - espresso machine control panel
 *
 * Self-contained on purpose: no dependency on the gaggimate-remote repo (which is
 * Windows-only and ESM) and no new npm packages, so requiring this file can never
 * break the Mac. WebSocket control degrades to a message if Node is older than 22.
 */

const HOST = process.env.GAGGIMATE_HOST || '192.168.1.170';
const HAS_WS = typeof WebSocket !== 'undefined';

const MODES = ['Standby', 'Brew', 'Steam', 'Water', 'Grind'];
const MODE_ICONS = ['⏻', '☕', '💨', '💧', '⚙️'];
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = ['ב', 'ג', 'ד', 'ה', 'ו', 'ש', 'א'];

// One live temperature watcher per chat; starting a new one cancels the old.
const watchers = new Map();

// ---------------------------------------------------------------- transport

function http(path, options) {
  return fetch(`http://${HOST}${path}`, { signal: AbortSignal.timeout(8000), ...options });
}

async function getJson(path) {
  const res = await http(path);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

/**
 * Opens a socket, runs fn, closes it. Every control action is one short-lived
 * connection - a bot that holds a socket open for hours just accumulates
 * reconnect bugs, and the machine only allows a handful of clients.
 */
function withSocket(fn, { needStatus = false, timeout = 12000 } = {}) {
  if (!HAS_WS) return Promise.reject(new Error('needs Node 22 or newer (no global WebSocket)'));

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}/ws`);
    const status = {};
    let settled = false;
    let rid = 0;
    const pending = new Map();
    const waiters = [];

    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => done(new Error(`machine did not respond within ${timeout}ms`)), timeout);

    const api = {
      status,
      send: payload => ws.send(JSON.stringify(payload)),
      request(payload) {
        const id = `tg${++rid}`;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ ...payload, rid: id }));
        });
      },
      // res:ota-settings and friends are broadcast without an rid echo.
      waitFor: tp => new Promise(res => waiters.push({ tp, res })),
      onStatus: null,
    };

    ws.addEventListener('error', () => done(new Error(`cannot reach the machine at ${HOST}`)));
    ws.addEventListener('close', () => done(new Error('connection closed early')));

    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }

      if (msg.tp === 'evt:status') {
        // Frames are partial - only a frame carrying `ct` has fresh telemetry.
        Object.assign(status, msg);
        if (Object.prototype.hasOwnProperty.call(msg, 'ct')) {
          status._telemetry = true;
          if (api.onStatus) api.onStatus(status);
        }
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].tp === msg.tp) waiters.splice(i, 1)[0].res(msg);
      }
      const p = msg.rid && pending.get(msg.rid);
      if (p) {
        pending.delete(msg.rid);
        msg.error ? p.rej(new Error(msg.error)) : p.res(msg);
      }
    });

    ws.addEventListener('open', async () => {
      try {
        // Control messages are fire-and-forget, but anything that reads state must
        // wait for a real telemetry frame or it reads zeros.
        if (needStatus) {
          await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('no telemetry frame from the machine')), 10000);
            api.onStatus = () => { clearTimeout(t); api.onStatus = null; res(); };
          });
        }
        done(null, await fn(api));
      } catch (err) {
        done(err);
      }
    });
  });
}

// ------------------------------------------------------------------ helpers

// The rest of the bot uses legacy `Markdown`, which has no backslash escaping at all -
// a stray `_` or `*` in a profile name or a note makes Telegram reject the whole message.
// Stripping the four specials is the only safe option in that dialect. Everything else
// (dots, dashes, parentheses) is literal in legacy Markdown and needs no handling.
const esc = s => String(s == null ? '' : s).replace(/[_*[\]`]/g, '');
const n = (v, d = 1) => (typeof v === 'number' ? v.toFixed(d) : '—');

function tempBar(current, target, width = 12) {
  if (!target) return '';
  const pct = Math.max(0, Math.min(1, (current - 20) / (target - 20)));
  const filled = Math.round(pct * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${Math.round(pct * 100)}%`;
}

// A resend counter that climbs while the machine is idle means the display↔controller
// link is degraded, and any shot pulled in that state is void.
function linkLabel(status) {
  const lat = status.lat ?? 0;
  if (!lat) return '🔗 —';
  if (lat > 500) return `🔴 link ${lat}ms`;
  if (lat > 350) return `🟡 link ${lat}ms`;
  return `🟢 link ${lat}ms`;
}

function panelText(status, extra = '') {
  const mode = status.m ?? 0;
  const ct = status.ct ?? 0;
  const tt = status.tt ?? 0;
  const lines = [
    `☕ *GaggiMate*  ·  ${MODE_ICONS[mode]} _${MODES[mode]}_`,
    '',
    mode === 0
      ? `🌡 ${n(ct)}°C  ·  _cooling down_`
      : `🌡 ${n(ct)} → ${n(tt)}°C\n\`${tempBar(ct, tt)}\``,
    `🎯 ${esc(status.p) || '—'}`,
    `${linkLabel(status)}  ·  resends ${status.rtx ?? '—'}`,
  ];
  if (status.bc) lines.push(`⚖️ scale ${n(status.cw ?? 0)} g${status.sbat != null ? `  (${status.sbat}%)` : ''}`);
  if (extra) lines.push('', extra);
  return lines.join('\n');
}

function panelKeyboard(status) {
  const mode = status.m ?? 0;
  const btn = (i) => ({
    text: `${MODE_ICONS[i]} ${MODES[i]}${mode === i ? ' ✓' : ''}`,
    callback_data: `gag:mode:${i}`,
  });
  return [
    [btn(1), btn(2), btn(3)],
    [btn(4), btn(0)],
    [
      { text: '🔄 Refresh', callback_data: 'gag:home' },
      { text: '📈 Watch temp', callback_data: 'gag:watch' },
    ],
    [
      { text: '🎯 Profiles', callback_data: 'gag:profiles' },
      { text: '⏰ Wake-up', callback_data: 'gag:sched' },
    ],
    [
      { text: '🚿 Flush', callback_data: 'gag:flush' },
      { text: '🩺 Link health', callback_data: 'gag:health' },
    ],
    [
      { text: '📊 Last shot', callback_data: 'gag:shot' },
      { text: '📜 History', callback_data: 'gag:shots' },
    ],
    [{ text: '⬅️ Back to Menu', callback_data: 'all:back' }],
  ];
}

function draw(bot, query, text, keyboard) {
  return bot.editMessageText(text, {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
  }).catch(err => {
    // Telegram rejects an edit that would not change anything; that is not a failure.
    if (!/message is not modified/i.test(err.message || '')) throw err;
  });
}

const backRow = [{ text: '⬅️ GaggiMate', callback_data: 'gag:home' }];

// -------------------------------------------------------------------- views

async function showPanel(bot, query, extra = '') {
  const status = await withSocket(async api => api.status, { needStatus: true });
  return draw(bot, query, panelText(status, extra), panelKeyboard(status));
}

/**
 * Live heating view: edits the same message until the machine reaches target,
 * then stops on its own. Bounded at 5 minutes so a forgotten watcher cannot
 * edit a message forever.
 */
async function startWatch(bot, query) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  const existing = watchers.get(chatId);
  if (existing) existing.stop = true;

  const token = { stop: false };
  watchers.set(chatId, token);

  const deadline = Date.now() + 5 * 60 * 1000;
  let reached = false;

  while (!token.stop && Date.now() < deadline) {
    let status;
    try {
      status = await withSocket(async api => api.status, { needStatus: true });
    } catch (err) {
      await draw(bot, query, `⚠️ ${esc(err.message)}`, [backRow]);
      break;
    }
    if (token.stop) break;

    const ct = status.ct ?? 0;
    const tt = status.tt ?? 0;
    reached = tt > 0 && ct >= tt - 0.5;

    await draw(
      bot,
      query,
      panelText(status, reached ? '✅ *At temperature*' : '_updating every 5s…_'),
      [[{ text: '⏹ Stop watching', callback_data: 'gag:home' }], ...(reached ? [backRow] : [])],
    );

    if (reached || (status.m ?? 0) === 0) break;
    await new Promise(r => setTimeout(r, 5000));
  }

  if (watchers.get(chatId) === token) watchers.delete(chatId);
  if (reached && !token.stop) {
    bot.sendMessage(chatId, '☕ *Machine is up to temperature*', { parse_mode: 'Markdown' });
  }
  // A watcher that ended on its own leaves the panel stale; redraw it live.
  if (!token.stop) await showPanel(bot, { message: { chat: { id: chatId }, message_id: messageId } });
}

async function showProfiles(bot, query) {
  // `minimal: true` keeps the payload small but drops the `selected` flag, so the
  // active profile is identified from the status frame's `puid` instead.
  const { profiles, selectedId } = await withSocket(async api => {
    const res = await api.request({ tp: 'req:profiles:list', minimal: true });
    return { profiles: res.profiles, selectedId: api.status.puid };
  }, { needStatus: true });

  const list = profiles || [];
  const rows = list.map(p => [{
    text: `${p.id === selectedId || p.selected ? '✅' : '▫️'} ${(p.label || p.name || p.id).slice(0, 40)}`,
    callback_data: `gag:prof:${p.id}`,
  }]);
  return draw(
    bot,
    query,
    `🎯 *Profiles* (${list.length})\n\nTap one to make it active.`,
    [...rows, backRow],
  );
}

async function showSchedule(bot, query) {
  const s = await getJson('/api/settings');
  const schedules = String(s.autowakeupSchedules || '')
    .split(';')
    .map(x => x.split('|'))
    .filter(([t, d]) => /^\d{2}:\d{2}$/.test(t || '') && d?.length === 7);

  const body = schedules.length
    ? schedules
        .map(([time, days], i) => {
          const on = [...days].map((d, j) => (d === '1' ? DAY_LABELS[j] : '·')).join('');
          return `\`${i}\`  *${time}*  \`${on}\``;
        })
        .join('\n')
    : '_no schedules_';

  const rows = schedules.map(([time], i) => [{ text: `🗑 ${time}`, callback_data: `gag:schedrm:${i}` }]);

  return draw(
    bot,
    query,
    `⏰ *Auto wake-up*  ${s.autowakeupEnabled ? '🟢 on' : '🔴 off'}\n\n` +
      `${body}\n\n` +
      `Days read ב־ג־ד־ה־ו־ש־א\n` +
      `The machine wakes itself — the PC can be off.\n` +
      `_Schedules repeat weekly, so remove one when you are done with it._`,
    [
      [
        { text: '➕ 06:30 חול', callback_data: 'gag:schedadd:06:30:weekdays' },
        { text: '➕ 07:00 חול', callback_data: 'gag:schedadd:07:00:weekdays' },
      ],
      [
        { text: '➕ 07:30 חול', callback_data: 'gag:schedadd:07:30:weekdays' },
        { text: '➕ 08:00 כל יום', callback_data: 'gag:schedadd:08:00:daily' },
      ],
      ...rows,
      [{ text: s.autowakeupEnabled ? '🔴 Disable all' : '🟢 Enable', callback_data: 'gag:schedtoggle' }],
      backRow,
    ],
  );
}

// Only autowakeup* is posted: the firmware guards each field with hasArg(), so a
// partial body leaves everything else alone. Posting the whole blob would write
// back a stale copy of every other setting.
async function saveSchedules(enabled, schedules) {
  const body = new URLSearchParams();
  if (enabled !== undefined) body.set('autowakeupEnabled', enabled ? '1' : '0');
  if (schedules !== undefined) {
    body.set('autowakeupSchedules', schedules.map(([t, d]) => `${t}|${d}`).join(';'));
  }
  const res = await http('/api/settings', { method: 'POST', body });
  if (!res.ok) throw new Error(`POST /api/settings -> ${res.status}`);
}

function parseDaySpec(spec) {
  if (spec === 'daily') return '1111111';
  if (spec === 'weekdays') return '1111100'; // Monday-first; Israeli work week is Sun-Thu
  if (spec === 'workweek') return '1111001';
  return '1111111';
}

async function showHealth(bot, query) {
  await draw(bot, query, '🩺 _Sampling the link for 15 seconds…_', [backRow]);

  const first = await withSocket(async api => ({ rtx: api.status.rtx ?? 0, lat: api.status.lat ?? 0 }), { needStatus: true });
  await new Promise(r => setTimeout(r, 15000));
  const second = await withSocket(async api => ({ rtx: api.status.rtx ?? 0, lat: api.status.lat ?? 0, rssi: api.status.rssi ?? 0 }), { needStatus: true });

  const drift = second.rtx - first.rtx;
  const healthy = drift === 0 && second.lat < 400;

  return draw(
    bot,
    query,
    `🩺 *Link health*\n\n` +
      `resends  ${first.rtx} → ${second.rtx}  (+${drift} in 15s)\n` +
      `latency  ${second.lat} ms\n` +
      `signal   ${second.rssi} dB\n\n` +
      (healthy
        ? '🟢 *Healthy* — safe to pull a shot.'
        : '🔴 *Degraded* — power-cycle the machine and the scale.\nA shot pulled now is void: the profile commands arrive too late.'),
    [[{ text: '🔁 Re-test', callback_data: 'gag:health' }], backRow],
  );
}

// ---------------------------------------------------------------- shot history

const ENTRY_SIZE = 128;

function parseIndex(buf) {
  const view = new DataView(buf);
  if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== 'SIDX') throw new Error('bad index.bin');
  const count = view.getUint32(8, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = 32 + i * ENTRY_SIZE;
    if (view.getUint8(o + 15) & 2) continue; // deleted
    const name = new Uint8Array(buf, o + 48, 48);
    const end = name.indexOf(0);
    out.push({
      id: view.getUint32(o, true),
      timestamp: view.getUint32(o + 4, true),
      duration: view.getUint32(o + 8, true) / 1000,
      volume: view.getUint16(o + 12, true) / 10,
      avgTemp: view.getUint16(o + 96, true) / 10,
      maxPressure: view.getUint16(o + 98, true) / 10,
      avgFlow: view.getUint16(o + 100, true) / 100,
      profile: new TextDecoder().decode(name.subarray(0, end < 0 ? 48 : end)),
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

async function fetchIndex() {
  const res = await http('/api/history/index.bin');
  if (!res.ok) throw new Error(`GET index.bin -> ${res.status}`);
  return parseIndex(await res.arrayBuffer());
}

async function showShots(bot, query) {
  const all = await fetchIndex();
  const recent = all.slice(-8).reverse();
  const rows = recent.map(e => [{
    text: `#${e.id}  ${n(e.duration)}s  ${n(e.volume)}g  ${n(e.maxPressure)}bar`,
    callback_data: `gag:shot:${e.id}`,
  }]);
  return draw(bot, query, `📜 *Recent shots*\n\nTap one for the detail.`, [...rows, backRow]);
}

async function showShot(bot, query, wantedId) {
  const all = await fetchIndex();
  const e = wantedId ? all.find(x => x.id === Number(wantedId)) : all[all.length - 1];
  if (!e) return draw(bot, query, '_no shots recorded_', [backRow]);

  let notes = null;
  try {
    const res = await withSocket(api => api.request({ tp: 'req:history:notes:get', id: String(e.id) }));
    notes = res.notes;
  } catch { /* notes are optional - the shot summary still stands without them */ }

  const when = new Date(e.timestamp * 1000).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
  const ratio = notes?.doseIn ? ` (1:${(e.volume / notes.doseIn).toFixed(1)})` : '';

  let text =
    `📊 *Shot #${e.id}*  ·  ${esc(when)}\n\n` +
    `🎯 ${esc(e.profile)}\n` +
    `⏱ ${n(e.duration)} s\n` +
    `⚖️ ${n(e.volume)} g out${ratio}\n` +
    `📈 peak ${n(e.maxPressure)} bar  ·  flow ${n(e.avgFlow, 2)} ml/s\n` +
    `🌡 ${n(e.avgTemp)} °C`;

  if (notes) {
    const bits = [];
    if (notes.doseIn) bits.push(`dose ${notes.doseIn} g`);
    if (notes.grindSetting) bits.push(`grind ${notes.grindSetting}`);
    if (notes.beanType) bits.push(esc(notes.beanType));
    if (notes.rating) bits.push(`${'⭐'.repeat(Math.round(notes.rating))}`);
    if (bits.length) text += `\n\n📝 ${bits.join('  ·  ')}`;
    if (notes.notes) text += `\n\n\`${esc(notes.notes).slice(0, 500)}\``;
  }

  return draw(bot, query, text, [[{ text: '📜 All shots', callback_data: 'gag:shots' }], backRow]);
}

// ------------------------------------------------------------------ dispatch

async function route(bot, query) {
  const data = query.data;
  const chatId = query.message.chat.id;
  const ack = text => bot.answerCallbackQuery(query.id, { text });

  // Any navigation cancels a running temperature watcher.
  if (data !== 'gag:watch') {
    const w = watchers.get(chatId);
    if (w) w.stop = true;
  }

  if (data === 'gag:home') { await ack('☕ GaggiMate'); return showPanel(bot, query); }
  if (data === 'gag:watch') { await ack('📈 watching'); return startWatch(bot, query); }
  if (data === 'gag:profiles') { await ack('🎯 Profiles'); return showProfiles(bot, query); }
  if (data === 'gag:sched') { await ack('⏰ Wake-up'); return showSchedule(bot, query); }
  if (data === 'gag:health') { await ack('🩺 15s test'); return showHealth(bot, query); }
  if (data === 'gag:shots') { await ack('📜 History'); return showShots(bot, query); }

  if (data === 'gag:shot') { await ack('📊 Last shot'); return showShot(bot, query, null); }
  if (data.startsWith('gag:shot:')) { await ack('📊'); return showShot(bot, query, data.slice(9)); }

  if (data.startsWith('gag:mode:')) {
    const mode = Number(data.slice(9));
    await ack(`${MODE_ICONS[mode]} ${MODES[mode]}`);
    // change-mode is ignored unless the controller reports SYSTEM_READY, so confirm
    // from the machine's own status rather than assuming the send worked.
    await withSocket(async api => {
      api.send({ tp: 'req:change-mode', mode });
      await new Promise(r => setTimeout(r, 1500));
    }, { needStatus: true });
    return showPanel(bot, query);
  }

  if (data.startsWith('gag:prof:')) {
    const id = data.slice(9);
    await ack('🎯 selecting');
    await withSocket(api => api.request({ tp: 'req:profiles:select', id }));
    return showProfiles(bot, query);
  }

  // Flush runs the pump for real, so it asks first - there may be no cup under the group.
  if (data === 'gag:flush') {
    await ack('🚿 Flush');
    return draw(
      bot,
      query,
      '🚿 *Flush*\n\nThis runs water through the group head *now*.\nMake sure the portafilter and a cup are where you want them.',
      [[{ text: '✅ Run flush', callback_data: 'gag:flushgo' }], [{ text: '⏹ Stop a running flush', callback_data: 'gag:flushstop' }], backRow],
    );
  }
  if (data === 'gag:flushgo') {
    await ack('🚿 running');
    await withSocket(api => api.request({ tp: 'req:flush:start' }));
    return showPanel(bot, query, '🚿 _flush started_');
  }
  if (data === 'gag:flushstop') {
    await ack('⏹ stopping');
    await withSocket(async api => api.send({ tp: 'req:flush:stop' }));
    return showPanel(bot, query, '⏹ _flush stopped_');
  }

  if (data === 'gag:schedtoggle') {
    const s = await getJson('/api/settings');
    await saveSchedules(!s.autowakeupEnabled, undefined);
    await ack(s.autowakeupEnabled ? '🔴 off' : '🟢 on');
    return showSchedule(bot, query);
  }
  if (data.startsWith('gag:schedadd:')) {
    // gag:schedadd:HH:MM:spec - the time itself contains a colon, so split from the right.
    const parts = data.split(':');
    const spec = parts.pop();
    const time = `${parts[2]}:${parts[3]}`;
    const s = await getJson('/api/settings');
    const existing = String(s.autowakeupSchedules || '')
      .split(';')
      .map(x => x.split('|'))
      .filter(([t, d]) => /^\d{2}:\d{2}$/.test(t || '') && d?.length === 7 && t !== time);
    await saveSchedules(true, [...existing, [time, parseDaySpec(spec)]].sort((a, b) => a[0].localeCompare(b[0])));
    await ack(`➕ ${time}`);
    return showSchedule(bot, query);
  }
  if (data.startsWith('gag:schedrm:')) {
    const idx = Number(data.slice(12));
    const s = await getJson('/api/settings');
    const existing = String(s.autowakeupSchedules || '')
      .split(';')
      .map(x => x.split('|'))
      .filter(([t, d]) => /^\d{2}:\d{2}$/.test(t || '') && d?.length === 7);
    existing.splice(idx, 1);
    await saveSchedules(undefined, existing);
    await ack('🗑 removed');
    return showSchedule(bot, query);
  }

  return ack('?');
}

function handleCallback(bot, query) {
  if (!query.data || !query.data.startsWith('gag:')) return false;

  route(bot, query).catch(err => {
    const hint = HAS_WS ? '' : '\n\n_The bot needs Node 22 or newer for machine control._';
    bot.answerCallbackQuery(query.id, { text: '⚠️ ' + err.message.slice(0, 180) }).catch(() => {});
    draw(bot, query, `⚠️ *GaggiMate*\n\n\`${esc(err.message)}\`${hint}`, [
      [{ text: '🔁 Retry', callback_data: 'gag:home' }],
      [{ text: '⬅️ Back to Menu', callback_data: 'all:back' }],
    ]).catch(() => {});
  });

  return true;
}

function register(bot, isAuthorized) {
  bot.onText(/^\/(gm|gaggimate)$/, async (msg) => {
    if (!isAuthorized(msg)) return;
    const chatId = msg.chat.id;
    try {
      const status = await withSocket(async api => api.status, { needStatus: true });
      bot.sendMessage(chatId, panelText(status), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: panelKeyboard(status) },
      });
    } catch (err) {
      bot.sendMessage(chatId, `⚠️ GaggiMate at ${HOST}: ${err.message}`);
    }
  });
}

module.exports = { register, handleCallback, showPanel, panelText, panelKeyboard, HOST };

/**
 * /live — the microphone channel, on and off from the phone.
 *
 * Two things have to be up for the phone to stream audio to this machine, and neither
 * should be up when nobody is talking:
 *
 *   the tunnel     Tailscale, so a phone on a mobile network can reach a machine that
 *                  sits behind a home router with no address of its own
 *   the receiver   the WebSocket in lib/live, listening for that phone
 *
 * Both off by default, every start. A microphone endpoint that comes up with the bot is
 * a microphone endpoint that is open all day for the ten minutes a week it is used, and
 * a VPN that is always connected is a decision nobody made. Asking for it is one tap.
 *
 * ── Why this is a bot command and not a script ──────────────────────────────
 *
 * The thing that needs it is a phone, in a car. Anything that requires reaching the
 * machine to switch it on has the problem backwards: you would have to already be at
 * the desk you are trying to leave.
 *
 * ── What it deliberately will not do ────────────────────────────────────────
 *
 * Nothing here can take the bot down with it. The receiver is started inside a try, and
 * a failure to open the port, a missing token, a Tailscale that will not come up — each
 * one is a message in the chat and nothing more. The bot's day job is unaffected by a
 * feature that is off.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const live = require('../live');

/** Nothing is listening until somebody asks. Holds the handle from live.start(). */
let receiver = null;

/**
 * The tailscale command line.
 *
 * Not on PATH on either platform by default — Windows puts it under Program Files and
 * macOS hides it inside the app bundle — so looking for `tailscale` and giving up is
 * how this reports "not installed" on a machine where it is running fine.
 */
function tailscaleBin() {
  const configured = (process.env.TAILSCALE_BIN || '').trim();
  const candidates = configured ? [configured] : (process.platform === 'win32'
    ? ['C:\\Program Files\\Tailscale\\tailscale.exe',
       'C:\\Program Files (x86)\\Tailscale\\tailscale.exe']
    : ['/Applications/Tailscale.app/Contents/MacOS/Tailscale',
       '/usr/local/bin/tailscale',
       '/opt/homebrew/bin/tailscale']);
  return candidates.find(c => { try { return fs.statSync(c).isFile(); } catch (e) { return false; } }) || null;
}

function tailscale(args, timeout = 20000) {
  return new Promise((resolve) => {
    const bin = tailscaleBin();
    if (!bin) return resolve({ ok: false, out: 'Tailscale is not installed on this machine' });
    execFile(bin, args, { timeout, encoding: 'utf-8' }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      resolve({ ok: !err, out });
    });
  });
}

/**
 * Where the phone should point, as Tailscale sees this machine.
 *
 * `tailscale status --json` rather than reading an interface address: the address is
 * assigned by the tailnet and an interface can hold a stale one from a previous
 * session, which sends the phone somewhere that stopped existing.
 */
async function tunnelState() {
  const res = await tailscale(['status', '--json'], 8000);
  if (!res.ok) return { up: false, why: res.out.split('\n')[0] || 'tailscale did not answer' };
  let s;
  try { s = JSON.parse(res.out); } catch (e) { return { up: false, why: 'unreadable status' }; }

  const backend = s.BackendState || 'Unknown';
  if (backend !== 'Running') return { up: false, why: backend === 'NeedsLogin' ? 'not logged in' : backend };

  const self = s.Self || {};
  return {
    up: true,
    name: (self.DNSName || '').replace(/\.$/, ''),
    ip: (self.TailscaleIPs || []).find(a => a.includes('.')) || null
  };
}

function receiverUp() {
  return receiver !== null;
}

async function startReceiver() {
  if (receiver) return { ok: true, already: true };
  try {
    receiver = live.start({});
    const port = await receiver.listening;
    return { ok: true, port };
  } catch (e) {
    // The common one by far is a missing LIVE_TOKEN, and live.start says so in words.
    receiver = null;
    return { ok: false, why: e.message };
  }
}

async function stopReceiver() {
  if (!receiver) return false;
  const r = receiver;
  receiver = null;
  try { await r.close(); } catch (e) {}
  return true;
}

async function panel() {
  const tunnel = await tunnelState();
  const on = receiverUp();
  const port = process.env.LIVE_PORT || 8787;

  const lines = ['🎙 *Live audio*', ''];

  lines.push(on ? `Receiver: *listening on ${port}*` : 'Receiver: *off*');
  if (tunnel.up) lines.push(`Tunnel: *up* — \`${tunnel.name || tunnel.ip}\``);
  else lines.push(`Tunnel: *down*${tunnel.why ? ` — ${tunnel.why}` : ''}`);

  if (on && tunnel.up) {
    lines.push('', 'The phone wants:', `\`ws://${tunnel.name || tunnel.ip}:${port}/live\``);
  } else if (on && !tunnel.up) {
    lines.push('', '_Listening, but only reachable from this network until the tunnel is up._');
  } else {
    lines.push('', '_Nothing is listening. Off is the default every time the bot starts._');
  }

  const keyboard = [
    on ? [{ text: '⏹ Stop listening', callback_data: 'live:off' }]
       : [{ text: '▶️ Start listening', callback_data: 'live:on' }],
    tunnel.up ? [{ text: '🔌 Tunnel down', callback_data: 'live:tsdown' }]
              : [{ text: '🔒 Tunnel up', callback_data: 'live:tsup' }],
    [{ text: '🔄 Refresh', callback_data: 'live:show' }]
  ];

  return { text: lines.join('\n'), keyboard };
}

async function draw(bot, chatId, messageId = null) {
  const { text, keyboard } = await panel();
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  if (messageId) {
    return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts })
      .catch(() => {});
  }
  return bot.sendMessage(chatId, text, opts).catch(() => {});
}

function handleCallback(bot, query) {
  if (!query.data || !query.data.startsWith('live:')) return false;

  const action = query.data.slice('live:'.length);
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  (async () => {
    let note = '';
    switch (action) {
      case 'on': {
        const r = await startReceiver();
        note = r.ok ? (r.already ? 'Already listening' : `Listening on ${r.port}`)
                    : `Could not start: ${r.why}`.slice(0, 190);
        break;
      }
      case 'off':
        note = (await stopReceiver()) ? 'Stopped' : 'Was not running';
        break;
      case 'tsup': {
        const r = await tailscale(['up']);
        // A machine that has never logged in gets a URL back instead of a connection,
        // and that URL has to reach a human — swallowing it leaves a button that
        // silently does nothing for a reason nobody can see.
        const url = (r.out.match(/https:\/\/login\.tailscale\.com\/\S+/) || [])[0];
        if (url) {
          await bot.sendMessage(chatId, `Tailscale needs a login first:\n${url}`).catch(() => {});
          note = 'Login needed — see the message';
        } else {
          note = r.ok ? 'Tunnel up' : `Tunnel failed: ${r.out.split('\n')[0]}`.slice(0, 190);
        }
        break;
      }
      case 'tsdown': {
        const r = await tailscale(['down']);
        note = r.ok ? 'Tunnel down' : `Could not: ${r.out.split('\n')[0]}`.slice(0, 190);
        break;
      }
    }
    bot.answerCallbackQuery(query.id, { text: note || 'Done' }).catch(() => {});
    draw(bot, chatId, messageId);
  })().catch((e) => {
    bot.answerCallbackQuery(query.id, { text: `Error: ${e.message}`.slice(0, 190) }).catch(() => {});
  });

  return true;
}

function register(bot, isAuthorized) {
  bot.onText(/^\/live(?:\s+(on|off))?$/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const chatId = msg.chat.id;
    const arg = match && match[1];

    // Typed rather than tapped, which is what dictation produces. Same two actions.
    if (arg === 'on') {
      const r = await startReceiver();
      if (!r.ok) {
        bot.sendMessage(chatId, `⚠️ ${r.why}`).catch(() => {});
        return;
      }
    } else if (arg === 'off') {
      await stopReceiver();
    }

    draw(bot, chatId);
  });
}

// No shutdown hook on purpose. The restart script force-kills the process tree — which
// is correct, and documented where that decision was made — so a graceful handler would
// never run. The port goes when the process goes, which is the only guarantee worth
// having here, and an exported cleanup nobody calls is just a claim that it is handled.

module.exports = { register, handleCallback, receiverUp, tunnelState };

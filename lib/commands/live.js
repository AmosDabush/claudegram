/**
 * /live — the microphone channel, on and off from the phone.
 *
 * Two things have to be up for a phone on a mobile network to stream audio here:
 *
 *   the receiver   the WebSocket in lib/live, listening on this machine
 *   the tunnel     cloudflared, dialling out to Cloudflare and handing back a public
 *                  https address that forwards to it
 *
 * ── Why a tunnel and not a VPN ──────────────────────────────────────────────
 *
 * A mesh VPN was tried first and was the wrong shape, for a reason that has nothing to
 * do with how well it works: it needs an app installed and signed in on the phone as
 * well as here. Two installs and an account to send a sentence to a bot.
 *
 * A tunnel needs nothing on the phone. One binary dials out from this machine, and the
 * phone talks to an ordinary https address. Dialling out also means no inbound port, no
 * firewall rule and no router configuration — which is what makes this work from a
 * machine on somebody else's network as readily as from a desk at home.
 *
 * The address is different every time the tunnel starts, and that is deliberately not a
 * problem to solve. The bot prints it into the chat when it starts, which is where the
 * phone already is. A fixed address needs a domain on Cloudflare; this needs nothing.
 *
 * ── Off by default ──────────────────────────────────────────────────────────
 *
 * Both, every start. A microphone endpoint that comes up with the bot is open all day
 * for the ten minutes a week it is used. Asking for it is one tap, and the tap is on
 * the phone, which is the point: anything you have to reach the machine to switch on
 * has the problem backwards.
 *
 * Nothing here can take the bot down. The receiver starts inside a try, the tunnel is a
 * child process whose death is an event and not an exception, and each failure is a
 * line in the chat.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('../config');

const live = require('../live');
const stt = require('../stt');
const tidy = require('../tidy');
// Required lazily inside the handler would be tidier, but claude.js is already loaded
// by bot.js before this ever runs, so the cycle cannot bite.
const claude = require('./claude');

/** Nothing listens until somebody asks. The handle from live.start(). */
let receiver = null;
let receiverPort = null;

/**
 * Whether the channel was on when this process last ran, and for which conversation.
 *
 * Both the receiver and the tunnel are children of the bot, so a restart kills them —
 * and the bot restarts whenever anything about it changes, which tonight was eleven
 * times. Each one left a phone holding the address of a tunnel that no longer exists,
 * failing to connect, and being told nothing about why.
 *
 * So the switch survives the process. Turned on, it comes back on, and the new address
 * goes into the topic the way the first one did.
 */
const WANTED = path.join(DATA_DIR, 'live-wanted.json');

function remember(chatId) {
  try { fs.writeFileSync(WANTED, JSON.stringify({ chatId })); } catch (e) {}
}

function forget() {
  try { fs.unlinkSync(WANTED); } catch (e) {}
}

function wanted() {
  try { return JSON.parse(fs.readFileSync(WANTED, 'utf-8')); } catch (e) { return null; }
}

/**
 * Bring the channel back after a restart, if it was on before.
 *
 * Called once at startup. Quiet when it was off, which is the normal case, and says so
 * in the topic when it comes back — because the address has changed and the phone has
 * no other way to learn the new one.
 */
async function restore(bot) {
  const was = wanted();
  if (!was || !was.chatId) return;
  Diary('channel was on before the restart, bringing it back');
  const r = await turnOn(bot, was.chatId);
  if (r.ok) {
    draw(bot, was.chatId);
  } else {
    Diary(`could not restore: ${r.why}`);
    bot.sendMessage(was.chatId, `⚠️ Live audio did not come back up: ${r.why}`).catch(() => {});
  }
}

/** The cloudflared child, and the address it last handed back. */
let tunnel = null;
let tunnelUrl = null;

/**
 * The cloudflared binary.
 *
 * Downloaded next to the repo rather than installed, because it is one file with no
 * dependencies and an installed copy is a thing to keep up to date on two machines.
 * CLOUDFLARED_BIN overrides, for anyone who already has it on PATH.
 */
function cloudflaredBin() {
  const configured = (process.env.CLOUDFLARED_BIN || '').trim();
  const root = path.join(__dirname, '..', '..');
  const candidates = configured ? [configured] : [
    path.join(root, 'tools', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared'
  ];
  return candidates.find(c => { try { return fs.statSync(c).isFile(); } catch (e) { return false; } }) || null;
}

/**
 * A finished take: transcribe it, and put it in the conversation.
 *
 * This is the half that makes the whole thing worth doing. The phone sends sound and
 * learns nothing; the words are made here, by the model that is already resident, and
 * posted into the topic as an ordinary message — so Claude answers it the same way it
 * answers anything typed, and the answer comes back down the path that already works.
 *
 * Posted as the bot rather than as the person, because a bot is what this is. Marked,
 * so reading the topic later it is obvious which lines were spoken into a car and
 * which were typed.
 *
 * Nothing here may throw. It runs off a socket event with no caller to catch it, and
 * the cost of an unhandled rejection is the bot, not the sentence.
 */
function onTake(bot, chatId, take) {
  if (!bot || !chatId) return;

  // Under about a second is a press of the button, not a sentence. Transcribing it
  // produces whatever whisper invents out of room tone, which then gets sent to Claude
  // as if somebody had said it.
  if (!take.seconds || take.seconds < 1) {
    Diary(`live: take too short (${take.seconds}s), dropped`);
    return;
  }

  stt.transcribe(take.file, process.env.STT_LANG || 'he')
    .then((text) => {
      const said = (text || '').trim();
      if (!said) {
        Diary('live: nothing heard in the take');
        return;
      }
      Diary(`heard: "${said.slice(0, 60)}"`);

      // Through the tidier before it goes anywhere.
      //
      // The words are mostly right and everything around them is missing: no full
      // stops, no question marks, and a word that merely sounds like the right one
      // picked over the right one. That is what makes a transcript read as a machine
      // rather than a person, and it is the one job a language model is unambiguously
      // better at than a transcriber.
      //
      // Falls back to the raw text on any failure, so a slow or absent model costs
      // punctuation and never a sentence.
      return tidy.tidyAndRemember(said).then((clean) => {
        if (clean !== said) Diary(`tidied: "${clean.slice(0, 60)}"`);
        if (take.reply) take.reply({ t: 'final', text: clean });
      });

    })
    .catch((e) => {
      Diary(`live: transcription failed: ${e.message}`);
      bot.sendMessage(chatId, `⚠️ Could not transcribe: ${e.message}`.slice(0, 300)).catch(() => {});
    })
    .finally(() => {
      // Kept, for now.
      //
      // A healthy twenty-six second take — arriving at full speed, no gaps — came back
      // as four words, and deleting the evidence immediately afterwards is why there
      // was nothing to look at. A guess was made about why and it was wrong; the
      // recording is the only thing that can settle it.
      //
      // Set LIVE_KEEP=0 to go back to deleting them once this is understood.
      if (process.env.LIVE_KEEP === '0') {
        try { fs.unlinkSync(take.file); } catch (e) {}
      } else {
        Diary(`kept ${path.basename(take.file)} (${take.seconds}s) — LIVE_KEEP=0 to stop`);
      }
    });
}

const Diary = (m) => console.log(`[live] ${m}`);

/**
 * @param bot    where transcriptions are posted.
 * @param chatId which conversation they are posted into — the one /live was used in.
 */
async function startReceiver(bot, chatId) {
  if (receiver) return { ok: true, already: true, port: receiverPort };
  try {
    receiver = live.start({
      onTake: (take) => onTake(bot, chatId, take),
      // The words, while they are still being said. Without this the whole channel is
      // a voice note with extra steps: talk, stop, wait, read. Sending text back as it
      // firms up is the entire difference between dictating and recording.
      onPartial: (shot) => stt.transcribe(shot.file, process.env.STT_LANG || 'he')
    });
    receiverPort = await receiver.listening;
    // The channel is on, so something will be said shortly. Paying the first-exchange
    // cost now means the first real sentence does not pay it and come back raw.
    tidy.warm();
    return { ok: true, port: receiverPort };
  } catch (e) {
    receiver = null;
    receiverPort = null;
    return { ok: false, why: e.message };
  }
}

async function stopReceiver() {
  if (!receiver) return false;
  const r = receiver;
  receiver = null;
  receiverPort = null;
  try { await r.close(); } catch (e) {}
  return true;
}

/**
 * Bring up a quick tunnel and wait for the address it prints.
 *
 * cloudflared announces the address on stderr, several seconds after it starts, among a
 * dozen other lines. There is no flag that just prints it, so it is read out of the
 * stream — and the wait has to end either way, because a cloudflared that cannot reach
 * Cloudflare keeps running and keeps logging and simply never says a URL. Hanging on
 * that is a button that spins forever.
 */
function startTunnel(port) {
  return new Promise((resolve) => {
    if (tunnel) return resolve({ ok: true, already: true, url: tunnelUrl });

    const bin = cloudflaredBin();
    if (!bin) {
      return resolve({ ok: false, why: 'cloudflared is not installed — see tools/ in the README' });
    }

    const child = spawn(bin, [
      'tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'
    ], { windowsHide: true });

    tunnel = child;
    tunnelUrl = null;
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const watch = (buf) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString());
      if (m && !tunnelUrl) {
        tunnelUrl = m[0];
        done({ ok: true, url: tunnelUrl });
      }
    };

    child.stdout.on('data', watch);
    child.stderr.on('data', watch);

    child.on('error', (e) => {
      tunnel = null;
      done({ ok: false, why: `could not run cloudflared: ${e.message}` });
    });

    // A tunnel that dies later leaves a button claiming it is up. Clearing the handle
    // here means the next /live tells the truth instead of offering to take down
    // something that is already gone.
    child.on('exit', (code) => {
      if (tunnel === child) { tunnel = null; tunnelUrl = null; }
      done({ ok: false, why: `cloudflared exited (${code})` });
    });

    const timer = setTimeout(() => {
      done({ ok: false, why: 'cloudflared did not produce an address within 40s' });
    }, 40_000);
  });
}

function stopTunnel() {
  if (!tunnel) return false;
  const t = tunnel;
  tunnel = null;
  tunnelUrl = null;
  try { t.kill(); } catch (e) {}
  return true;
}

function panel() {
  const lines = ['🎙 *Live audio*', ''];

  lines.push(receiver ? `Receiver: *listening on ${receiverPort}*` : 'Receiver: *off*');
  lines.push(tunnelUrl ? 'Tunnel: *up*' : 'Tunnel: *down*');

  if (receiver && tunnelUrl) {
    // The address, for the app and not for the person.
    //
    // It was a tappable link for a while, which was the wrong idea twice over: opening
    // it shows a line of JSON that means nothing to a human, and nobody should be
    // copying an address between two of their own programs by hand. The phone is
    // already in this topic and already reads every message in it, so this line is how
    // it learns where to connect — marked so it can be found, and short enough to be
    // ignored by the only other reader.
    // With the token. The receiver refuses an upgrade without one — correctly, since
    // this address is on the public internet — and the address was printed without it,
    // so the phone connected, was refused, turned its own switch off and went back to
    // transcribing on the handset. From the phone that is indistinguishable from the
    // feature not existing; the only sign was one line in a log saying "bad token".
    //
    // Safe enough here: the topic is private, and the hostname in front of it is a
    // random name that expires when the tunnel stops.
    const token = encodeURIComponent((process.env.LIVE_TOKEN || '').trim());
    lines.push('', `\`LIVE ${tunnelUrl.replace('https://', 'wss://')}/live?token=${token}\``);
  } else if (receiver) {
    lines.push('', '_Listening, but only reachable from this machine until the tunnel is up._');
  } else {
    lines.push('', '_Off, which is what it is every time the bot starts._');
  }

  const keyboard = [
    receiver ? [{ text: '⏹ Stop listening', callback_data: 'live:off' }]
             : [{ text: '▶️ Start listening', callback_data: 'live:on' }],
    tunnelUrl ? [{ text: '🔌 Tunnel down', callback_data: 'live:tdown' }]
              : [{ text: '🌐 Tunnel up', callback_data: 'live:tup' }],
    [{ text: '🔄 Refresh', callback_data: 'live:show' }]
  ];

  return { text: lines.join('\n'), keyboard };
}

function draw(bot, chatId, messageId = null) {
  const { text, keyboard } = panel();
  const opts = {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard }
  };
  if (messageId) {
    return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts })
      .catch(() => {});
  }
  return bot.sendMessage(chatId, text, opts).catch(() => {});
}

/**
 * Everything, in one tap.
 *
 * Receiver then tunnel, in that order, because the tunnel is pointed at the port the
 * receiver ended up on. Asking for one and getting both is what "a switch" means — two
 * buttons that have to be pressed in the right order is a procedure.
 */
async function turnOn(bot, chatId) {
  const r = await startReceiver(bot, chatId);
  if (!r.ok) return { ok: false, why: r.why };
  const t = await startTunnel(r.port);
  if (!t.ok) return { ok: false, why: t.why, port: r.port };
  // Written only once both halves are up, so a restart does not keep retrying
  // something that has never worked.
  remember(chatId);
  return { ok: true, port: r.port, url: t.url };
}

async function turnOff() {
  forget();
  stopTunnel();
  await stopReceiver();
}

function handleCallback(bot, query) {
  if (!query.data || !query.data.startsWith('live:')) return false;

  const action = query.data.slice('live:'.length);
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  // Answered immediately. Bringing a tunnel up takes several seconds, and an
  // unanswered callback shows as a spinner that turns into an error on the phone.
  bot.answerCallbackQuery(query.id, { text: action === 'show' ? '' : 'Working...' }).catch(() => {});

  (async () => {
    switch (action) {
      case 'on': {
        const r = await turnOn(bot, chatId);
        if (!r.ok) await bot.sendMessage(chatId, `⚠️ ${r.why}`).catch(() => {});
        break;
      }
      case 'off':
        await turnOff();
        break;
      case 'tup': {
        if (!receiver) {
          await bot.sendMessage(chatId, '⚠️ Nothing to point it at — start the receiver first.')
            .catch(() => {});
          break;
        }
        const t = await startTunnel(receiverPort);
        if (!t.ok) await bot.sendMessage(chatId, `⚠️ ${t.why}`).catch(() => {});
        break;
      }
      case 'tdown':
        stopTunnel();
        break;
    }
    draw(bot, chatId, messageId);
  })().catch((e) => {
    bot.sendMessage(chatId, `⚠️ ${e.message}`).catch(() => {});
  });

  return true;
}

function register(bot, isAuthorized) {
  bot.onText(/^\/live(?:\s+(on|off))?$/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const chatId = msg.chat.id;
    const arg = match && match[1];

    if (arg === 'on') {
      const r = await turnOn(bot, chatId);
      if (!r.ok) {
        bot.sendMessage(chatId, `⚠️ ${r.why}`).catch(() => {});
        return;
      }
    } else if (arg === 'off') {
      await turnOff();
    }

    draw(bot, chatId);
  });
}

// No shutdown hook. The restart script force-kills the process tree, so a graceful
// handler would never run. cloudflared is a child of this process and goes with it.

module.exports = { register, handleCallback, restore, turnOn, turnOff, cloudflaredBin };

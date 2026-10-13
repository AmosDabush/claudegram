#!/usr/bin/env node
/**
 * QA for the live audio channel — stage A, the pipe and nothing else.
 *
 * Stands in for the phone. Generates a tone, streams it at the pace it would be spoken,
 * and checks that what landed on disk is what was sent.
 *
 * The point is that none of this needs a phone, an APK, or a drive. Every later stage of
 * the live work assumes audio can get here intact and on time; this is where that is
 * proved, on a laptop, in two seconds, as many times as it takes.
 *
 *   node scripts/qa-live.js
 *
 * For the real question — whether it works from a moving car — see --serve at the bottom.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CLAUDEGRAM_QA = '1';

const live = require('../lib/live');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
};

const TOKEN = 'qa-token-not-a-secret';

/** A second of 440 Hz, as the phone would send it: 16 kHz mono PCM16 little-endian. */
function tone(seconds) {
  const samples = live.RATE * seconds;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * (i / live.RATE)) * 8000), i * 2);
  }
  return buf;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('\nlive channel\n');

  const WebSocket = require('ws');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudegram-qa-live-'));
  const quiet = () => {};

  // Port 0 asks the OS for a free one, so a run cannot collide with a live receiver or
  // with a previous run that has not let go of its socket yet. Which port that turned
  // out to be is only knowable after it is bound.
  const server = live.start({ port: 0, token: TOKEN, dir, log: quiet });
  const actualPort = await server.listening;
  ok('the OS gave it a port of its own, not the live one', actualPort > 0 && actualPort !== 8787,
    String(actualPort));

  const url = (tok) => `ws://127.0.0.1:${actualPort}/live?token=${tok}&chat=-100123:7`;

  // ── the secret is actually required ─────────────────────────────────────────
  // This endpoint is meant to be reachable from outside the house. Getting this wrong
  // publishes a microphone, so it is the first thing checked rather than the last.
  const refused = await new Promise((resolve) => {
    const c = new WebSocket(url('wrong-token'));
    c.on('open', () => { c.close(); resolve(false); });
    c.on('error', () => resolve(true));
    c.on('unexpected-response', () => resolve(true));
  });
  ok('a wrong token is refused', refused === true);

  // ── a take arrives intact ───────────────────────────────────────────────────
  const audio = tone(2);
  const taken = [];

  const client = new WebSocket(url(TOKEN));
  const ready = await new Promise((resolve) => {
    client.on('message', (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.t === 'ready') resolve(msg);
      if (msg.t === 'take') taken.push(msg);
      if (msg.t === 'pong') taken.push(msg);
    });
    client.on('error', () => resolve(null));
  });

  ok('the server announces the format it wants', ready &&
    ready.rate === 16000 && ready.channels === 1 && ready.bits === 16,
    JSON.stringify(ready));

  client.send(JSON.stringify({ t: 'start' }));

  // Sent in 100 ms slices at the pace they would be spoken, rather than all at once. A
  // dump through a loopback proves the socket works and says nothing about whether a
  // stream keeps up, which is the only thing stage A is trying to find out.
  const sliceBytes = live.BYTES_PER_SECOND / 10;
  for (let at = 0; at < audio.length; at += sliceBytes) {
    client.send(audio.subarray(at, Math.min(at + sliceBytes, audio.length)));
    await sleep(100);
  }

  client.send(JSON.stringify({ t: 'end' }));
  await sleep(300);

  const take = taken.find(t => t.t === 'take');
  ok('the take comes back with its length', take && Math.abs(take.seconds - 2) < 0.15,
    JSON.stringify(take));

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.wav'));
  ok('a wav was written', files.length === 1, files.join(', '));

  if (files.length === 1) {
    const written = fs.readFileSync(path.join(dir, files[0]));
    ok('it is a wav, not a pile of bytes',
      written.toString('ascii', 0, 4) === 'RIFF' && written.toString('ascii', 8, 12) === 'WAVE');
    ok('the header knows how long it is',
      written.readUInt32LE(40) === audio.length,
      `header says ${written.readUInt32LE(40)}, sent ${audio.length}`);
    ok('the samples are the ones that were sent',
      written.subarray(44).equals(audio),
      `${written.length - 44} bytes on disk against ${audio.length} sent`);
  }

  // ── the round trip is measurable from the phone's own clock ─────────────────
  const at = Date.now();
  client.send(JSON.stringify({ t: 'ping', at }));
  await sleep(200);
  const pong = taken.find(t => t.t === 'pong');
  ok('ping comes back with the clock it left with', pong && pong.at === at);

  // ── a stream that dies mid-sentence still leaves a playable file ────────────
  // The case that matters on a motorway: the connection goes, and whatever was said up
  // to that point has to survive. A file that only becomes valid when it is closed
  // properly is a file lost exactly when it is wanted.
  const dropper = new WebSocket(url(TOKEN));
  await new Promise(r => dropper.on('open', r));
  dropper.send(JSON.stringify({ t: 'start' }));
  dropper.send(tone(1));
  await sleep(150);
  dropper.terminate();
  await sleep(300);

  const after = fs.readdirSync(dir).filter(f => f.endsWith('.wav'));
  const dropped = after.filter(f => !files.includes(f));
  ok('a dropped connection still leaves its audio', dropped.length === 1, after.join(', '));
  if (dropped.length === 1) {
    const w = fs.readFileSync(path.join(dir, dropped[0]));
    ok('and that file is complete and playable',
      w.toString('ascii', 0, 4) === 'RIFF' && w.readUInt32LE(40) === w.length - 44,
      `header ${w.readUInt32LE(40)}, body ${w.length - 44}`);
  }

  client.close();
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

/**
 * The other half of stage A, which no test can answer: does this work from a car.
 *
 *   LIVE_TOKEN=<secret> node scripts/qa-live.js --serve
 *
 * Runs the real receiver and leaves it up. Point the phone at it, drive somewhere, talk.
 * What matters in the log is the ratio and the gaps, not that it connected: below 1.0
 * means the audio arrived slower than it was spoken, and a single four second gap on a
 * motorway matters more than a good average.
 */
if (process.argv.includes('--serve')) {
  const server = live.start({});
  console.log(`\nup. health check: http://<this machine>:${server.port}/health`);
  console.log('ctrl-c to stop.\n');
} else {
  main();
}

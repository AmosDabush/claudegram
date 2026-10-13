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

/**
 * Which of the two things this file is, decided before anything is loaded.
 *
 * lib/config reads CLAUDEGRAM_QA once, when it is first required, and lib/live requires
 * it. So the choice between the real data directory and the throwaway one is made at
 * import time and cannot be taken back afterwards — setting the flag at the top and
 * clearing it further down looked right and did nothing, and the real receiver quietly
 * wrote its recordings into data-qa, which is a directory that exists to be deleted.
 *
 * Serving reads the real .env; testing must not, or a run picks up the live token and
 * port and collides with the receiver it is supposed to be testing.
 */
const SERVING = process.argv.includes('--serve');

if (SERVING) require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
else process.env.CLAUDEGRAM_QA = '1';

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

  // ── words come back while the sentence is still going ──────────────────────
  //
  // The whole point of the channel, and it was broken from the moment it was written:
  // the take was opened write-only, so every attempt to read it back for transcription
  // answered EBADF. It failed every two seconds for a whole conversation, the field on
  // the phone stayed empty, and the only evidence was a log line nobody was watching.
  // Nothing here tests whisper — only that audio in flight can be read back and that
  // what comes of it reaches the socket.
  const heard = [];
  const partialServer = live.start({
    port: 0, token: TOKEN, dir, log: quiet,
    partialMs: 150,
    onPartial: (shot) => {
      // Stands in for transcription. Proves the snapshot is a real, readable wav of
      // what has arrived so far, which is the part that was broken.
      const bytes = fs.statSync(shot.file).size;
      const header = fs.readFileSync(shot.file).toString('ascii', 0, 4);
      return `${header}:${bytes}`;
    }
  });
  const partialPort = await partialServer.listening;

  const talker = new WebSocket(`ws://127.0.0.1:${partialPort}/live?token=${TOKEN}`);
  const partials = [];
  talker.on('message', (m) => {
    const o = JSON.parse(m.toString());
    if (o.t === 'partial') partials.push(o.text);
  });
  await new Promise(r => talker.on('open', r));
  talker.send(JSON.stringify({ t: 'start' }));
  for (let i = 0; i < 6; i++) {
    talker.send(tone(1));
    await sleep(120);
  }
  await sleep(400);
  talker.send(JSON.stringify({ t: 'end' }));
  await sleep(200);

  ok('partial text comes back mid-sentence', partials.length > 0, `${partials.length} partials`);
  ok('the snapshot is a readable wav of what has arrived',
    partials.every(p => p.startsWith('RIFF:')), partials.join(' | ').slice(0, 80));
  ok('and it grows as more is said',
    partials.length < 2 || Number(partials[partials.length - 1].split(':')[1]) >
                           Number(partials[0].split(':')[1]),
    partials.join(' | ').slice(0, 80));
  // The one that mattered most and was invisible: reading the take back to transcribe
  // it moved the file pointer the next chunk was written at, so audio landed on top of
  // audio. Twenty-six seconds of speech came out as four words, which reads as a bad
  // model rather than a broken file. Every earlier check here sent its audio in one go
  // with no snapshots in between, so none of them could see it.
  const finalTake = fs.readdirSync(dir)
    .filter(f => f.endsWith('.wav') && !f.endsWith('.part.wav'))
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  if (finalTake) {
    const w = fs.readFileSync(path.join(dir, finalTake.f));
    const expected = 6 * live.BYTES_PER_SECOND;
    ok('snapshots do not eat the recording they are taken from',
      w.length - 44 === expected && w.readUInt32LE(40) === expected,
      `${w.length - 44} bytes kept of ${expected} sent, header says ${w.readUInt32LE(40)}`);
    // Not merely the right length: the right samples. A pointer landing back at the
    // start would give a file of exactly the right size full of the wrong audio.
    ok('and the samples survive intact', w.subarray(44).equals(tone(6)));
  }

  ok('no stubs left behind',
    fs.readdirSync(dir).filter(f => f.endsWith('.part.wav')).length === 0,
    fs.readdirSync(dir).join(', '));

  talker.close();
  await partialServer.close();

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
  // Taken here rather than reused from earlier in the run: everything between then and
  // now also wrote takes into this directory, and comparing against a list from the top
  // of the file makes this fail for bookkeeping reasons rather than real ones.
  const before = fs.readdirSync(dir).filter(f => f.endsWith('.wav'));

  const dropper = new WebSocket(url(TOKEN));
  await new Promise(r => dropper.on('open', r));
  dropper.send(JSON.stringify({ t: 'start' }));
  dropper.send(tone(1));
  await sleep(150);
  dropper.terminate();
  await sleep(300);

  const after = fs.readdirSync(dir).filter(f => f.endsWith('.wav'));
  const dropped = after.filter(f => !before.includes(f));
  ok('a dropped connection still leaves its audio', dropped.length === 1, after.join(', '));
  if (dropped.length === 1) {
    const w = fs.readFileSync(path.join(dir, dropped[0]));
    ok('and that file is complete and playable',
      w.toString('ascii', 0, 4) === 'RIFF' && w.readUInt32LE(40) === w.length - 44,
      `header ${w.readUInt32LE(40)}, body ${w.length - 44}`);
  }

  // ── a port that is already taken must not end the process ──────────────────
  // EADDRINUSE does not throw out of start(); it arrives as an 'error' event, and an
  // 'error' event nobody is listening for does not get logged, it kills the process.
  // That is the bot going down because somebody pressed the button twice, so the test
  // is "did this survive at all", and reaching the next line is the assertion.
  let refusedPort = null;
  try {
    const clash = live.start({ port: actualPort, token: TOKEN, dir, log: quiet });
    await clash.listening;
    await clash.close();
  } catch (e) {
    refusedPort = e.message;
  }
  ok('a port already in use is a rejection, not a dead process',
    refusedPort !== null && /already in use/.test(refusedPort), String(refusedPort));

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
if (SERVING) {
  const server = live.start({});
  server.listening.then((port) => {
    console.log(`\nup on ${port}. health check: http://<this machine>:${port}/health`);
    console.log('ctrl-c to stop.\n');
  });
} else {
  main();
}

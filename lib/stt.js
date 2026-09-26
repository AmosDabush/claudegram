/**
 * Speech to text for incoming voice notes.
 *
 * The point of this is the car. Dictating into the text field still ends with finding
 * and tapping Send; holding the mic button and letting go does not. So a voice note has
 * to be worth exactly as much as a typed message — same routing, same settings parser,
 * same session.
 *
 * Transcription runs locally. Nothing leaves the machine, no key, no quota, no round
 * trip to a coast. It takes whatever hardware it finds — the worker prefers a CUDA card
 * and falls back to the CPU, so the same code serves a Windows box with a GPU and a Mac
 * without one; only the model size is worth tuning per host.
 *
 * The cost is a process that has to stay alive to be fast (see the worker script), so
 * this module owns exactly one of those: started on first use, shared by every chat and
 * topic, and dropped after a long idle so a machine that is also used for other things
 * gets its memory back.
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const platform = require('./platform');

// "python" is the Windows launcher's name for it; on macOS that is often Python 2 or
// nothing at all, and the one people actually install packages into is python3.
const PY = process.env.STT_PYTHON || (platform.IS_WIN ? 'python' : 'python3');
const WORKER = path.join(__dirname, '..', 'scripts', 'stt_worker.py');
const IDLE_MS = parseInt(process.env.STT_IDLE_MINUTES || '20', 10) * 60 * 1000;

let proc = null;
let ready = null;          // promise resolved once the model reports in
let info = null;           // { device, model }
let idleTimer = null;
let seq = 0;
const waiting = new Map();

function shutdown(reason) {
  if (!proc) return;
  console.log(`[STT] stopping worker (${reason})`);
  try { proc.stdin.end(); } catch (e) {}
  try { proc.kill(); } catch (e) {}
  proc = null;
  ready = null;
  info = null;
  for (const [, w] of waiting) w.reject(new Error('worker stopped'));
  waiting.clear();
}

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  if (!IDLE_MS) return;
  idleTimer = setTimeout(() => shutdown('idle'), IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

function start() {
  if (ready) return ready;

  ready = new Promise((resolve, reject) => {
    console.log('[STT] starting worker...');
    proc = spawn(PY, [WORKER], {
      cwd: path.join(__dirname, '..'),
      // Line-buffered JSON both ways; Python would otherwise block its own pipe.
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
    });

    proc.on('error', (e) => {
      shutdown(`spawn failed: ${e.message}`);
      reject(e);
    });

    proc.on('exit', (code) => {
      const was = proc;
      shutdown(`worker exited with ${code}`);
      if (was) reject(new Error(`stt worker exited (${code})`));
    });

    // The worker writes progress to stderr; only surface it when something breaks.
    proc.stderr.on('data', d => {
      const s = d.toString().trim();
      if (s && /error|traceback|fatal/i.test(s)) console.log(`[STT] ${s.slice(0, 300)}`);
    });

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (e) { return; }

      if (msg.fatal) {
        const err = new Error(msg.fatal);
        shutdown('fatal');
        reject(err);
        return;
      }
      if (msg.ready) {
        info = { device: msg.device, model: msg.model };
        console.log(`[STT] ready — ${msg.model} on ${msg.device}`);
        resolve(info);
        return;
      }
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error));
      else w.resolve(msg.text || '');
    });
  });

  return ready;
}

/** Transcribe an audio file. Resolves to the text, which may legitimately be empty. */
async function transcribe(file, lang) {
  await start();
  touch();

  const id = `j${++seq}`;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    // Nothing here should hang a chat forever; a minute is far beyond any real clip.
    const t = setTimeout(() => {
      if (waiting.delete(id)) reject(new Error('transcription timed out'));
    }, 120000);
    if (t.unref) t.unref();

    try {
      proc.stdin.write(JSON.stringify({ id, path: file, lang }) + '\n');
    } catch (e) {
      waiting.delete(id);
      reject(e);
    }
  });
}

/** Bring the model up before anyone needs it, so the first voice note is fast too. */
function preload() {
  start().catch(e => console.log(`[STT] preload failed: ${e.message}`));
}

const status = () => (info ? { running: true, ...info } : { running: false });

/**
 * What is actually installed on this host.
 *
 * This feature is the only part of the bot with dependencies outside npm, and it ships
 * switched off for exactly that reason: somebody installing the bot to talk to Claude
 * from their phone should not be made to fetch a python package and a gigabyte of model
 * weights they never asked for. So nothing is assumed — when a user turns it on, we look
 * first and tell them precisely what is missing, rather than letting them find out from
 * a failed transcription later.
 */
function checkDeps() {
  const { execFileSync } = require('child_process');
  const probe = (file, args) => {
    try {
      execFileSync(file, args, { stdio: 'pipe', timeout: 20000 });
      return true;
    } catch (e) {
      return false;
    }
  };

  const python = probe(PY, ['-c', 'import sys']);
  return {
    python,
    pythonBin: PY,
    whisper: python && probe(PY, ['-c', 'import faster_whisper']),
    ffmpeg: probe('ffmpeg', ['-version'])
  };
}

/** Human-readable list of what is missing, empty when the host is ready. */
function missing() {
  const d = checkDeps();
  const out = [];
  if (!d.python) out.push(`python (\`${d.pythonBin}\` לא נמצא)`);
  else if (!d.whisper) out.push('`pip install faster-whisper`');
  if (!d.ffmpeg) out.push('ffmpeg');
  return out;
}

module.exports = { transcribe, preload, shutdown, status, checkDeps, missing };

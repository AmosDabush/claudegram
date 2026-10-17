/**
 * The live audio channel: the phone's microphone, arriving here as it is spoken.
 *
 * Why this exists at all. Dictation on the phone has always been the phone's problem —
 * Android's recogniser, a chain of short sessions stitched together, a magic word to say
 * when a sentence ended. It works, and it is the thing that keeps losing sentences,
 * mishearing instructions and refusing to punctuate. Meanwhile this machine has a real
 * model resident in memory and a graphics card to run it on.
 *
 * So the phone stops deciding what was said. It captures and streams; everything that
 * needs a model happens here.
 *
 * Deliberately NOT Telegram. Telegram moves messages, and a voice note is send-then-wait
 * — the shape being replaced. The two ends are both Amos's machines, so they can talk
 * directly and let Telegram keep doing what it is good at: the history and the UI.
 *
 * ── What this file does today ────────────────────────────────────────────────
 *
 * Stage A, and only stage A: accept a stream, write it to a WAV, and report what the
 * link actually did. No transcription, nothing posted to Telegram, no turn detection.
 *
 * That is the whole point of doing it first. Every later stage assumes audio can get
 * from a moving car to this machine at a usable rate, and that assumption is worth more
 * than any of the clever parts. If it fails on the motorway, it fails here, cheaply,
 * before a line of it is built on.
 *
 * ── The wire ─────────────────────────────────────────────────────────────────
 *
 *   connect   ws://host:port/live?token=<LIVE_TOKEN>&chat=<chatKey>
 *   binary    raw PCM, 16 kHz, mono, signed 16-bit little-endian
 *   text      JSON control: {"t":"start"} {"t":"end"} {"t":"ping"}
 *   server    JSON back: {"t":"ready"} {"t":"stats",...} {"t":"closed",...}
 *
 * 16 kHz mono PCM16 is 32 KB a second, a quarter of a megabit. Chosen because it is what
 * Whisper wants and what the phone already captures for echo cancellation, so nothing is
 * resampled at either end. It is also more than a conversation needs: most of a dictation
 * is silence, and stage C stops sending it.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { DATA_DIR } = require('./config');

/** 16 kHz mono PCM16 — Whisper's native input, and what the phone already captures. */
const RATE = 16_000;
const CHANNELS = 1;
const BITS = 16;
const BYTES_PER_SECOND = RATE * CHANNELS * (BITS / 8);

/**
 * A 44-byte canonical WAV header.
 *
 * Written twice: once up front with a zero length, so a file exists from the first frame
 * and a stream that dies mid-sentence still leaves something playable, and once at close
 * with the real length patched in. A recording that only becomes a file when it ends is
 * a recording you lose every time the thing you are debugging goes wrong.
 */
function wavHeader(dataBytes) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);            // PCM chunk size
  b.writeUInt16LE(1, 20);             // format: PCM
  b.writeUInt16LE(CHANNELS, 22);
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(BYTES_PER_SECOND, 28);
  b.writeUInt16LE(CHANNELS * BITS / 8, 32);
  b.writeUInt16LE(BITS, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

/**
 * What the link did, as opposed to what it was asked to do.
 *
 * Audio is produced at a fixed rate, so the gap between how much arrived and how long it
 * took to arrive is the whole diagnosis. Keeping up means seconds-of-audio tracks
 * wall-clock. Falling behind means the car's connection cannot carry it, and no amount of
 * work further up the pipeline will fix that.
 *
 * Gaps are counted separately because an average hides them. A link that stalls for two
 * seconds once a minute and is perfect otherwise averages fine and is unusable.
 */
class LinkStats {
  constructor(now) {
    this.openedAt = now;
    this.bytes = 0;
    this.frames = 0;
    this.lastFrameAt = now;
    this.longestGapMs = 0;
    this.gapsOver500ms = 0;
  }

  frame(size, now) {
    const gap = now - this.lastFrameAt;
    // Not counted against the first frame: the time before it is connection setup and
    // the user not having started talking, neither of which is a stall.
    if (this.frames > 0) {
      if (gap > this.longestGapMs) this.longestGapMs = gap;
      if (gap > 500) this.gapsOver500ms++;
    }
    this.lastFrameAt = now;
    this.frames++;
    this.bytes += size;
  }

  summary(now) {
    const wallMs = now - this.openedAt;
    const audioMs = Math.round((this.bytes / BYTES_PER_SECOND) * 1000);
    return {
      audioSeconds: +(audioMs / 1000).toFixed(2),
      wallSeconds: +(wallMs / 1000).toFixed(2),
      // Below 1.0 means audio arrived slower than it was spoken, which is the number
      // that decides whether any of this is viable from a moving car.
      realtimeRatio: wallMs > 0 ? +(audioMs / wallMs).toFixed(3) : 0,
      kbPerSecond: wallMs > 0 ? +((this.bytes / 1024) / (wallMs / 1000)).toFixed(1) : 0,
      frames: this.frames,
      longestGapMs: this.longestGapMs,
      gapsOver500ms: this.gapsOver500ms
    };
  }
}

/**
 * One phone, for as long as it is connected.
 *
 * A take is the audio between a start and an end. One connection can carry many —
 * reconnecting for every sentence would put a TCP and TLS handshake in front of every
 * thing the user says, which is latency paid for nothing.
 */
class Session {
  constructor(id, chat, dir, log) {
    this.id = id;
    this.chat = chat;
    this.dir = dir;
    this.log = log;
    this.stats = new LinkStats(Date.now());
    this.take = null;
  }

  startTake(now = Date.now()) {
    this.endTake(now);
    const file = path.join(this.dir, `${this.id}-${this.takeCount()}.wav`);
    // 'w+', not 'w'. The take is read back while it is still being written — that is
    // what produces the words on the phone before the sentence ends — and a descriptor
    // opened write-only answers every one of those reads with EBADF. Which it did,
    // every two seconds, for an entire conversation, while the field stayed empty and
    // nothing said why.
    const fd = fs.openSync(file, 'w+');
    fs.writeSync(fd, wavHeader(0));
    this.take = { file, fd, bytes: 0, startedAt: now };
    this.log(`take open: ${path.basename(file)}`);
  }

  takeCount() {
    return (this._takes = (this._takes || 0) + 1);
  }

  write(chunk, now = Date.now()) {
    this.stats.frame(chunk.length, now);
    // Audio before anyone said "start" is still audio, and losing it because of a missing
    // control frame is the kind of bug that looks like a broken microphone.
    if (!this.take) this.startTake(now);
    // At an explicit offset, never at "wherever the pointer happens to be".
    //
    // The same descriptor is read from, every couple of seconds, to transcribe what has
    // arrived so far. A positional read and a positionless write share one file pointer,
    // so each snapshot moved the place the next chunk landed and audio was written back
    // over audio. A twenty-six second recording came out as four words, which reads as a
    // bad model and is actually a corrupted file.
    fs.writeSync(this.take.fd, chunk, 0, chunk.length, 44 + this.take.bytes);
    this.take.bytes += chunk.length;
  }

  /**
   * A playable copy of everything heard so far, without disturbing the take.
   *
   * This is what makes the words appear while somebody is still talking rather than
   * after they stop. The first version had no such thing: audio accumulated, the
   * speaker finished, and only then did any of it become text — which is a voice note
   * with extra steps, and precisely the shape this was built to replace.
   *
   * A copy rather than the file itself, because the real one is open for writing with
   * a length of zero in its header until it closes. Handing that to a decoder gets
   * either nothing or a race.
   */
  snapshot() {
    const t = this.take;
    if (!t || t.bytes < BYTES_PER_SECOND) return null;
    const out = `${t.file}.part.wav`;
    try {
      // A descriptor of its own, opened read-only and closed again, rather than
      // borrowing the one being written to. Two users of one file pointer is what
      // corrupted the recording; separate descriptors have separate positions and
      // cannot interfere however the platform handles them.
      const rfd = fs.openSync(t.file, 'r');
      const body = Buffer.alloc(t.bytes);
      try {
        fs.readSync(rfd, body, 0, t.bytes, 44);
      } finally {
        fs.closeSync(rfd);
      }
      const fd = fs.openSync(out, 'w');
      fs.writeSync(fd, wavHeader(t.bytes));
      fs.writeSync(fd, body);
      fs.closeSync(fd);
      return { file: out, bytes: t.bytes };
    } catch (e) {
      this.log(`snapshot failed: ${e.message}`);
      // The header was already written before the failure, so without this a failing
      // snapshot leaves a 44-byte stub behind every two seconds.
      try { fs.unlinkSync(out); } catch (ignored) {}
      return null;
    }
  }

  endTake(now = Date.now()) {
    const t = this.take;
    if (!t) return null;
    this.take = null;
    try {
      // The length, now that it is known, written over the placeholder at offset zero.
      fs.writeSync(t.fd, wavHeader(t.bytes), 0, 44, 0);
      fs.fsyncSync(t.fd);
      fs.closeSync(t.fd);
    } catch (e) {
      this.log(`could not close take: ${e.message}`);
      return null;
    }
    const seconds = +(t.bytes / BYTES_PER_SECOND).toFixed(2);
    this.log(`take done: ${path.basename(t.file)}, ${seconds}s, held ${now - t.startedAt}ms`);
    return { file: t.file, seconds, bytes: t.bytes };
  }
}

/**
 * Start listening for phones.
 *
 * @param opts.port   TCP port. Default LIVE_PORT, or 8787.
 * @param opts.token  Shared secret. Default LIVE_TOKEN. Refuses to start without one.
 * @param opts.dir    Where takes are written. Default <data>/live.
 * @param opts.onTake Called with each finished take. Stage B hangs transcription here.
 * @param opts.log    Where to say things. Default console.log with a prefix.
 */
function start(opts = {}) {
  const WebSocket = require('ws');

  // `??`, not `||`. Port 0 means "any free port the OS likes", which a test needs so a
  // run cannot collide with a live receiver — and 0 is falsy, so `||` silently swapped it
  // for the real default and the test spent its life on the production port.
  const port = Number(opts.port ?? process.env.LIVE_PORT ?? 8787);
  const token = (opts.token || process.env.LIVE_TOKEN || '').trim();
  const dir = opts.dir || path.join(DATA_DIR, 'live');
  const log = opts.log || ((m) => console.log(`[live] ${m}`));
  const onTake = opts.onTake || (() => {});
  /**
   * Called with a snapshot of the audio so far, every [partialMs], while somebody is
   * talking. Whatever it resolves to is sent back down the socket as partial text.
   *
   * Absent, nothing is transcribed until the take ends — which is the old behaviour and
   * is still what a test wants.
   */
  const onPartial = opts.onPartial || null;
  /** Text the phone heard, to be returned punctuated. Absent, the say frame is ignored. */
  const onSay = opts.onSay || null;
  const partialMs = Number(opts.partialMs ?? process.env.LIVE_PARTIAL_MS ?? 2000);

  // This port is meant to be reachable from outside the house — that is the entire point,
  // since the phone is in a car. An open microphone endpoint on the public internet with
  // no secret is not a loose end, it is a listening device, so refuse rather than warn.
  if (!token) {
    throw new Error('LIVE_TOKEN is not set. The live channel is reachable from outside ' +
      'and will not start without a shared secret.');
  }

  fs.mkdirSync(dir, { recursive: true });

  const server = http.createServer((req, res) => {
    // A plain GET, so "is it up and can I reach it from here" is answerable from a phone
    // browser on the motorway without any client at all. It says nothing a stranger
    // could use.
    if (req.url && req.url.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rate: RATE, channels: CHANNELS, bits: BITS }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (e) {
      socket.destroy();
      return;
    }

    const given = url.searchParams.get('token') || '';
    // Length-independent compare, because a plain === on a secret leaks its prefix to
    // anyone willing to time the answers.
    const ok = given.length === token.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
    if (!ok) {
      log(`refused ${req.socket.remoteAddress}: bad token`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, url);
    });
  });

  wss.on('connection', (ws, req, url) => {
    const id = crypto.randomBytes(4).toString('hex');
    const chat = url.searchParams.get('chat') || '';
    const from = req.socket.remoteAddress;
    const session = new Session(id, chat, dir, (m) => log(`${id} ${m}`));

    log(`${id} open from ${from}${chat ? ` for ${chat}` : ''}`);
    ws.send(JSON.stringify({ t: 'ready', id, rate: RATE, channels: CHANNELS, bits: BITS }));

    /**
     * Turn what has been heard so far into words, and send them back as they improve.
     *
     * The whole take is re-transcribed each time rather than only the new part. Whisper
     * has no notion of continuing from where it left off, and the words at the end of a
     * fragment are exactly the ones it gets wrong — the next second of speech is what
     * settles them. Re-reading from the start means earlier text stops wobbling as more
     * arrives, which is what makes it readable while it grows.
     *
     * One at a time, and skipped rather than queued when the previous run is still
     * going. A queue here means the text on the phone falls further behind the voice
     * with every tick, which is the opposite of the point.
     */
    // Anything the far side wants to tell the phone. Guarded, because a take can
    // finish transcribing long after the socket it came from has gone.
    const reply = (obj) => {
      if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
    };

    let working = false;
    let lastSent = '';
    const tick = !onPartial ? null : setInterval(() => {
      if (working) return;
      const shot = session.snapshot();
      if (!shot) return;
      working = true;
      Promise.resolve(onPartial(shot))
        .then((text) => {
          const said = (text || '').trim();
          // Only when it has changed. An unchanged line is the phone redrawing for
          // nothing, and during a pause that is every two seconds forever.
          if (said && said !== lastSent && ws.readyState === 1) {
            lastSent = said;
            ws.send(JSON.stringify({ t: 'partial', text: said }));
          }
        })
        .catch((e) => log(`${id} partial failed: ${e.message}`))
        .finally(() => {
          working = false;
          try { fs.unlinkSync(shot.file); } catch (e) {}
        });
    }, partialMs);

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        session.write(Buffer.from(data));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        return;
      }
      switch (msg.t) {
        case 'start':
          session.startTake();
          break;
        case 'end': {
          const take = session.endTake();
          if (take) onTake({ ...take, chat, id, reply });
          // Answered even when there was nothing, so the phone is never left waiting on
          // a reply that is not coming.
          ws.send(JSON.stringify({ t: 'take', ...(take || { seconds: 0 }) }));
          break;
        }
        // Words the phone has heard, on their way to being punctuated.
        //
        // The same socket, carrying text instead of audio. Streaming the sound here
        // cost a codec, a quarter of a megabit the mobile link could not carry, and a
        // race between two readers of one microphone — all to get better words out of
        // a recogniser that was already getting the words right and only missing the
        // punctuation.
        //
        // This sends what Android already heard, a few hundred bytes of it, and sends
        // back the same sentence with its commas. It works on a connection that cannot
        // carry speech at all.
        case 'say': {
          if (!onSay || typeof msg.text !== 'string') {
            // Said out loud, because "no punctuation appeared" cannot otherwise be
            // told apart from "the phone never asked". Both look identical and need
            // opposite fixes, and an hour went on the wrong one.
            log(`${id} say ignored: onSay=${!!onSay} text=${typeof msg.text}`);
            break;
          }
          const sayId = msg.id;
          const asked = Date.now();
          log(`${id} say #${sayId}: "${msg.text.slice(0, 40)}"`);
          Promise.resolve(onSay(msg.text))
            .then((clean) => {
              log(`${id} say #${sayId} back in ${Date.now() - asked}ms` +
                  `${clean && clean !== msg.text ? ' (punctuated)' : ' (unchanged)'}`);
              return clean;
            })
            .then((clean) => {
              // Answered with the id it came in with. Corrections arrive out of order
              // when one sentence takes longer than the next, and a phone applying a
              // late answer to a newer sentence would rewrite words that have moved on.
              if (clean && ws.readyState === 1) {
                ws.send(JSON.stringify({ t: 'tidied', id: sayId, text: clean }));
              }
            })
            .catch(() => {});
          break;
        }

        case 'ping':
          // Echoed with the client's own timestamp, so the phone measures the round trip
          // against its own clock. Comparing two clocks would measure the difference
          // between them, which is not what anyone wants to know.
          ws.send(JSON.stringify({ t: 'pong', at: msg.at }));
          break;
        case 'stats':
          ws.send(JSON.stringify({ t: 'stats', ...session.stats.summary(Date.now()) }));
          break;
      }
    });

    ws.on('close', () => {
      if (tick) clearInterval(tick);
      const take = session.endTake();
      if (take) onTake({ ...take, chat, id, reply });
      const s = session.stats.summary(Date.now());
      log(`${id} closed — ${s.audioSeconds}s of audio in ${s.wallSeconds}s ` +
        `(x${s.realtimeRatio}, ${s.kbPerSecond} KB/s, longest gap ${s.longestGapMs}ms)`);
    });

    ws.on('error', (e) => log(`${id} socket error: ${e.message}`));
  });

  // Resolves once the OS has actually assigned a port, which is the only way to learn it
  // when 0 was asked for, and rejects if the port could not be taken.
  //
  // The rejection is the important half. A port already in use does not come back as a
  // throw from listen() — it arrives later as an 'error' event, and an 'error' event on
  // an EventEmitter with no listener does not get logged, it ends the process. So a
  // caller that wrapped this in try/catch was protected against nothing: pressing the
  // button twice, or starting while something else held the port, took down the whole
  // bot. Caught here and handed to the caller as a rejected promise, which is a thing
  // an await can actually see.
  const listening = new Promise((resolve, reject) => {
    server.once('error', (e) => {
      const why = e.code === 'EADDRINUSE'
        ? `port ${port} is already in use — something is already listening on it`
        : `could not listen on ${port}: ${e.message}`;
      log(why);
      reject(new Error(why));
    });
    server.listen(port, () => {
      const bound = server.address().port;
      log(`listening on ${bound}, writing takes to ${dir}`);
      resolve(bound);
    });
  });

  // An 'error' after a successful listen — a socket torn out from under us — must also
  // not be fatal. The once() above is spent by then, so the channel would be back to
  // having no listener at all.
  server.on('error', (e) => log(`server error: ${e.message}`));

  return {
    /** What was asked for. 0 until the OS has chosen — await `listening` for the real one. */
    port,
    listening,
    dir,
    close: () => new Promise((resolve) => {
      wss.clients.forEach(c => { try { c.close(); } catch (e) {} });
      wss.close(() => server.close(() => resolve()));
    })
  };
}

module.exports = { start, wavHeader, RATE, CHANNELS, BITS, BYTES_PER_SECOND, LinkStats };

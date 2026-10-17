/**
 * Turning what a speech recogniser heard into what a person said.
 *
 * Every recogniser available here — Android's, and whisper — has the same shape of
 * failure, and it is not the one people expect. The words are mostly right. What is
 * missing is everything around them: no full stops, no question marks, no line breaks,
 * and no idea what the conversation is about, so a word that merely sounds like the
 * right one is picked over the right one.
 *
 * "בין זונה זה לא וד" is a sentence nobody said. Read beside the conversation it came
 * out of, it is obvious within a second what it was. That is not proofreading, it is
 * understanding, and it is the one job a language model is unambiguously better at
 * than a transcriber.
 *
 * ── Why this is the cheap fix ───────────────────────────────────────────────
 *
 * A night went into moving audio to a machine that could hear it better: a tunnel,
 * bandwidth, a codec, a dead channel to nurse. All of it to improve the words.
 *
 * This improves the sentence, and it moves a few hundred bytes of text. It works on a
 * connection that cannot carry audio at all, there is nothing to keep alive, and it
 * applies equally to whichever recogniser produced the text — which means it also
 * improves the path that was working all along.
 *
 * ── What it must not do ─────────────────────────────────────────────────────
 *
 * Not answer, not summarise, not improve the writing. The person said something and
 * this returns that same thing, spelled properly. A tidier that rephrases is a tidier
 * that puts words in somebody's mouth, and it would do it invisibly — inside a feature
 * whose whole purpose is to report what was said.
 *
 * On any doubt, failure or timeout it returns the input unchanged. Worse punctuation
 * is a far smaller problem than a lost sentence.
 */

const { execFile } = require('child_process');

const platform = require('./platform');

const log = (m) => console.log(`[tidy] ${m}`);

/**
 * One message at a time, and nothing from the ones before it.
 *
 * The first version passed the last few lines of the conversation as well, so a word
 * could be corrected against what was being discussed. That is useful when it is
 * right and dangerous when it is wrong: a correct word quietly rewritten into one
 * that suits the conversation better, inside a feature whose only job is to report
 * what somebody said.
 *
 * Correcting words is still wanted — a long spoken message carries plenty of context
 * inside itself, and "the rest of this sentence" is evidence the speaker actually
 * produced. Memory of earlier messages is not: it is the model's idea of what the
 * conversation is about, applied to words nobody has checked.
 *
 * So the line is drawn at the edge of the message rather than at the edge of
 * correction.
 */
function prompt(raw) {
  return `Below is a speech-to-text transcript of one spoken message. It has no punctuation, and some words were misheard as similar-sounding ones.

Your ONLY job is punctuation and fixing mishearings. You are not an editor.

Rules, in order of importance:
1. Never remove an idea. Every thing the person said must still be in your output. Deleting a clause, an example, an aside or a whole sentence is a failure, however rambling it is.
2. Never shorten, summarise, tighten or rephrase. You are not improving the writing.
3. Add punctuation, question marks and line breaks where the speech clearly has them.
4. Where a word is plainly a mishearing of a similar-sounding word, replace it with the intended one, using the rest of THIS message to tell.
5. An immediately repeated word that is obviously a stammer — "תעשה תעשה", "אני אני" — may be reduced to one. Only when the repeat is adjacent and adds nothing. A phrase repeated for emphasis stays.

Use only this message. You have no other context and must not invent any.

Do NOT answer it, summarise it, or translate it. Return only the corrected transcript and nothing else.

Transcript:
${raw}`;
}

/**
 * @param raw        what the recogniser produced.
 * @param timeoutMs  how long to wait before giving up and using the raw text.
 * @returns the tidied text, or `raw` if anything at all goes wrong.
 */
/**
 * One Claude process, kept alive between messages.
 *
 * A one-shot `claude -p` took twenty-five seconds, and almost none of it was the
 * model: it was the CLI starting, reading its configuration and connecting what it
 * connects. Paying that per sentence makes the whole idea useless.
 *
 * So the process stays up and messages are handed to it over stdin. One process for
 * everything, not one per conversation — each message is self-contained, there is no
 * history to keep separate, and a process per topic is memory spent on nothing.
 *
 * Replaced rather than nursed when it dies. There is no state in it worth recovering.
 */
let proc = null;
let pending = null;

function stop() {
  const p = proc;
  proc = null;
  pending = null;
  try { p && p.kill(); } catch (e) {}
}

function spawnProc() {
  const { spawn } = require('child_process');
  const model = (process.env.TIDY_MODEL || 'claude-haiku-4-5-20251001').trim();
  // No thinking. The CLI runs its models with internal reasoning on, and a request
  // to add commas to one sentence spends it all on deliberation: measured at 11s and
  // 30s timeouts, against 1.2s for the same model with it off. The model was never
  // the problem and the measurement that said so was read wrong.
  const args = [
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--max-thinking-tokens', '0'
  ];
  if (model && model !== 'default') args.push('--model', model);

  const p = spawn(platform.claudeBin(), args, {
    stdio: ['pipe', 'pipe', 'ignore'],
    ...platform.spawnOpts()
  });

  let buf = '';
  p.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let at;
    while ((at = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      // The assistant's finished answer, which is the only event worth anything here.
      if (msg.type === 'result' && pending) {
        const done = pending;
        pending = null;
        done((msg.result || '').trim());
      }
    }
  });

  p.on('exit', () => { if (proc === p) stop(); });
  p.on('error', () => { if (proc === p) stop(); });

  proc = p;
  return p;
}

/**
 * @param raw        what the recogniser produced.
 * @param timeoutMs  how long to wait before giving up and using the raw text.
 * @returns the punctuated text, or `raw` if anything at all goes wrong.
 */
function tidy(raw, timeoutMs = 30000) {
  const text = (raw || '').trim();
  // Not worth a model call, and a model given two words invents a sentence around them.
  if (text.length < 12) return Promise.resolve(text);

  // One at a time, by waiting rather than by giving up.
  //
  // Giving up was the first version and it quietly disabled the feature: the warm-up
  // started at boot holds the slot for twenty seconds, so every message in that
  // window returned in 0ms, unchanged, having never been attempted. The log said
  // exactly that and it read as "the tidier does nothing".
  //
  // Still strictly one at a time — two in flight would have their answers matched to
  // the wrong request, and a sentence coming back as somebody else's is worse than a
  // slow one.
  queue = queue.then(() => run(text, timeoutMs)).catch(() => text);
  return queue;
}

let queue = Promise.resolve();

function run(text, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // Every one of these means "use what the recogniser said". A tidier that fails
      // loudly is a tidier that loses messages, and losing a message is the one
      // outcome worse than reading it without commas.
      if (!out) return resolve(text);

      // A model that answered rather than punctuated. Adding commas does not triple
      // the length, and sending a reply back as though the user had said it is worse
      // than doing nothing.
      if (out.length > text.length * 3 + 80) return resolve(text);

      // A model that edited rather than punctuated.
      //
      // Two kinds of shortening look the same to a word count and could not be more
      // different. "תעשה תעשה" collapsing to "תעשה" is the stammer of somebody
      // thinking, and removing it is right. "אני בכוונה אומר מילים מסובכות כמו very
      // nice וזה עובד יפה" collapsing to "אני בכוונה יפה" is half a sentence gone,
      // and the result reads perfectly well — which is exactly what makes it
      // dangerous. A transcript missing what somebody said, with nothing marking the
      // gap, is worse than one without commas.
      //
      // The difference is not how much went but what: tidying a stammer removes a
      // repeat of a word that is still there, while editing removes words that
      // appear nowhere else. So a word that occurred once and has vanished is the
      // test, and a count of words is not.
      const bag = (s) => {
        const m = new Map();
        for (const w of s.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean)) {
          m.set(w, (m.get(w) || 0) + 1);
        }
        return m;
      };
      const had = bag(text);
      const kept = bag(out);
      const lost = [];
      for (const [w, n] of had) {
        // Only words that were said once. A word repeated three times and kept twice
        // has had a stammer tidied, which is the thing being allowed for.
        if (n === 1 && !kept.has(w)) lost.push(w);
      }
      // One is a mishearing being corrected into a word already present. Several is
      // a sentence being rewritten.
      if (lost.length > 2) {
        log(`refused: dropped ${lost.length} words that were said once — ${lost.slice(0, 6).join(', ')}`);
        return resolve(text);
      }

      resolve(out);
    };

    const timer = setTimeout(() => {
      pending = null;
      // A process that missed a deadline has usually wedged rather than slowed, and
      // the next message should not inherit its queue.
      stop();
      finish(null);
    }, timeoutMs);

    let p;
    try {
      p = proc || spawnProc();
    } catch (e) {
      return finish(null);
    }

    pending = finish;
    try {
      p.stdin.write(`${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt(text) }] }
      })}\n`);
    } catch (e) {
      pending = null;
      stop();
      finish(null);
    }
  });
}

/**
 * Start the process and let it answer one throwaway line.
 *
 * Measured cold, warming, and warm: 19.6s, 8.2s, 3.0s. The model is not what is slow —
 * the first exchange is. Without this, everything said in the first minute after a
 * restart times out and comes back unpunctuated, which is exactly what was happening
 * while it was being reported as "I see no difference": the bot had restarted moments
 * before each attempt.
 *
 * Nothing waits on it and a failure is ignored. It is a head start, not a dependency.
 */
function warm() {
  tidy('This is a warm up line with enough words in it to be worth punctuating', 90000)
    .catch(() => {});
}

/**
 * Whether this reads like something spoken rather than typed.
 *
 * Nothing arriving over Telegram says how it was produced, and marking dictation at
 * the source would put a marker in the conversation forever. The text gives it away:
 * a recogniser returns a long run of words with no sentence ending anywhere in it,
 * and anything typed either has punctuation or is too short to need any.
 *
 * Both ways of being wrong are cheap. A typed message tidied by mistake comes back
 * reading the same, and a dictated one missed reads as it does today.
 */
function looksDictated(text) {
  const t = (text || '').trim();
  if (t.length < 40) return false;
  // A command, a path, a pasted block. None of them are speech and all of them are
  // things a model asked to punctuate would quietly damage.
  if (/^[/!]/.test(t) || /```|https?:\/\/|\\\\|[A-Za-z]:\\/.test(t)) return false;
  return !/[.!?؟？。]/.test(t);
}

module.exports = { tidy, warm, stop, looksDictated };

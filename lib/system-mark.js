/**
 * Marks a message as machinery rather than an answer.
 *
 * A client reading messages out loud has to tell the two apart, and guessing from
 * the text is a losing game — it means chasing every new wording, in every language,
 * forever. The bot already knows which of its messages are progress, timings and
 * tool counts, so it says so.
 *
 * The mark is an invisible separator character. Telegram renders nothing for it, a
 * human sees no difference, and anything that cares can check one character instead
 * of parsing prose.
 */

const MARK = '⁣';

/** Stamps a status line. Safe to call twice. */
function system(text) {
  const s = String(text);
  return s.startsWith(MARK) ? s : MARK + s;
}

/** Whether a message announced itself as machinery. */
function isSystem(text) {
  return String(text || '').startsWith(MARK);
}

module.exports = { MARK, system, isSystem };

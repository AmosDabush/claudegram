/**
 * The terminal's own status line, for Telegram.
 *   ✻ Vibing… (25s · ↓ 1.9k tokens)
 * Shared by both pipes so they read identically. Vocabulary lifted from the CLI.
 */
const WORDS = ['Vibing', 'Reticulating', 'Incubating', 'Brewing', 'Percolating',
               'Simmering', 'Noodling', 'Pondering', 'Marinating', 'Conjuring',
               'Schlepping', 'Puttering', 'Finagling'];

const humanTokens = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function statusLine(startedMs, tokens = 0, done = false) {
  const el = Math.max(0, Math.round((Date.now() - startedMs) / 1000));
  const tok = tokens ? ` · ↓ ${humanTokens(tokens)} tokens` : '';
  if (done) return `✅ Done (${el}s${tok})`;
  return `✻ ${WORDS[Math.floor(el / 6) % WORDS.length]}… (${el}s${tok})`;
}

module.exports = { statusLine, WORDS, humanTokens };

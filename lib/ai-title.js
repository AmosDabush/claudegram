/**
 * AI Titles — meaningful session names from a LOCAL model (free, no tokens).
 *
 * Runs gemma over Ollama on the first + last human messages of a session and
 * caches the result on disk. Generation happens in a background queue so the
 * sessions list is never blocked; resolveTitle() reads only the cache (sync).
 * Layer order in the app: manual note > AI title (here) > cleaned first message.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { getSessionEndpoints } = require('./sessions');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'ai-titles.json');
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const OLLAMA_MODEL = process.env.AI_TITLE_MODEL || 'gemma4:12b';

const queue = [];
let running = false;

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) || {}; }
  catch (e) { return {}; }
}

function saveCache(c) {
  try {
    const d = path.dirname(CACHE_FILE);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
  } catch (e) { /* non-critical */ }
}

/**
 * Cached title, or null. Invalidated when the conversation advanced past what
 * we last titled (so a growing session eventually gets a fresher name).
 */
function getCached(id, lastUsed) {
  const c = loadCache()[id];
  if (!c || !c.title) return null;
  if (lastUsed && c.lastTs && new Date(lastUsed) > new Date(c.lastTs)) return null;
  return c.title;
}

function callOllama(prompt) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      think: false, // gemma is a thinking model — without this it burns the token budget on hidden reasoning and returns empty
      options: { temperature: 0.2, num_predict: 40 }
    });
    const req = http.request({
      host: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).response || ''); } catch (e) { resolve(''); } });
    });
    req.on('error', () => resolve(''));
    req.setTimeout(30000, () => { req.destroy(); resolve(''); });
    req.write(body);
    req.end();
  });
}

function cleanTitle(t) {
  return String(t || '')
    .replace(/^(title|כותרת)\s*[:：-]\s*/i, '')
    .replace(/[*_`~\[\]]/g, '')            // strip markdown chars that would break Telegram formatting
    .replace(/^["'\s]+|["'.\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .substring(0, 48)
    .trim();
}

async function generate(session) {
  const ep = getSessionEndpoints(session.id);
  if (!ep || (!ep.first && !ep.last)) return null;

  const prompt =
    `You name coding-assistant chat sessions.\n` +
    `Given the FIRST and LAST user messages of a session, write ONE short title ` +
    `(max 6 words) that captures what the session is about. ` +
    `Use the same language as the messages. No quotes, no trailing punctuation. ` +
    `Output only the title.\n\n` +
    `FIRST: ${ep.first}\n` +
    `LAST: ${ep.last}\n\n` +
    `Title:`;

  const title = cleanTitle(await callOllama(prompt));
  if (!title) return null;

  const c = loadCache();
  c[session.id] = { title, at: new Date().toISOString(), lastTs: session.lastUsed || new Date().toISOString() };
  saveCache(c);
  return title;
}

/**
 * Queue sessions that lack a fresh cached title. Fire-and-forget — titles show
 * up on the next list open.
 */
function enqueue(sessions) {
  for (const s of sessions || []) {
    if (!s || !s.id) continue;
    if (getCached(s.id, s.lastUsed)) continue;
    if (queue.find(q => q.id === s.id)) continue;
    queue.push(s);
  }
  drain();
}

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const s = queue.shift();
    if (getCached(s.id, s.lastUsed)) continue;
    try { await generate(s); } catch (e) { /* skip, will retry next open */ }
  }
  running = false;
}

module.exports = { getCached, enqueue };

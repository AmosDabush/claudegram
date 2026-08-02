/**
 * Bookmarks Store
 * Persistent, on-disk bookmark history (survives forever, unlike inline
 * chat buttons that scroll away). Source of truth is data/bookmarks.json,
 * keyed per chat. Resume itself still leans on the unified session registry.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'bookmarks.json');

function load() {
  try {
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, 'utf-8')) || {};
  } catch (e) {
    console.log(`⚠️ bookmarks load failed: ${e.message}`);
    return {};
  }
}

function save(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.log(`⚠️ bookmarks save failed: ${e.message}`);
  }
}

function list(chatId) {
  return load()[String(chatId)] || [];
}

function add(chatId, bookmark) {
  const data = load();
  const key = String(chatId);
  if (!data[key]) data[key] = [];
  // De-dupe by session id: a fresh bookmark for the same session replaces the old one
  data[key] = data[key].filter(b => b.id !== bookmark.id);
  data[key].unshift(bookmark); // newest first
  save(data);
  return data[key];
}

function remove(chatId, shortId) {
  const data = load();
  const key = String(chatId);
  if (!data[key]) return [];
  data[key] = data[key].filter(b => !String(b.id).startsWith(shortId));
  save(data);
  return data[key];
}

module.exports = { list, add, remove };

/**
 * Session Meta — notes + archive, shared with the sessions Web UI.
 *
 * Reads/writes the SAME files the Web UI (~/.claude/sessions-ui) uses, so a
 * note or archive toggle done from Telegram shows up in the Web UI and vice
 * versa. One source of truth, two frontends. Keyed by full session id.
 *   notes.json    -> { [id]: { text, at } }
 *   archived.json -> { [id]: { at } }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const UI_DIR = path.join(os.homedir(), '.claude', 'sessions-ui');
const NOTES_FILE = path.join(UI_DIR, 'notes.json');
const ARCHIVE_FILE = path.join(UI_DIR, 'archived.json');

function loadJson(file) {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf-8')) || {};
  } catch (e) {
    console.log(`⚠️ session-meta load failed (${path.basename(file)}): ${e.message}`);
    return {};
  }
}

function saveJson(file, data) {
  try {
    if (!fs.existsSync(UI_DIR)) fs.mkdirSync(UI_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch (e) {
    console.log(`⚠️ session-meta save failed (${path.basename(file)}): ${e.message}`);
  }
}

// ---- Notes ----
function getNote(id) {
  const n = loadJson(NOTES_FILE)[id];
  return n && n.text ? n.text : null;
}

function setNote(id, text) {
  const notes = loadJson(NOTES_FILE);
  const t = String(text || '').trim();
  if (t) notes[id] = { text: t, at: new Date().toISOString() };
  else delete notes[id];
  saveJson(NOTES_FILE, notes);
  return t || null;
}

// ---- Archive ----
function isArchived(id) {
  return !!loadJson(ARCHIVE_FILE)[id];
}

function archive(id) {
  const a = loadJson(ARCHIVE_FILE);
  a[id] = { at: new Date().toISOString() };
  saveJson(ARCHIVE_FILE, a);
}

function unarchive(id) {
  const a = loadJson(ARCHIVE_FILE);
  delete a[id];
  saveJson(ARCHIVE_FILE, a);
}

function archivedIds() {
  return new Set(Object.keys(loadJson(ARCHIVE_FILE)));
}

module.exports = { getNote, setNote, isArchived, archive, unarchive, archivedIds };

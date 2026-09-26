/**
 * Names for forum topics the bot has seen.
 *
 * A bot cannot ask Telegram which topics a group has — the API creates, edits and closes
 * them but never lists them. The name does arrive, though, on the service message when a
 * topic is created and on the first message of a thread, so it can be kept as it goes by.
 * That is enough to offer "which topic?" as a list of names instead of a list of numbers.
 *
 * Missing a name costs nothing: the topic still works, it is just listed by its id.
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'topics.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch (e) {
    cache = {};
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.log('⚠️ Could not save topic names:', e.message);
  }
}

/** The topic name carried by a message, if this one happens to carry it. */
function nameOf(msg) {
  if (!msg) return null;
  if (msg.forum_topic_created && msg.forum_topic_created.name) return msg.forum_topic_created.name;
  if (msg.forum_topic_edited && msg.forum_topic_edited.name) return msg.forum_topic_edited.name;
  const replied = msg.reply_to_message;
  if (replied && replied.forum_topic_created && replied.forum_topic_created.name) {
    return replied.forum_topic_created.name;
  }
  return null;
}

/**
 * Record the topic a message came from, when it names it. Takes the message before its
 * chat id is swapped for the synthetic key, so it reads the thread id itself.
 */
function remember(msg) {
  const name = nameOf(msg);
  if (!name || !msg.message_thread_id || !msg.chat) return null;
  const key = `${msg.chat.id}:${msg.message_thread_id}`;
  const known = load();
  if (known[key] === name) return key;
  known[key] = name;
  save();
  return key;
}

/** Everything known, as { "<chat>:<thread>": name }. */
function all() {
  return { ...load() };
}

/** The name for one key, or null. */
function nameFor(key) {
  return load()[key] || null;
}

module.exports = { remember, all, nameFor, nameOf };

/**
 * Which machine a topic's sessions run on.
 *
 * The bot has always run sessions on the box it is running on, and that was the whole
 * story while there was one box. There are two: a Windows machine and a Mac, and only one
 * of them can poll the group token, so every topic answered from that one. A session
 * moved in from the other arrived as a Resume button that could not work — its transcript
 * was on a machine the bot could not reach.
 *
 * So a topic gets told which machine it belongs to, once, and remembers.
 *
 * A topic with no machine recorded runs here, which is what every existing topic did
 * yesterday and still does. Nothing changes for somebody with one machine: with no
 * remotes configured there is nothing to ask and nothing to choose, and the question is
 * never put.
 *
 * Configured in .env:
 *
 *   HOST_NAME=windows                       what this machine is called
 *   REMOTE_HOSTS=mac=amos@studio.local      the others, and how to reach them
 *
 * The names are yours; they are labels on buttons and in lists. The part after '=' is an
 * ssh destination, because the thing being asked for is "run this there" and ssh is the
 * answer that needs no daemon written for it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'topic-hosts.json');

/**
 * What this machine is called.
 *
 * Defaulted by platform rather than left blank, so the buttons read "windows" and "mac"
 * without anybody configuring anything. A hostname would be honest and useless: nobody
 * picks a machine off "DESKTOP-4F7K2Q1".
 */
const THIS_HOST = (process.env.HOST_NAME || '').trim() ||
  (process.platform === 'win32' ? 'windows'
    : process.platform === 'darwin' ? 'mac'
      : os.hostname());

/** The other machines, as { name -> ssh destination }. */
function remotes() {
  const raw = (process.env.REMOTE_HOSTS || '').trim();
  if (!raw) return {};
  const out = {};
  for (const entry of raw.split(',')) {
    const at = entry.indexOf('=');
    if (at < 1) continue;
    const name = entry.slice(0, at).trim();
    const target = entry.slice(at + 1).trim();
    // A remote calling itself what this machine is called would make "run it there"
    // and "run it here" the same instruction, and one of them would be wrong.
    if (!name || !target || name === THIS_HOST) continue;
    out[name] = target;
  }
  return out;
}

/** Every machine that can be chosen, this one first. */
function list() {
  return [
    { name: THIS_HOST, local: true, ssh: null },
    ...Object.entries(remotes()).map(([name, ssh]) => ({ name, local: false, ssh }))
  ];
}

/** Whether there is any choice to offer. One machine is not a choice. */
function hasChoice() {
  return Object.keys(remotes()).length > 0;
}

/** How to reach a machine, or null if it is this one or unknown. */
function sshTargetOf(name) {
  return remotes()[name] || null;
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function save(map) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(map, null, 2));
  } catch (e) {
    console.log('⚠️ Could not save topic hosts:', e.message);
  }
}

/** The machine a topic was bound to, or null if it was never asked. */
function hostFor(key) {
  return load()[key] || null;
}

/** Bind a topic to a machine. Returns the name bound, for logging. */
function bind(key, name) {
  const map = load();
  map[key] = name;
  save(map);
  return name;
}

function unbind(key) {
  const map = load();
  if (!(key in map)) return false;
  delete map[key];
  save(map);
  return true;
}

/**
 * Whether a topic's work happens on this machine.
 *
 * Unbound means here. Every topic that existed before any of this ran here, and a
 * question nobody has been asked yet must not change where their work goes.
 */
function runsHere(key) {
  const bound = hostFor(key);
  return !bound || bound === THIS_HOST;
}

/**
 * Whether this machine is the one that answers a topic in the group.
 *
 * `runsHere` asks where a topic's work happens and says "here" when nobody was asked.
 * That is the right answer for one machine and the wrong one for two: both poll their own
 * group bot, both see every message in the shared group, and both would claim every
 * unbound topic and answer it twice.
 *
 * So the unbound ones go to GROUP_FALLBACK_HOST, which has to read the same on every
 * machine for exactly one of them to pick them up. Unset, it is this machine — which is
 * what a single-box setup has always done, and what the second machine must never be
 * left on by accident.
 */
function answersHere(key) {
  const fallback = (process.env.GROUP_FALLBACK_HOST || '').trim() || THIS_HOST;
  return (hostFor(key) || fallback) === THIS_HOST;
}

/** All bindings, as { "<chat>:<thread>": machine }. */
function all() {
  return load();
}

/** A short marker for a list: nothing for here, the machine's name for elsewhere. */
function markerFor(key) {
  const bound = hostFor(key);
  if (!bound || bound === THIS_HOST) return '';
  return ` · ${bound}`;
}

module.exports = {
  THIS_HOST, remotes, list, hasChoice, sshTargetOf,
  hostFor, bind, unbind, runsHere, answersHere, all, markerFor
};

#!/usr/bin/env node
/**
 * QA for the project-path round trip — encode a folder the way Claude does, decode it
 * back, and land on the folder you started from.
 *
 * This is the pair that decides whether a session can be resumed. The bot finds a
 * transcript by walking ~/.claude/projects, and the only thing tying a transcript to a
 * working folder is the encoded folder name it sits in. Decode it wrong and the session
 * looks like one whose folder was deleted: it is dropped, and the topic wakes up with no
 * memory of the conversation it was in the middle of.
 *
 * The names below are the ones that actually broke it. Claude flattens '.', '_' and ':'
 * into '-' along with the separators, so '-1004306041139_178' — the shape of every topic
 * workspace — encodes to something no amount of re-joining with dashes spells back.
 *
 *   node scripts/qa-paths.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const platform = require('../lib/platform');
const { decodeProjectPath } = require('../lib/sessions');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
};

console.log('\nproject paths\n');

// A throwaway tree, so the test says the same thing on a machine that has none of the
// real folders — and on the Mac, which has none of them by definition.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'claudegram-qa-paths-'));

// [ folder name, what makes it worth testing ]
const NAMES = [
  ['-1004306041139_178', 'a topic workspace: leading dash and an underscore'],
  ['claudegram-chats', 'a plain dash, which is also the separator'],
  ['.claude', 'a hidden folder, whose dot encodes like a separator'],
  ['gaggimate-data', 'an ordinary project'],
  ['v1.2.3_beta', 'dots and an underscore in one name'],
  ['plain', 'nothing special, the case that always worked']
];

const made = [];
for (const [name] of NAMES) {
  const dir = path.join(ROOT, name, 'inner');
  fs.mkdirSync(dir, { recursive: true });
  made.push([name, dir]);
}

for (const [i, [name, dir]] of made.entries()) {
  const why = NAMES[i][1];
  const encoded = platform.encodeProjectPath(dir);
  const decoded = decodeProjectPath(encoded);
  ok(`${name} — ${why}`, decoded === dir, `${encoded}\n          -> ${decoded}\n          want ${dir}`);
}

// Two siblings where one name is the other plus a separator. The walk prefers the longest
// real name, so the longer one must not be eaten as "the short one, then another part".
const AMBIG = path.join(ROOT, 'app', 'app-server');
fs.mkdirSync(AMBIG, { recursive: true });
ok('a child whose name contains a separator wins over its own prefix',
  decodeProjectPath(platform.encodeProjectPath(AMBIG)) === AMBIG,
  decodeProjectPath(platform.encodeProjectPath(AMBIG)));

// The same ambiguity, with the longest match leading nowhere. Preferring the longest name
// is a preference, not an answer: 'a-b' matches the front of 'a-b-target' and is a dead
// end, and the walk has to come back out of it and try 'a' instead. Without that it stops
// at the first plausible turn and reports a path that was never asked for.
fs.mkdirSync(path.join(ROOT, 'ambig', 'a-b'), { recursive: true });
const DEEPER = path.join(ROOT, 'ambig', 'a', 'b', 'target');
fs.mkdirSync(DEEPER, { recursive: true });
ok('a longest match that dead-ends is backed out of',
  decodeProjectPath(platform.encodeProjectPath(DEEPER)) === DEEPER,
  decodeProjectPath(platform.encodeProjectPath(DEEPER)));

// A folder that no longer exists still has to decode to something shaped like itself —
// the caller decides what a missing folder means, and cannot if the walk stops halfway.
const GONE = path.join(ROOT, 'plain', 'inner', 'deleted-yesterday');
const goneDecoded = decodeProjectPath(platform.encodeProjectPath(GONE));
ok('a deleted folder still decodes to a full path',
  goneDecoded.startsWith(path.join(ROOT, 'plain', 'inner')) && goneDecoded.endsWith('yesterday'),
  goneDecoded);

fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

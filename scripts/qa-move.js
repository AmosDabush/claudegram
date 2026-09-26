#!/usr/bin/env node
/**
 * QA for scripts/move-to-telegram.js — where does a moved session land?
 *
 * Separate from scripts/qa.js because it tests a script rather than the running bot: it
 * drives the real thing as a subprocess in --dry-run, which sends nothing and registers
 * nothing. The records it reads are faked in a throwaway data directory, so a run cannot
 * touch the live sessions or depend on which topics happen to exist today.
 *
 *   node scripts/qa-move.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BOT_DIR = path.join(__dirname, '..');
const SCRIPT = path.join(BOT_DIR, 'scripts', 'move-to-telegram.js');
const DATA = path.join(BOT_DIR, 'data-qa');

const GROUP = '-1009999999999';
const IN_TOPIC = '11111111-aaaa-bbbb-cccc-000000000001';   // has lived in a topic
const FRESH = '22222222-aaaa-bbbb-cccc-000000000002';      // has not

// ── A data directory the script will read, with nothing real in it ───────────
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'user-state.json'), JSON.stringify({
  users: {
    '8046123315': { interactiveSessionId: 'dddddddd-0000-0000-0000-000000000000' },
    [`${GROUP}:41`]: { interactiveSessionId: IN_TOPIC },
  },
}, null, 2));
fs.writeFileSync(path.join(DATA, 'sessions.json'), JSON.stringify({}, null, 2));
fs.writeFileSync(path.join(DATA, 'topics.json'), JSON.stringify({ [`${GROUP}:41`]: 'Named topic' }, null, 2));

// A session that was moved once and has not been talked to since is only recorded in the
// registry, by the move itself. Nothing else knows about it yet, so this is the record
// that has to carry "go back to its topic" the second time.
const MOVED = '33333333-aaaa-bbbb-cccc-000000000003';
fs.writeFileSync(path.join(DATA, 'unified-sessions.json'), JSON.stringify({
  sessions: [{ id: MOVED, source: 'cli', sourceId: `${GROUP}:151`, projectPath: '/anywhere', topic: 'moved once', messageCount: 1 }],
}, null, 2));

// ── A transcript for each session, so the script has something to find ───────
const platform = require(path.join(BOT_DIR, 'lib', 'platform'));
const CWD = path.join(os.tmpdir(), 'claudegram-qa-move');
fs.mkdirSync(CWD, { recursive: true });
const projectDir = path.join(platform.PROJECTS_DIR, platform.encodeProjectPath(CWD));
fs.mkdirSync(projectDir, { recursive: true });
for (const id of [IN_TOPIC, FRESH, MOVED]) {
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'qa prompt' } }) + '\n');
}

// A case may supply its own --cwd; the default one must not shadow it, since the script
// reads the first occurrence of a flag.
const run = (args) => {
  const base = args.includes('--cwd') ? ['--dry-run'] : ['--cwd', CWD, '--dry-run'];
  try {
    return execFileSync(process.execPath, [SCRIPT, ...base, ...args], {
      env: { ...process.env, CLAUDEGRAM_QA: '1', ALLOWED_USER_IDS: '8046123315', GROUP_CHAT_ID: GROUP },
      encoding: 'utf-8',
    });
  } catch (err) {
    return `FAILED: ${(err.stderr || err.message || '').toString().trim()}`;
  }
};

const CASES = [
  {
    name: 'a session that has lived in a topic goes back to that topic',
    args: ['--session', IN_TOPIC],
    check: (out) =>
      (/topic 41/.test(out) && /last in/.test(out)) ||
      `expected topic 41, got: ${out.split('\n')[0]}`,
  },
  {
    name: 'and says which topic, by name',
    args: ['--session', IN_TOPIC],
    check: (out) => /Named topic/.test(out) || 'the reason did not name the topic',
  },
  {
    // The second move of a session that was only ever moved, never talked to. Its topic
    // exists solely because the first move made it, so the registry is the only record.
    name: 'a session moved once goes back there, not into a second new topic',
    args: ['--session', MOVED],
    check: (out) =>
      (/topic 151/.test(out) && !/created on send/.test(out)) ||
      `expected topic 151, got: ${out.split('\n').slice(0, 2).join(' / ')}`,
  },
  {
    name: 'a session that never had one gets a new topic',
    args: ['--session', FRESH],
    check: (out) =>
      (/never been in one/.test(out) && /created on send/.test(out)) ||
      `expected a new topic, got: ${out.split('\n')[1] || out.split('\n')[0]}`,
  },
  {
    name: '--dm overrides a remembered topic',
    args: ['--session', IN_TOPIC, '--dm'],
    check: (out) => /8046123315/.test(out) && /main bot/.test(out) || `--dm was ignored: ${out.split('\n')[0]}`,
  },
  {
    name: '--thread overrides a remembered topic',
    args: ['--session', IN_TOPIC, '--chat', GROUP, '--thread', '77'],
    check: (out) => /topic 77/.test(out) || `--thread was ignored: ${out.split('\n')[0]}`,
  },
  {
    name: '--new-topic overrides a remembered topic',
    args: ['--session', IN_TOPIC, '--new-topic'],
    check: (out) => /created on send/.test(out) || `--new-topic was ignored: ${out.split('\n')[1] || ''}`,
  },
  {
    name: 'a dry run registers nothing',
    args: ['--session', FRESH],
    check: (out) => /would register/.test(out) || 'a dry run claimed to have registered',
  },
  {
    name: 'a missing transcript is reported, not sent anyway',
    args: ['--session', FRESH, '--cwd', path.join(os.tmpdir(), 'claudegram-qa-nothing-here')],
    check: (out) => /No session transcript|FAILED/.test(out) || `it carried on regardless: ${out.split('\n')[0]}`,
  },
];

let failed = 0;
console.log(`\nQA (move-to-telegram): ${CASES.length} case(s)\n`);
for (const testCase of CASES) {
  const out = run(testCase.args);
  const verdict = testCase.check(out);
  if (verdict === true) console.log(`  ok    ${testCase.name}`);
  else {
    failed++;
    console.log(`  FAIL  ${testCase.name}`);
    console.log(`        ${verdict}`);
  }
}

// Leave nothing behind: the transcripts sit in the real projects directory.
try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(CWD, { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}

console.log(`\n${CASES.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

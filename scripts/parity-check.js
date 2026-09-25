#!/usr/bin/env node
/**
 * parity-check.js — prove the Windows port did not change the Mac.
 *
 *   node scripts/parity-check.js
 *
 * On darwin it asserts that every lib/platform.js helper returns EXACTLY what
 * the inline code it replaced returned. That is the whole contract: the port is
 * additive, macOS behaviour is untouched. Run this on the Mac before merging —
 * if it passes there, the resume pipe cannot have shifted underneath you.
 *
 * On win32 it asserts the Windows branch actually resolves: claude is found,
 * project folders decode to directories that exist.
 *
 * Both platforms run the round-trip check, which is the real functional test:
 * every folder under ~/.claude/projects must decode to a path that re-encodes
 * to the same folder name. That is what /sessions depends on.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = require('../lib/platform');

let pass = 0, fail = 0, warn = 0;

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
}
function note(name, detail) { warn++; console.log(`  warn  ${name}\n          ${detail}`); }
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected: ${expected}\n          actual:   ${actual}`);
}

console.log(`\nparity-check — ${process.platform}, node ${process.version}\n`);

// ── 1. Values that the old inline code computed ──────────────────────────────
console.log('inline-expression parity');

if (process.platform === 'darwin') {
  // These are the literal expressions that were in config.js, sessions.js,
  // state.js and utils.js before the port.
  eq('HOME            == process.env.HOME', P.HOME, process.env.HOME);
  eq('PROJECTS_DIR    == $HOME/.claude/projects',
     P.PROJECTS_DIR,
     path.join(process.env.HOME || os.homedir(), '.claude', 'projects'));
  eq('NULL_DEVICE     == /dev/null', P.NULL_DEVICE, '/dev/null');

  const sc = P.shellCommand('echo hi');
  ok('shellCommand    == bash -c <cmd>',
     sc.file === 'bash' && sc.args.length === 2 && sc.args[0] === '-c' && sc.args[1] === 'echo hi',
     JSON.stringify(sc));

  ok('spawnOpts       == {} (no shell on darwin)',
     Object.keys(P.spawnOpts()).length === 0, JSON.stringify(P.spawnOpts()));

  const sample = '/Users/amos/git/auto-avsr';
  eq('encodeProjectPath == path.replace(/\\//g, "-")',
     P.encodeProjectPath(sample), sample.replace(/\//g, '-'));

  const enc = '-Users-amos-git';
  const dr = P.decodeRoot(enc);
  ok('decodeRoot      == { "/", split("-") }',
     dr.root === '/' && dr.parts.join('-') === enc.replace(/^-/, ''), JSON.stringify(dr));

  // startInteractiveSession hardcoded `${homeDir}/.local/bin/claude`.
  const legacy = path.join(P.HOME, '.local', 'bin', 'claude');
  if (fs.existsSync(legacy)) {
    eq('claudeBin       == $HOME/.local/bin/claude', P.claudeBin(), legacy);
  } else {
    note('claudeBin', `~/.local/bin/claude is absent; resolved to ${P.claudeBin()}.\n          `
      + 'The old code hardcoded that path, so it was already broken here.');
  }
} else if (process.platform === 'win32') {
  ok('HOME resolves', !!P.HOME && fs.existsSync(P.HOME), P.HOME);
  ok('HOME is not the dead /home/user fallback', P.HOME !== '/home/user', P.HOME);
  eq('NULL_DEVICE     == NUL', P.NULL_DEVICE, 'NUL');

  const sc = P.shellCommand('echo hi');
  ok('shellCommand    -> powershell', sc.file === 'powershell.exe', JSON.stringify(sc));
  ok('spawnOpts       -> shell:true (claude.cmd is a shim)', P.spawnOpts().shell === true);

  eq('encodeProjectPath("C:\\\\Users\\\\amos")', P.encodeProjectPath('C:\\Users\\amos'), 'C--Users-amos');
  const dr = P.decodeRoot('C--Users-amos');
  ok('decodeRoot("C--Users-amos") -> C:\\ + [Users, amos]',
     dr.root === 'C:\\' && dr.parts.join(',') === 'Users,amos', JSON.stringify(dr));

  const bin = P.claudeBin();
  ok('claudeBin exists on disk', fs.existsSync(bin), bin);
} else {
  note('platform', `${process.platform} is neither darwin nor win32; only the round-trip runs.`);
}

// ── 2. The functional test, on both platforms ────────────────────────────────
// Every real project folder must survive decode -> encode unchanged, or
// /sessions silently shows nothing for that project.
console.log('\nproject-folder round trip');

const dir = P.PROJECTS_DIR;
if (!fs.existsSync(dir)) {
  note('projects dir', `${dir} does not exist — nothing to round-trip.`);
} else {
  // Reuse the real decoder, not a copy of it.
  const { decodeProjectPath } = require('../lib/sessions');
  const folders = fs.readdirSync(dir).filter(f => {
    try { return fs.statSync(path.join(dir, f)).isDirectory(); } catch (e) { return false; }
  });

  if (!folders.length) note('projects dir', `${dir} is empty.`);

  let bad = 0;
  for (const enc of folders) {
    const decoded = decodeProjectPath(enc);
    const re = decoded ? P.encodeProjectPath(decoded) : null;
    if (re !== enc) {
      bad++;
      if (bad <= 5) console.log(`  FAIL  ${enc}\n          decoded: ${decoded}\n          re-encoded: ${re}`);
    }
  }
  if (bad) {
    fail++;
    console.log(`  FAIL  ${bad}/${folders.length} folders do not round-trip`);
  } else {
    pass++;
    console.log(`  ok    all ${folders.length} project folders round-trip`);
  }

  // A decoded path that no longer exists is expected (deleted projects) and is
  // not a failure — but if NONE resolve, the decoder is wrong for this platform.
  const live = folders.map(decodeProjectPath).filter(p => p && fs.existsSync(p));
  ok('at least one project folder decodes to a real directory',
     folders.length === 0 || live.length > 0,
     `0 of ${folders.length} decoded paths exist — decoder is wrong for this platform`);
}

console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings\n`);
process.exit(fail ? 1 : 0);

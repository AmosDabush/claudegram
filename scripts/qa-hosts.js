#!/usr/bin/env node
/**
 * QA for lib/hosts.js — which machine a topic belongs to.
 *
 * Runs against a throwaway data directory, so a run cannot touch real bindings.
 *
 *   node scripts/qa-hosts.js
 */

const fs = require('fs');
const path = require('path');

// The same throwaway directory the rest of the QA uses, so a run cannot touch the
// real bindings. lib/config reads this before anything else does.
process.env.CLAUDEGRAM_QA = '1';
process.env.HOST_NAME = 'windows';
process.env.REMOTE_HOSTS = 'mac=amos@studio.local';

const DATA = path.join(__dirname, '..', 'data-qa');

const hosts = require('../lib/hosts');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
};

console.log('\nhosts\n');

ok('this machine is named from HOST_NAME', hosts.THIS_HOST === 'windows', hosts.THIS_HOST);
ok('a remote is read out of REMOTE_HOSTS', hosts.sshTargetOf('mac') === 'amos@studio.local');
ok('an unknown machine has no route', hosts.sshTargetOf('nowhere') === null);
ok('both machines are offered', hosts.list().map(h => h.name).join(',') === 'windows,mac');
ok('one of them is this one', hosts.list().filter(h => h.local).length === 1);
ok('there is a choice to offer', hosts.hasChoice() === true);

const KEY = '-100123:41';

// The part that must not change for anybody who never answers the question.
ok('an unbound topic runs here', hosts.runsHere(KEY) === true);
ok('an unbound topic is unmarked', hosts.markerFor(KEY) === '');

hosts.bind(KEY, 'mac');
ok('a bound topic remembers', hosts.hostFor(KEY) === 'mac');
ok('a topic bound elsewhere does not run here', hosts.runsHere(KEY) === false);
ok('a topic bound elsewhere is marked', hosts.markerFor(KEY) === ' · mac');

hosts.bind(KEY, 'windows');
ok('bound back here, it runs here', hosts.runsHere(KEY) === true);
ok('bound back here, it is unmarked again', hosts.markerFor(KEY) === '');

ok('a binding survives being written and read', fs.existsSync(path.join(DATA, 'topic-hosts.json')));

hosts.unbind(KEY);
ok('unbinding forgets it', hosts.hostFor(KEY) === null);

// A remote that calls itself what this machine is called would make "there" and
// "here" the same instruction.
delete require.cache[require.resolve('../lib/hosts')];
process.env.REMOTE_HOSTS = 'windows=amos@somewhere,mac=amos@studio.local';
const again = require('../lib/hosts');
ok('a remote cannot take this machine\'s name', again.sshTargetOf('windows') === null);
ok('the real remote still resolves', again.sshTargetOf('mac') === 'amos@studio.local');

// One machine is not a choice, and nobody should be asked to make it.
delete require.cache[require.resolve('../lib/hosts')];
process.env.REMOTE_HOSTS = '';
const alone = require('../lib/hosts');
ok('with no remotes there is nothing to ask', alone.hasChoice() === false);
ok('with no remotes everything runs here', alone.runsHere('-100123:99') === true);

fs.rmSync(path.join(DATA, 'topic-hosts.json'), { force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

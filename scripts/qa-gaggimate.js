#!/usr/bin/env node
/**
 * QA for the GaggiMate gate — a feature that must disappear for everybody who does not
 * own the hardware, and stay switchable for the one person who does.
 *
 * Two gates, answering different questions:
 *
 *   GAGGIMATE_HOST   is there a machine on this network at all
 *   setting          do I want to look at it right now
 *
 * The first used to not exist. The host fell back to a hard-coded 192.168.1.170 — one
 * person's espresso machine on one person's LAN — so a stranger installing this got a
 * coffee panel in their menu, wired to an address on their own network.
 *
 * The second risk is subtler and is why the aliases are checked here. Settings are set
 * by talking, and an alias with no value after it is answered with a question. Make
 * 'קפה' an alias and "תכין לי קפה" comes back as "להציג את הפאנל?" instead of reaching
 * Claude. A message that is not a settings request has to go through untouched.
 *
 *   node scripts/qa-gaggimate.js
 */

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
};

// Each half needs its own module registry: AVAILABLE is read once, at require time.
function withHost(host, fn) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('gaggimate') || k.includes('settings-nl')) delete require.cache[k];
  }
  if (host) process.env.GAGGIMATE_HOST = host;
  else delete process.env.GAGGIMATE_HOST;
  return fn();
}

console.log('\ngaggimate gate\n');

// ─── no machine configured: the feature does not exist ───────────────────────

withHost(null, () => {
  const gag = require('../lib/commands/gaggimate');
  const nl = require('../lib/commands/settings-nl');

  ok('unset GAGGIMATE_HOST means unavailable', gag.AVAILABLE === false);
  ok('no fallback to anybody\'s LAN address', gag.HOST === '', JSON.stringify(gag.HOST));
  ok('the setting is not offered', !nl.SETTINGS.some(s => s.key === 'gaggimate'));
  ok('a gag: callback is not claimed', gag.handleCallback(null, { data: 'gag:home' }) === false);

  // register() must be a no-op rather than throw, since bot.js calls it unconditionally.
  let threw = null;
  try { gag.register({ onText: () => { throw new Error('registered a command it should not have'); } }, () => true); }
  catch (e) { threw = e.message; }
  ok('register() publishes no command', threw === null, threw);
});

// ─── a machine configured: it exists, and can still be hidden ────────────────

withHost('10.0.0.5', () => {
  const gag = require('../lib/commands/gaggimate');
  const nl = require('../lib/commands/settings-nl');

  ok('set GAGGIMATE_HOST means available', gag.AVAILABLE === true);
  ok('the host is the one configured', gag.HOST === '10.0.0.5', gag.HOST);
  ok('the setting is offered', nl.SETTINGS.some(s => s.key === 'gaggimate'));

  const setting = nl.SETTINGS.find(s => s.key === 'gaggimate');
  ok('shown by default', setting.current({}) === 'on', setting.current({}));

  const state = {};
  setting.apply(state, 'off');
  ok('hiding it sticks on the chat', state.gaggimate === 'off');

  // Said in so many words -> handled as a setting.
  for (const text of ['גאגימייט כבוי', 'gaggimate off', 'תסתיר את הגאגימייט']) {
    const p = nl.parse(text);
    const hit = p.hits.find(h => h.setting.key === 'gaggimate');
    ok(`"${text}" turns it off`,
      nl.shouldHandle(text, p) && hit && hit.value === 'off',
      JSON.stringify(hit && hit.value));
  }

  // Named with no value -> one question, which is the documented behaviour for every
  // setting here, not a special case.
  const asked = nl.parse('גאגימייט');
  ok('named alone, it asks rather than guesses',
    nl.shouldHandle('גאגימייט', asked) && !asked.hits[0].value);

  // The part that must never regress: ordinary sentences about coffee are not settings.
  for (const text of ['תכין לי קפה', 'make me a coffee', 'מה המצב של מכונת הקפה',
                      'כמה קפה שתיתי היום', 'coffee break']) {
    const p = nl.parse(text);
    ok(`"${text}" goes to Claude untouched`, nl.shouldHandle(text, p) === false);
  }

  // And the rest of the registry is undisturbed by the new entry.
  const voice = nl.parse('קול אוטומטי');
  ok('other settings still parse', nl.shouldHandle('קול אוטומטי', voice) &&
    voice.hits[0].setting.key === 'voice' && voice.hits[0].value === 'auto');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

'use strict';

// The layer mapping the skills teach (feat/bias-bg, the owner's chain: chain.js), held so a later edit can't bring a
// contradiction back: the bias (4h + 1h) sets the side, never counter; the setup (15m) is the entry; the entry timing (3m)
// only times it, with no 3m turn, break or confirmation to wait for; the 3m gives no level or target (its swings are for the
// stop only); the stop is compose's; the trail exits. A phrasing that teaches the opposite fails here, in any core skill.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const flat = t => t.replace(/\s+/g, ' ');
const read = s => flat(fs.readFileSync(path.join(ROOT, 'skills', s, 'SKILL.md'), 'utf8'));

// The core skills of the chain, each with the layer it teaches.
const LAYERS = {
  'htf-to-ltf': 'bias, setup, entry timing',
  'top-down-entry': 'bias, setup, entry timing, stop, exit',
  'multi-timeframe-analysis': 'bias',
  'bos-vs-choch': 'setup (structure)',
  cisd: 'setup',
  rejection: 'setup',
  breakout: 'setup',
  compression: 'setup',
  'candle-reading': 'setup candle, entry timing',
  'confluence-counting': 'the count',
  'take-profit': 'exit',
  'trade-lifecycle': 'every layer (the compose steps)',
};

// Phrasings that contradict the chain or never counter, each with what it would teach.
const FORBIDDEN = [
  [/wait (?:for|on) (?:a |the )?(?:3m|trigger timeframe|trigger)\b(?! to)[^.]*?(?:turn|shift|break|bos|choch|confirm)/i, 'a 3m turn to wait for'],
  [/(?:turns?|turned) back with the bias \(a shift, a reclaim\)/i, 'the old wait for the trigger timeframe'],
  [/3m (?:choch|bos)[^.;]*?(?:times the entry|ends the pullback|pullback ended|the pullback ends)/i, 'a 3m break as the setup or the entry'],
  [/a lower-timeframe choch back the htf way/i, 'a lower-timeframe CHoCH as the entry'],
  [/confirmed on 3m or 5m/i, 'a 3m/5m confirmation required'],
  [/target (?:the )?(?:next )?3m\b|3m swing (?:high|low)s? (?:is|are|as) (?:a )?(?:level|target)/i, 'a 3m level or target'],
  [/choch tier|\bD2\b|only as a reversal|reversal strategy may fade|fade it only at/i, 'a counter-trend exception'],
  [/target the first real level|aim for the next swing/i, 'a fixed level target in place of the trail'],
  [/only `?mtf: reversal`? strategies may fade/i, 'a reversal style exempt from the trend rule'],
  [/fade (?:extremes|VAH\/VAL)/i, 'fading a range\'s edges against the side rule'],
  [/small targets/i, 'a fixed small target in place of the trail'],
  // The setup is the entry (the CONF3M study): no confirming 3m close, read or trigger is required before entering.
  [/(?:needs?|requires?|wait(?:s|ing)? for) (?:a |the )?(?:3m |trigger )?(?:trigger|confirming|confirmation) (?:close|read|candle|bar)|no 3m trigger (?:has )?closed yet|entry read (?:is )?not in yet/i, 'a 3m confirming close required before entry'],
];

/** The forbidden phrasings a text holds: [what it teaches, the match]. */
const contradictions = text => FORBIDDEN.map(([re, what]) => [what, (re.exec(text) || [])[0]]).filter(([, m]) => m);

test('layer teaching: no core skill teaches a contradiction of the chain or of never counter', () => {
  for (const s of Object.keys(LAYERS)) assert.deepStrictEqual(contradictions(read(s)), [], s);
});

test('layer teaching: nor any other skill, agent, always-on rule or shipped strategy', () => {
  const docs = [
    ...fs.readdirSync(path.join(ROOT, 'skills')).map(s => `skills/${s}/SKILL.md`),
    ...fs.readdirSync(path.join(ROOT, 'agents')).filter(f => f.endsWith('.md')).map(f => `agents/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'rules', 'trading')).filter(f => f.endsWith('.md')).map(f => `rules/trading/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'strategies')).map(s => `strategies/${s}/STRATEGY.md`),
  ].filter(f => fs.existsSync(path.join(ROOT, f)));
  assert.ok(docs.length > 60, `${docs.length} documents`);
  for (const f of docs) assert.deepStrictEqual(contradictions(flat(fs.readFileSync(path.join(ROOT, f), 'utf8'))), [], f);
});

test('layer teaching: the guard catches each contradiction (each phrasing fails a skill it is put in)', () => {
  const base = read('htf-to-ltf');
  for (const bad of [
    'A rules strategy: wait for the trigger timeframe to turn back with the bias (a shift, a reclaim).',
    'm3 CHoCH up: the 3m choch up ends the pullback.',
    'A 15m rejection confirmed on 3m or 5m is strongest.',
    'Target the next 3m swing high.',
    'A composed entry against the trend needs the CHoCH tier.',
    'Target the first real level at 2:1.',
    'Only `mtf: reversal` strategies may fade it.',
    'Rotation day; fade extremes, small targets.',
    'Inside value: fade VAH/VAL toward the POC.',
    'The 15m setup needs a 3m confirming close before entry.',
    'Pass: no 3m trigger closed yet.',
  ]) assert.notDeepStrictEqual(contradictions(`${base} ${bad}`), [], bad);
});

test('layer teaching: the head trader\'s skills say each layer the one way', () => {
  const { CORE } = require('../../scripts/lib/head-prompt');
  const head = CORE.map(read).join(' ');
  for (const [phrase, layer] of [
    ['The bias (4h + 1h) sets the side', 'bias'],
    ['never counter', 'bias'],
    ['the setup (15m) is the entry', 'setup'],
    ['the 3m only times the entry', 'entry timing'],
    ['no 3m turn to wait for', 'entry timing'],
    ['compose places it one tick beyond the level your stop read names', 'stop'],
    ['the 2R mark that arms the trail, not the exit', 'exit'],
    ['In a prop attempt nothing halves', 'size'],
  ]) assert.ok(head.includes(phrase), `${layer}: ${phrase}`);
  for (const s of Object.keys(LAYERS)) assert.ok(fs.existsSync(path.join(ROOT, 'skills', s, 'SKILL.md')), s);
});

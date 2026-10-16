'use strict';

// The skills' examples write a composed trade's reads after "Reads:", in compose_check's closed forms
// (scripts/lib/trading/composed-reads.js). Each such read must parse as one of those forms: a read the checker can't
// parse (a retired strategy's name, a level form it doesn't have, prose) would teach a read that never verifies.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseRead } = require('../../scripts/lib/trading/composed-reads');

const ROOT = path.resolve(__dirname, '..', '..');
const skills = fs.readdirSync(path.join(ROOT, 'skills')).filter(d => fs.existsSync(path.join(ROOT, 'skills', d, 'SKILL.md')));

/** Every "Reads: a, b, c" list in a skill's Examples, as the reads (a list ends at ". ", ";", " (" or "->"). */
function exampleReads(text) {
  const at = text.indexOf('## Examples');
  if (at < 0) return [];
  const flat = text.slice(at).replace(/\s+/g, ' ');
  const out = [];
  for (const m of flat.matchAll(/Reads: (.+?)(?:\. |;| \(| ->| →|\.$)/g)) out.push(...m[1].split(', ').map(s => s.trim()).filter(Boolean));
  return out;
}

test('example reads: every read a skill example lists parses as one of compose_check\'s forms', () => {
  let n = 0;
  for (const s of skills) {
    for (const r of exampleReads(fs.readFileSync(path.join(ROOT, 'skills', s, 'SKILL.md'), 'utf8'))) {
      n += 1;
      const p = parseRead(r);
      assert.ok(!['unknown', 'ambiguous'].includes(p.kind), `${s}: "${r}" is no read form (${p.kind})`);
    }
  }
  assert.ok(n >= 20, `${n} reads checked`);
  // The check sees what it is for: a strategy's name in a list is no read.
  assert.deepStrictEqual(exampleReads('## Examples\n\nTake: Reads: 1h up, vwap_reclaim long. Priority order -> take.\n').map(r => parseRead(r).kind), ['trend', 'unknown']);
});

// Every read a skill or a role teaches in its text, not only its examples' "Reads:" lists: a backticked read form
// (`15m rejected prior vah up`, `<tf> absorption at <level> up|down`) and a compose_check call's `"read": "..."`. Each must parse: a read form the checker doesn't have would teach a read that never
// verifies. Templates are instantiated (<tf> 15m, <level> prior vah, <price> 21500, <name> hammer) and every
// alternative (`a|b`, `<5m|15m>`) is checked.
const TF = '(?:1m|3m|5m|15m|1h|4h|60m)';
const TF_SLOT = `(?:${TF}|<tf>|<${TF}(?:\\|${TF})*>)`;
const HEAD = new RegExp(`^(?:${TF_SLOT} |at |swept |stop |target |trend (?:long|short) |read (?:long|short) |vwap |value |regime |day type |participation |(?:above|below|inside) prior |in ote$|rejected |broke |touched |volume |absorption |cisd |momentum )`);
const SLOTS = { '<tf>': '15m', '<level>': 'prior vah', '<price>': '21500', '<name>': 'hammer' };
// Spans that start like a read and are none, each with its reason; one that no longer appears fails (the list only shrinks).
const NOT_READS = [
  { file: 'skills/momentum-and-volume/SKILL.md', span: 'momentum up|down', why: 'the briefing\'s candle-line text, beside the read it names (`<tf> momentum up|down`)' },
];

/** Every alternative of a template, its slots filled. */
function instances(text) {
  const s = text.replace(/<tf>|<level>|<price>|<name>/g, m => SLOTS[m]);
  const slot = /<([^<>]*\|[^<>]*)>/.exec(s);
  if (slot) return slot[1].split('|').flatMap(x => instances(s.slice(0, slot.index) + x + s.slice(slot.index + slot[0].length)));
  const w = s.split(' ');
  const i = w.findIndex(x => x.includes('|'));
  return i < 0 ? [s] : w[i].split('|').flatMap(x => instances([...w.slice(0, i), x, ...w.slice(i + 1)].join(' ')));
}

/** The reads a text teaches: [{ span, read }]. A stop or target counts only when it ends on a price (`stop 40 ticks` is a distance). */
function taughtReads(text) {
  const flat = text.replace(/\s*\n\s*/g, ' ');
  const spans = [
    ...[...flat.matchAll(/`([^`]+)`/g)].map(m => m[1].trim()).filter(x => /\s/.test(x) && HEAD.test(x)
      && (!/^(stop|target) /.test(x) || /(?:\s-?\d+(?:\.\d+)?|<price>)$/.test(x))),
    ...[...flat.matchAll(/"read": "([^"]+)"/g)].map(m => m[1]),
  ];
  return spans.flatMap(span => instances(span).map(read => ({ span, read })));
}

test('taught reads: every read form a skill or a role teaches parses as one of compose_check\'s forms', () => {
  const files = [...skills.map(s => `skills/${s}/SKILL.md`), ...fs.readdirSync(path.join(ROOT, 'agents')).filter(f => f.endsWith('.md')).map(f => `agents/${f}`)];
  const bad = [];
  const seen = new Set();
  let n = 0;
  for (const f of files) {
    for (const { span, read } of taughtReads(fs.readFileSync(path.join(ROOT, f), 'utf8'))) {
      if (NOT_READS.some(x => x.file === f && x.span === span)) { seen.add(`${f}|${span}`); continue; }
      n += 1;
      const kind = parseRead(read).kind;
      if (['unknown', 'ambiguous'].includes(kind)) bad.push(`${f}: \`${span}\` (${read}) is no read form (${kind})`);
    }
  }
  assert.deepStrictEqual(bad, []);
  for (const x of NOT_READS) assert.ok(x.why && seen.has(`${x.file}|${x.span}`), `${x.file}: \`${x.span}\` is no longer there: drop it from NOT_READS`);
  assert.ok(n >= 60, `${n} taught reads checked`);
  // The skills the composed bar reads each teach at least one.
  for (const s of ['trade-lifecycle', 'invalidation', 'rejection', 'breakout', 'absorption', 'fair-value-gaps', 'take-profit']) {
    assert.ok(taughtReads(fs.readFileSync(path.join(ROOT, 'skills', s, 'SKILL.md'), 'utf8')).length > 0, s);
  }
  // The check sees what it is for: the forms the skills once taught and the checker never had.
  const caught = t => taughtReads(t).map(r => parseRead(r.read).kind);
  for (const old of ['`volume high`', '`rejected 15m fvg low up`', '`broke 15m fvg low down`', '`4h rejected <level>`', '`stop [<tf>] swing low|high <price>`']) {
    assert.ok(caught(old).length && caught(old).every(k => ['unknown', 'ambiguous'].includes(k)), old);
  }
  assert.deepStrictEqual(caught('`stop 40 ticks`, `<expr> <op> <expr>`, `trend-vs-range`, `m3.cisd.<tf>.confirmedClose`'), []);
  assert.deepStrictEqual(caught('{"step": "setup", "read": "15m rejected prior vah up"}, `3m close top`'), ['close', 'relation']);
});

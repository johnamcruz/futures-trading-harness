'use strict';

// The `displacement` skill (the owner, 2026-11-15: "Make sure displacement skills is clear"; DECISIONS C1 and the
// separation): the owner's framework quoted once as the core definition, his separation in his words, the three rules,
// one term per idea and the same words the briefing prints (displacement.js), worked examples for BOS, CHoCH, CISD, the
// invalidation and the two traps, the fields it names on a real briefing, its homes (the two analysts' index, the cisd
// pointer), and its size at the measured need.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
const D = require('../../scripts/lib/trading/displacement');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const flat = t => t.replace(/\s+/g, ' ');
const TEXT = read('skills/displacement/SKILL.md');
const { data, body } = parseFrontmatter(TEXT);
const F = flat(body.replace(/^> ?/gm, ''));

// Key sentences, each pinned (a changed one fails below).
const PINS = [
  // The owner's framework (2026-11-15), verbatim.
  'Displacement strength is used to assess the quality and conviction of BOS, CHoCH and CISD events. Strong directional displacement increases confidence that the associated structural or delivery shift is meaningful. Displacement against the prevailing trend acts as an early warning of potential weakening or transition. However, displacement alone does not invalidate the prevailing trend. Structural invalidation occurs when the predefined protected swing or invalidation level is breached according to the model\'s confirmation rules.',
  // The owner's separation, verbatim.
  '"Displacement measures strength. Structure determines confirmation. Protected swings determine structural invalidation."',
  // The three rules (C1: a read, never a setup or a wait; the two traps).
  '1. Displacement is a read, never a setup and never a wait. The entry is the setup skill\'s (`breakout`, `top-down-entry`, `pullback-vs-reversal`), unchanged.',
  '2. A big candle that breaks no swing is a candle (`candle-reading`), not a structure change.',
  '3. An FVG marks a past displacement. It does not make the current move displaced; the break\'s own word does.',
  'An invalidating close reads its displacement too: the close decides, displacement tells how strongly. Displacement alone never invalidates.',
  'BOS, CHoCH, CISD and the invalidating close each read strength by this one rule.',
  'For a breakout trade that close is `breakout`\'s failure; the break\'s structure ends only at its protected swing.',
  'By timeframe the break\'s own weight is `bos-vs-choch`\'s (a 3m break is a candle fact; a 15m break is the working structure); its strength reads the same on every timeframe.',
  'a retrace into the gap is observed (`filled to`), never waited for.',
];

test('displacement skill: frontmatter, sections in order, a short description; its size at the measured need', () => {
  assert.strictEqual(data.name, 'displacement');
  assert.ok(String(data.description).length <= 160, `description ${String(data.description).length}`);
  const at = ['## When to Use', '## How It Works', '## Examples'].map(h => TEXT.indexOf(`\n${h}\n`));
  assert.ok(at.every(i => i > 0) && at[0] < at[1] && at[1] < at[2]);
  // 7561 bytes at the measured need (the owner's framework quoted whole, the separation, the line's words, the evidence and
  // eight worked examples; 7320 before the rebase onto #341: the CHoCH read names what a BOS confirms (the transition) and
  // what a close through the old protected level confirms (the reversal), the tie at a protected level, and that the close
  // decides a protected break, not its strength); looked up in index mode, loaded by the two analysts' bodies otherwise.
  assert.ok(Buffer.byteLength(body) <= 7561, `${Buffer.byteLength(body)} bytes`);
});

test('displacement skill: the key sentences are pinned; a changed one fails', () => {
  for (const p of PINS) assert.ok(F.includes(flat(p)), p.slice(0, 80));
  for (const p of PINS) {
    const changed = /\b(never|not|no|alone|each|one|only)\b/.test(p) ? p.replace(/\b(never|not|no|alone|each|one|only)\b/, 'often') : p.replace('strength', 'speed');
    assert.notStrictEqual(changed, p, p.slice(0, 60));
    assert.ok(!F.replace(flat(p), flat(changed)).includes(flat(p)), p.slice(0, 60));
  }
  // The framework is quoted once; the separation stated once.
  assert.strictEqual(F.split('However, displacement alone does not invalidate').length, 2);
  assert.strictEqual(F.split('Displacement measures strength.').length, 2);
});

test('displacement skill: strength words only for displacement; "confirm" belongs to structure; no forecast words', () => {
  // Every "confirm" outside the owner's quoted text is a structure's (a BOS, a CHoCH then BOS, the setup's own reads).
  const own = F.replace(flat(PINS[0]), '').replace(flat(PINS[1]), '').replace('**Displacement — Confirmation and Invalidation Framework.**', '');
  for (const m of own.matchAll(/[^.;:|]*\bconfirm\w*[^.;:|]*/gi)) {
    assert.match(m[0], /BOS|structure|setup's own reads|compose_check|Confirmation before an entry|Confirmed\?/, m[0]);
    assert.doesNotMatch(m[0], /displaced (?:confirms|is confirm)|displacement confirms/i, m[0]);
  }
  assert.doesNotMatch(own, /\b(?:will|likely|expect(?:s|ed)?|probably|tends? to)\b/i, 'present tense: a read, never a forecast');
  assert.doesNotMatch(own, /\bunless\b|\bexcept\b/i, 'no unless / except chains');
});

test('displacement skill: the line\'s words are the code\'s (displacement.js prints them), one term per idea', () => {
  // The weak reasons, the status words, the FVG states and the invalidating close, as breakLine prints them.
  const why = ['opposite colour', 'wicks', 'closed mid', 'small'];
  for (const w of why) assert.ok(F.includes(`\`${w}\``) || F.includes(`${w}\``), w);
  const brk = (q, extra = {}) => ({ kind: 'BOS', direction: 'up', level: 1, barsAgo: 0, ...extra, quality: { displaced: true, why: [], cleared: 0.5, bodyX: null, leg: null, origin: { side: 'low', price: 0.5, at: 'x', sweep: null }, fvg: null, fvgPending: false, status: { holding: true }, ...q } });
  const line = (q, extra) => D.breakLine({ entry: { tf: '3m', brk: brk(q, extra), minutes: 3 } });
  const printed = [
    line({}),
    line({ displaced: false, why }),
    line({ status: { closedBack: { at: 'x', barsAgo: 0 } } }),
    line({ fvg: { low: 1, high: 2, state: 'open' } }), line({ fvg: { low: 1, high: 2, state: 'filled to', to: 1.5 } }), line({ fvg: { low: 1, high: 2, state: 'filled' } }), line({ fvgPending: true }),
    line({}, { protected: { side: 'low', level: 0.5, brokenAt: 'x', quality: { displaced: true, why: [], barsAgo: 0 } } }),
    line({}, { protected: { side: 'low', level: 0.5, brokenAt: 'x', quality: { displaced: false, why: ['wicks'], barsAgo: 0 } } }),
    line({}, { protected: { side: 'low', level: 0.5, brokenAt: 'x', quality: { tie: true } } }),
  ].join('\n');
  for (const w of ['displaced', 'weak (', 'holding', 'closed back below', 'cleared', 'FVG', 'open', 'filled to', 'traded through', 'no FVG yet', 'no FVG', 'from protected low', 'holds', 'holds (tested, a tie)', 'broken by a displaced close', 'broken by a weak close']) {
    assert.ok(printed.includes(w), `the code prints ${w}`);
    assert.ok(F.includes(w), `the skill names ${w}`);
  }
  // The skill's example line is the code's shape.
  assert.ok(F.includes('Break quality (strength, not a forecast; `displacement`): 3m BOS up 21412.25 6 min ago: displaced, holding; cleared 0.6 ATR; FVG 21405.5-21409 open; from protected low 21380.5 (a sweep of overnight low 21381): holds; body 2.1x prior; leg 4 bars, efficiency 0.74, overlap 0.31.'));
  assert.ok(D.breakLine({ entry: { tf: '3m', brk: brk({ cleared: 0.6, bodyX: 2.1, leg: { bars: 4, eff: 0.74, overlap: 0.31 }, fvg: { low: 21405.5, high: 21409, state: 'open' }, origin: { side: 'low', price: 21380.5, sweep: { name: 'overnight low', price: 21381 } } }, { level: 21412.25, barsAgo: 2 }), minutes: 3 } }).startsWith('- Break quality (strength, not a forecast; `displacement`): 3m BOS up 21412.25 6 min ago: displaced, holding; cleared 0.6 ATR; FVG 21405.5-21409 open; from protected low 21380.5 (a sweep of overnight low 21381): holds; body 2.1x prior; leg 4 bars, efficiency 0.74, overlap 0.31.'), 'the skill\'s example is the code\'s line');
  // One term per idea: never "strong" for a break (the CISD line's `strong` is named as the same word), never "retraced"
  // for a gap state, never "confirmed" beside displaced.
  assert.doesNotMatch(F.replace(/the CISD line's `strong` is `displaced`/i, '').replace(/`strong` CISD/g, '').replace(/A CISD prints `strong` or `weak`/, ''), /`strong`/);
  assert.doesNotMatch(F, /`retraced`/);
  assert.doesNotMatch(F.replace(flat(PINS[0]), ''), /\bstrong (?:break|BOS|CHoCH)\b/i, 'a break is displaced, never strong');
});

test('displacement skill: worked examples for BOS, CHoCH, CISD, the invalidation, a close back and the two traps', () => {
  const ex = body.slice(body.indexOf('## Examples'));
  for (const k of ['BOS:', 'Weak BOS:', 'CHoCH:', 'CISD:', 'Invalidation:', 'Closed back:', 'Trap 1:', 'Trap 2:']) assert.match(ex, new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'), k);
  for (const m of ex.matchAll(/\b(\d{5}(?:\.\d+)?)\b/g)) assert.ok(Number.isInteger(Number(m[1]) / 0.25), `${m[1]} on the 0.25 tick`);
  assert.doesNotMatch(ex, /\b(?:wait|waits|waiting)\b/i, 'no example waits');
});

test('displacement skill: every briefing field it names resolves on a briefing built by briefing.js', () => {
  const B = require('../../scripts/lib/trading/briefing');
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const bars = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'));
  const b = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3 });
  const paths = [...new Set([...body.matchAll(/\b((?:m3|m15)(?:\.[A-Za-z][A-Za-z0-9]*)+)/g)].map(m => m[1]))];
  assert.ok(paths.length >= 2, paths.join(', '));
  for (const p of paths) {
    const [root, ...rest] = p.split('.');
    let at = b.sections[root].data;
    for (const k of rest) { assert.ok(at && Object.prototype.hasOwnProperty.call(at, k), `${p} at ${k}`); at = at[k]; }
  }
});

test('displacement skill: indexed by the two analysts (core or index, and their load sentence), pointed to by cisd; the head trader looks it up', () => {
  for (const role of ['market-structure-analyst', 'trend-momentum-analyst']) {
    const a = parseFrontmatter(read(`agents/${role}.md`));
    assert.ok([...(a.data['role-skills'] || []), ...(a.data['role-index'] || [])].includes('displacement'), role);
    assert.match(flat(a.body), /Load the skills [^.]*`displacement`/, role);
  }
  assert.match(flat(read('skills/cisd/SKILL.md')), /Strong: the `displacement` skill's one rule, the same as a break's displaced\./);
  // The head trader's catalog (workspace/AGENTS.md) lists it, so skill_lookup finds it; the gate never requires it.
  assert.match(read('workspace/AGENTS.md'), /`displacement`|\bdisplacement\b: /);
  const { SITUATIONAL } = require('../../scripts/lib/trading/skills-loaded');
  assert.ok(!JSON.stringify(SITUATIONAL).includes('"displacement"'), 'no gate requirement reads the read');
});

test('the separation in print: no Market state or Break quality line, on every golden, says displacement confirms (strength only; structure confirms)', () => {
  const dir = path.join(ROOT, 'tests', 'fixtures', 'golden');
  const lines = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n'))
    .filter(l => /Market state \(|Break quality \(/.test(l));
  assert.ok(lines.some(l => /Break quality \(/.test(l)) && lines.some(l => /Market state \(/.test(l)), 'both lines are in the goldens');
  // A clause (between , ; and :, its parentheses kept: `(displaced) (confirmed)` is one clause) naming displacement and
  // confirmation together breaks the separation.
  for (const l of lines) for (const c of l.split(/[,;:]/)) assert.doesNotMatch(c, /displac\w*.*\bconfirm|\bconfirm\w*.*displac/i, `${c} (in: ${l.slice(0, 160)})`);
  for (const bad of ['3m BOS up 6 min ago (displaced) (confirmed)', 'displaced (confirmed)']) assert.ok(bad.split(/[,;:]/).some(c => /displac\w*.*\bconfirm|\bconfirm\w*.*displac/i.test(c)), bad);
  assert.doesNotMatch(D.breakLine({ entry: { tf: '3m', brk: { kind: 'CHoCH', direction: 'down', level: 2, barsAgo: 0, quality: { displaced: true, why: [], cleared: 1, bodyX: 2, leg: null, origin: null, fvg: null, fvgPending: false, status: { holding: true } } }, minutes: 3 } }), /confirm/i);
});

'use strict';

// The take-profit skill: one responsibility (where to take profit: the target kinds, their timeframe weight, the room in
// R), its structure and size, every briefing field it names resolving on a briefing built by briefing.js, examples that
// are tick-correct (MNQ: 0.25 tick, $0.50 a tick), pointers (never restatements) to the skills that own exits and
// management, and its reach: the head trader's index line (no existing skill edited), on no role's list (a list
// would grow a pinned role prompt; that needs the owner's OK).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const flat = t => t.replace(/\s+/g, ' ');
const FILE = 'skills/take-profit/SKILL.md';

test('take-profit: frontmatter, the sections in order, a short "Use when" description, small', () => {
  const text = read(FILE);
  const { data, body } = parseFrontmatter(text);
  assert.strictEqual(data.name, 'take-profit');
  assert.match(data.description, /^Use when choosing where to take profit/);
  assert.ok(data.description.length <= 160, `description ${data.description.length}`);
  const at = ['## When to Use', '## How It Works', '## Examples'].map(h => text.indexOf(`\n${h}\n`));
  assert.ok(at.every(i => i > 0) && at[0] < at[1] && at[1] < at[2]);
  assert.ok(Buffer.byteLength(body) <= 3400, `${Buffer.byteLength(body)} bytes`);
});

test('take-profit: the target kinds, their weight by timeframe, the room in R; causal; a read, never a fixed combination', () => {
  const t = flat(read(FILE));
  for (const pin of [
    '**Pivot highs and lows**: the next untaken confirmed swing per timeframe, `m3.swingTargets.above` and `m3.swingTargets.below`',
    '**The prior 1h and 4h candle\'s high, low and midpoint**: `m3.rangeTargets`',
    'A side the candle forming has already taken (`taken`) is spent as a target; the far side remains.',
    '**Fair value gap edges**: the near edge of an open gap ahead of price; a partly filled gap, its unfilled part only (`fair-value-gaps`).',
    // The trail exits (feat/bias-bg): a level read only off the side rule's sides, outside a prop attempt.
    '`target trail` (the 2R mark arms it), every entry the side rule gives; a level ahead is context, never a requirement.',
    '`target <tf> swing high|low <price>`, `target prior 1h|4h high|mid|low <price>` (a taken side reads false), `target <15m|1h> fvg high|low <price>`; none named: `target 2r`.',
    'its midpoint moves until it closes, so it is a target only once completed.',
    '**Timeframe weight** (hypothesis, not measured)',
    'The briefing\'s `R` is against the reference stop (`m3.oneR`).',
    'a target\'s R is its points over the stop\'s points.',
    'never a veto: the priority order (strategy-library) decides take, skip and size.',
  ]) assert.ok(t.includes(pin), pin);
  // Partials, runners and the exit are pointed to, never restated.
  for (const s of ['manage-position', 'invalidation', 'trade-plan', 'levels-and-reactions', 'fair-value-gaps']) {
    assert.ok(t.includes(`\`${s}\``), s);
    assert.ok(fs.existsSync(path.join(ROOT, 'skills', s, 'SKILL.md')), s);
  }
  assert.doesNotMatch(t, /trailActivateR|trailGivebackR|move the stop to (break-?even|entry)/i, 'management rules belong to manage-position');
  // No strategy pairs a target with a setup here.
  for (const name of fs.readdirSync(path.join(ROOT, 'strategies')).filter(n => !n.startsWith('_') && !n.includes('.'))) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(t), `names the strategy ${name}`);
  }
});

test('take-profit: every briefing field it names resolves on a briefing built by briefing.js', () => {
  const B = require('../../scripts/lib/trading/briefing');
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const { defaultRoundSteps } = require('../../scripts/lib/trading/round-numbers');
  const bars = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv')).slice(0, 1400);
  const scan = [{ name: 'orb', candidate: true, direction: 'long', status: 'active', confluence: { with: [], against: [] }, entryRef: 1, stopDistance: 10, minRR: 2, exit: { trailActivateR: 2 }, mtf: { style: 'trend', longAllowed: true } }];
  const b = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3, roundSteps: defaultRoundSteps(), scan });
  const d = b.sections.m3.data;
  const paths = [...new Set([...read(FILE).matchAll(/\b((?:m3|candidate)(?:\.[A-Za-z][A-Za-z0-9]*)+)/g)].map(m => m[1]))];
  assert.ok(paths.length >= 4, paths.join(', '));
  for (const p of paths) {
    const [root, ...rest] = p.split('.');
    let at = root === 'm3' ? d : d.candidates[0];
    for (const k of rest) { assert.ok(at && Object.prototype.hasOwnProperty.call(at, k), p); at = at[k]; }
  }
  // The per-level fields it names: frame, price, points, ticks, R on a swing; side, points, ticks, R on a range level.
  for (const k of ['frame', 'price', 'points', 'ticks', 'R']) assert.ok(k in [...d.swingTargets.above, ...d.swingTargets.below][0], k);
  for (const k of ['high', 'mid', 'low']) for (const f of ['side', 'points', 'ticks', 'R']) assert.ok(f in d.rangeTargets['1h'][k], `${k}.${f}`);
});

test('take-profit: the examples are tick-correct (MNQ 0.25 tick, $0.50 a tick; R = target points over stop points)', () => {
  const ex = read(FILE).slice(read(FILE).indexOf('## Examples'));
  const blocks = ex.split(/\n\n/).filter(x => /(Long|Short) \d/.test(x));
  assert.strictEqual(blocks.length, 3);
  let targets = 0;
  for (const block of blocks) {
    const [, side, e, s, pts, ticks, usd] = block.match(/(Long|Short) (\d+\.\d\d), stop (\d+\.\d\d) \((\d+\.\d\d) pts = (\d+) ticks, \$(\d+\.\d\d) per MNQ\)/);
    const [E, S, P] = [e, s, pts].map(Number);
    assert.strictEqual(side === 'Long' ? E - S : S - E, P, block);
    assert.strictEqual(P / 0.25, Number(ticks));
    assert.strictEqual(Number(ticks) * 0.5, Number(usd));
    for (const m of block.matchAll(/(\d{5}\.\d\d)(?::| =) (\d+\.\d\d) pts = (\d+) ticks, \$(\d+\.\d\d), (\d+\.\d\d)R/g)) {
      const [, x, q, tq, dq, r] = m;
      const X = Number(x);
      assert.ok(Number.isInteger(X / 0.25), `${x} on the tick`);
      assert.strictEqual(side === 'Long' ? X - E : E - X, Number(q), m[0]);
      assert.strictEqual(Number(q) / 0.25, Number(tq), m[0]);
      assert.strictEqual(Number(tq) * 0.5, Number(dq), m[0]);
      assert.strictEqual(Math.round((Number(q) / P) * 100) / 100, Number(r), m[0]);
      targets += 1;
    }
    // Every 2-decimal price is on the tick; a midpoint between ticks is written with 3 decimals and rounded toward the entry.
    for (const m of block.matchAll(/\b(\d{5}\.\d\d)\b(?!\d)/g)) assert.ok(Number.isInteger(Number(m[1]) / 0.25), m[1]);
  }
  assert.ok(targets >= 5, `${targets} targets checked`);
  // The off-tick midpoint: (21580.00 + 21540.25) / 2 = 21560.125, rounded toward a long's entry to 21560.00.
  assert.strictEqual((21580 + 21540.25) / 2, 21560.125);
  assert.ok(flat(ex).includes('mid 21560.125, between ticks; toward the entry: 21560.00'));
});

test('take-profit: reached by the head trader\'s index line; on no role\'s list until the owner approves the prompt growth', () => {
  assert.match(read('workspace/AGENTS.md'), /^- `take-profit` \(skills\/take-profit\/SKILL\.md\): Use when /m);
  for (const f of fs.readdirSync(path.join(ROOT, 'agents'))) {
    const d = parseFrontmatter(read(`agents/${f}`)).data;
    assert.ok(![...(d['role-skills'] || []), ...(d['role-index'] || [])].includes('take-profit'), f);
  }
});

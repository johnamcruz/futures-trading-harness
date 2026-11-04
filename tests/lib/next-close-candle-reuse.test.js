'use strict';

// The prepare's "Possible at the next close" reads candles only through the candle reading (the owner's rule: no
// reinvented candle logic): its trigger words, its break search bound, its forming setup-frame candle and its momentum
// third come from candle-facts.js and momentum.js, one source. The characterization pins below were captured from the
// code before the refactor (PR A3) and must never move: the briefing and every prepared section stay byte-identical.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');
const NC = require('../../scripts/lib/trading/next-close');
const CF = require('../../scripts/lib/trading/candle-facts');

const TICK = 0.25;
const AT = '2021-05-24T13:42:00.000Z';
const sha = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');

/** A reaction candidate as reactionCandidates builds it (only the fields possibleLines reads). */
const reaction = ({ rel, dir, name = 'prior RTH high', price = 100, close, tradedBeyond = false, extreme = null }) => ({
  id: 'P1', kind: 'reaction', name, price, side: dir === 'up' ? 'long' : 'short', dir, tf: '15m', rel, read: `15m ${rel} ${name} ${dir}`,
  trigger: { at: AT, rel, dir, level: price, candle: { t: '2021-05-24T13:30:00.000Z', o: 99, h: 100.5, l: 98.75 }, prevClose: null, close,
    ...(rel === 'broke' ? { closeOp: dir === 'up' ? '>=' : '<=' } : { closeOp: dir === 'down' ? '<=' : '>=', extreme, extremeOp: dir === 'down' ? '>=' : '<=', tradedBeyond }) },
  preconditions: [], rule: { entry: 'E', stop: 'S', target: 'T' },
  threshold: { bar: { o: 99, h: 100.5, l: 98.75, c: close }, reads: [], plan: { status: 'refused', why: 'w' } },
});
const section = candidates => ({ symbol: 'MNQ', minutes: 3, closedAt: '2021-05-24T13:42:00.000Z', next: { t: AT, closedAt: '2021-05-24T13:45:00.000Z' }, none: null, candidates });
const lineOf = c => NC.possibleLines(section([c]))[1];

const CASES = {
  brokeUp: reaction({ rel: 'broke', dir: 'up', close: 101.25 }),
  brokeDown: reaction({ rel: 'broke', dir: 'down', close: 98.75 }),
  brokeNamedPrice: reaction({ rel: 'broke', dir: 'up', name: '15m swing high 100', close: 101.25 }),
  rejectedDownToTrade: reaction({ rel: 'rejected', dir: 'down', close: 99.75, extreme: 100.25 }),
  rejectedDownTraded: reaction({ rel: 'rejected', dir: 'down', close: 99.75, tradedBeyond: true }),
  rejectedUpToTrade: reaction({ rel: 'rejected', dir: 'up', close: 100.25, extreme: 99.75 }),
  rejectedUpTradedNamedPrice: reaction({ rel: 'rejected', dir: 'up', name: '15m swing low 100', close: 100.25, tradedBeyond: true }),
};

// Captured from the code before the refactor (the trigger words after "fires if ").
const TEXT = {
  brokeUp: 'the 15m candle (opened 09:30, open 99, so far high 100.5 low 98.75) closes at or above 101.25: beyond prior RTH high 100 with most of its body beyond',
  brokeDown: 'the 15m candle (opened 09:30, open 99, so far high 100.5 low 98.75) closes at or below 98.75: beyond prior RTH high 100 with most of its body beyond',
  brokeNamedPrice: 'the 15m candle (opened 09:30, open 99, so far high 100.5 low 98.75) closes at or above 101.25: beyond 15m swing high 100 with most of its body beyond',
  rejectedDownToTrade: 'the 15m candle (opened 09:30, open 99, so far high 100.5 low 98.75) trades at or above 100.25 and closes at or below 99.75: back below prior RTH high 100',
  rejectedDownTraded: 'the 15m candle (opened 09:30, open 99, so far high 100.5 low 98.75) has traded above it already and closes at or below 99.75: back below prior RTH high 100',
  rejectedUpToTrade: 'the 15m candle (opened 09:30, open 99, so far high 100.5 low 98.75) trades at or below 99.75 and closes at or above 100.25: back above prior RTH high 100',
  rejectedUpTradedNamedPrice: 'the 15m candle (opened 09:30, open 99, so far high 100.5 low 98.75) has traded below it already and closes at or above 100.25: back above 15m swing low 100',
};
const triggerWords = c => { const l = lineOf(c); return l.slice(l.indexOf(': fires if ') + ': fires if '.length, l.indexOf('. Plan (code)')); };

test('next close candle reuse: the reaction trigger words are byte-identical to the code before the refactor (every rel, dir and name form)', () => {
  for (const [k, c] of Object.entries(CASES)) assert.strictEqual(triggerWords(c), TEXT[k], k);
});

test('next close candle reuse: the briefing\'s relation words (RELATION_TEXT) are unchanged', () => {
  assert.strictEqual(JSON.stringify(CF.RELATION_TEXT), JSON.stringify({ rejected: { up: 'rejected: closed back above', down: 'rejected: closed back below' }, broke: { up: 'broke above', down: 'broke below' } }));
});

/** The grid the bound, the forming candle and the trigger are pinned on: forming candles, levels, previous closes. */
function grid() {
  const forms = [];
  for (const o of [100, 100.25, 101]) for (const h of [101, 102.5]) for (const l of [98.5, 99.75]) if (h >= o && l <= o) forms.push({ t: '2021-05-24T13:30:00.000Z', o, h, l });
  const levels = [98, 98.5, 99.75, 100, 100.25, 101, 102.5, 103];
  const prevs = [NaN, 99, 100, 101.5];
  const kinds = [];
  const met = [];
  for (const f of forms) for (const L of levels) for (const pc of prevs) {
    const ks = NC.reactionKinds(f, L, pc, TICK);
    kinds.push(ks.map(k => ({ rel: k.rel, dir: k.dir, facts: k.facts, bars: [99, 100, 101.5].map(o => k.bar(o)) })));
    for (const k of ks) {
      const cand = { kind: 'reaction', trigger: { at: AT, rel: k.rel, dir: k.dir, level: L, candle: f, prevClose: Number.isFinite(pc) ? pc : null } };
      for (const h of [100, 101.25, 103.5]) for (const lo of [97.5, 99.5, 100]) for (const c of [97.5, 99.75, 100.25, 101.25, 103.5]) if (lo <= c && c <= h) met.push(NC.triggerMet(cand, { t: AT, h, l: lo, c }) ? 1 : 0);
    }
  }
  return { kinds, met };
}

test('next close candle reuse: reactionKinds and triggerMet over a grid are unchanged (the break bound, the rejection, the final candle)', () => {
  const { kinds, met } = grid();
  assert.deepStrictEqual([kinds.length, kinds.flat().length, met.length, met.filter(Boolean).length], [384, 736, 17664, 4644]);
  assert.strictEqual(sha(kinds), '89df4be120521c894f2f82a081f176e6816b56a515a128a8a751a077c9c2a76d');
  assert.strictEqual(sha(met), '097b5332314a32bcd1abeb07cd6a0066723e326d5c607eb766e270b2f301bb73');
});

test('next close candle reuse: a far break (the open far behind the level) is found at its least close, and only by relation\'s rule', () => {
  // From 90 to a level at 100: a break up needs (90 + c) / 2 > 100, so c > 110: the least tick close is 110.25.
  const f = { t: '2021-05-24T13:30:00.000Z', o: 90, h: 99, l: 89 };
  const up = NC.reactionKinds(f, 100, NaN, TICK).find(k => k.rel === 'broke' && k.dir === 'up');
  assert.strictEqual(JSON.stringify(up.facts), JSON.stringify({ close: 110.25, closeOp: '>=' }));
  const g = { t: '2021-05-24T13:30:00.000Z', o: 110, h: 111, l: 101 };
  const down = NC.reactionKinds(g, 100, NaN, TICK).find(k => k.rel === 'broke' && k.dir === 'down');
  assert.strictEqual(JSON.stringify(down.facts), JSON.stringify({ close: 89.75, closeOp: '<=' }));
});

// The real fixture: the reactions prepared at a 15m close (their forming candle `trigger.candle` from its sub-bars) and
// the momentum candidate (its third), as stored and as rendered: byte-identical.
const FX = require('../fixtures/momentum-continuation');
const B = require('../../scripts/lib/trading/briefing');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');

test('next close candle reuse: the sections prepared on the fixture are byte-identical (stored candidates and rendered lines)', () => {
  const REG = loadStrategies(path.resolve(__dirname, '..', '..'), {}).strategies;
  const BARS = FX.load();
  const out = [];
  for (const t of ['2021-05-24T13:39:00.000Z', '2021-05-20T13:39:00.000Z']) {
    const i = BARS.findIndex(b => b.t === t);
    const bars = BARS.slice(0, i + 1);
    const sec = NC.possibleAtNextClose({ symbol: 'MNQ', bars, minutes: 3, briefing: B.buildBriefing({ symbol: 'MNQ', bars, minutes: 3, scan: [] }), flat: true, registry: REG });
    out.push({ t, kinds: sec.candidates.map(c => c.kind), candles: sec.candidates.filter(c => c.kind === 'reaction').map(c => JSON.stringify(c.trigger.candle)), thirds: sec.candidates.filter(c => c.kind === 'momentum').map(c => c.trigger.third), json: sha(JSON.stringify(sec)), lines: sha(NC.possibleLines(sec)) });
  }
  assert.deepStrictEqual(out, [
    { t: '2021-05-24T13:39:00.000Z', kinds: ['momentum', 'reaction', 'reaction', 'reaction', 'reaction', 'reaction'], candles: Array(5).fill('{"t":"2021-05-24T13:30:00.000Z","o":16845.25,"h":16916,"l":16829.75}'), thirds: ['top'], json: 'a4034957b309ec4c2bb62ecb87845825abcde07c15c8545b18cbe3d271f6cf5b', lines: '80df13d675fa91c1575f0457a6347ab2f79aaaeab2f0819383e9b2c117fd155e' },
    { t: '2021-05-20T13:39:00.000Z', kinds: ['momentum', 'reaction', 'reaction'], candles: Array(2).fill('{"t":"2021-05-20T13:30:00.000Z","o":16628.25,"h":16718,"l":16617.5}'), thirds: ['bottom'], json: '4967a66b8a67445017536504a548bc3576413bdbfa66f2f16dfd401089a46702', lines: 'd1307abbe98ea349d36914ece9a6220893a7609b2f8cf0ff595071950860bac4' },
  ]);
});


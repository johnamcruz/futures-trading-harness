'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { fieldPaths, carries, fieldCoverage, missingBarFields, describeMissing, describeCoverage } = require('../../scripts/lib/backtest/bar-fields');

const strategy = (name, rules, extra = {}) => ({ name, rules, ...extra });

test('fieldPaths: every field() path a strategy reads, in its rules, nested groups, stop and target; none for plain rules', () => {
  const s = strategy('s', { long: ['close > open', { any: ['field("a.b") >= 1', { all: ['field( "c" )[1] < 0'] }] }], short: ['field("a.b") <= -1'] },
    { risk: { stop: { long: 'field("d.e") * 2' } }, exit: { target: { long: 'close - field("f")' } } });
  assert.deepStrictEqual(fieldPaths(s), ['a.b', 'c', 'd.e', 'f']);
  assert.deepStrictEqual(fieldPaths(strategy('plain', { long: ['close > open'] })), []);
  // Single quotes, as the rules tokenizer accepts them; a mixed pair is not a field() path.
  assert.deepStrictEqual(fieldPaths(strategy('sq', { long: ["field('g.h') > 0", 'field("i\') > 0'] })), ['g.h']);
  assert.deepStrictEqual(fieldPaths(null), []);
});

test('carries: what the rules can read (rules.js readField): a finite number or a boolean, on own properties only', () => {
  assert.ok(carries({ a: { b: 0 } }, 'a.b'));
  assert.ok(carries({ a: { b: false } }, 'a.b'), 'a boolean reads as 0 or 1');
  assert.ok(carries({ a: { b: true } }, 'a.b'));
  for (const bar of [{}, { a: null }, { a: { b: null } }, { a: { b: '1' } }, { a: { b: NaN } }, { a: 5 }, { a: Object.create({ b: 1 }) }]) assert.ok(!carries(bar, 'a.b'), JSON.stringify(bar));
  assert.ok(!carries({ a: {} }, 'a.constructor'), 'an inherited property is not on the bar');
  // The same verdict as the rules' own reader, on every case.
  const { readField } = require('../../scripts/lib/trading/rules');
  for (const bar of [{ a: { b: 2 } }, { a: { b: true } }, { a: { b: '2' } }, { a: Object.create({ b: 1 }) }]) assert.strictEqual(carries(bar, 'a.b'), !Number.isNaN(readField(bar, 'a.b')));
});

test('missingBarFields: names the strategy, the path, and each market it trades whose bars never carry it', () => {
  const s = strategy('reader', { long: ['field("a.b") > 0'] });
  const plain = strategy('plain', { long: ['close > open'] });
  const markets = [
    { symbol: 'MNQ', bars: [{ c: 1 }, { c: 2 }] },
    { symbol: 'MES', bars: [{ c: 1 }, { c: 2, a: { b: 3 } }] },
    { symbol: 'MYM', bars: [{ c: 1 }] },
  ];
  const cov = (bars, carried) => ({ bars, carried, share: bars ? Math.floor((carried / bars) * 10000) / 10000 : 0 });
  assert.deepStrictEqual(missingBarFields([s, plain], markets), [{ strategy: 'reader', path: 'a.b', coverage: { MNQ: cov(2, 0), MES: cov(2, 1), MYM: cov(1, 0) }, symbols: ['MNQ', 'MES', 'MYM'] }]);
  // Only the markets it trades.
  assert.deepStrictEqual(missingBarFields([s], markets, (x, sym) => sym === 'MNQ'), [{ strategy: 'reader', path: 'a.b', coverage: { MNQ: cov(2, 0) }, symbols: ['MNQ'] }]);
  assert.deepStrictEqual(missingBarFields([s], [{ symbol: 'MES', bars: [{ a: { b: 1 } }, { a: { b: 0 } }] }]), [], 'every bar carries it: nothing to say');
  assert.match(describeMissing({ strategy: 'reader', path: 'a.b', symbols: ['MNQ'] }), /^reader reads field\("a\.b"\), which no MNQ bar in this data carries: .*differently from live and replay/);
});

test('fieldCoverage: the share of each traded market\'s bars (from `from`) carrying a non-null value; a null counts as missing', () => {
  const s = strategy('reader', { long: ['field("x.y.z") > 0'] });
  const t = k => new Date(Date.UTC(2026, 0, 5, 15, k * 3)).toISOString();
  // 6 bars: the last 2 null (a span past the broker's data for the field), the first one before `from`.
  const bars = [0, 1, 2, 3, 4, 5].map(k => ({ t: t(k), c: 1, x: { y: { z: k < 4 ? k - 1 : null } } }));
  const all = fieldCoverage([s, strategy('plain', { long: ['close > open'] })], [{ symbol: 'MNQ', bars }]);
  assert.deepStrictEqual(all, [{ strategy: 'reader', path: 'x.y.z', coverage: { MNQ: { bars: 6, carried: 4, share: 0.6666 } }, symbols: ['MNQ'] }]);
  const from = fieldCoverage([s], [{ symbol: 'MNQ', bars }], undefined, { from: Date.parse(t(1)) });
  assert.deepStrictEqual(from[0].coverage.MNQ, { bars: 5, carried: 3, share: 0.6 });
  assert.match(describeMissing(from[0]), /^reader reads field\("x\.y\.z"\), which only 60% of the MNQ bars \(3 of 5\) in this data carry: its conditions on it are false on the others/);
  assert.strictEqual(describeCoverage(from[0]), 'reader field("x.y.z") on MNQ: 60% of 5 bars');
  // Every bar: 100%, listed in the coverage but not missing.
  const full = fieldCoverage([s], [{ symbol: 'MNQ', bars: bars.slice(0, 4) }]);
  assert.deepStrictEqual([full[0].coverage.MNQ.share, full[0].symbols], [1, []]);
  // 999 of 1000 bars: never rounded up to 100%.
  const many = Array.from({ length: 1000 }, (_, k) => ({ t: t(k), x: { y: { z: k ? 1 : null } } }));
  const m = fieldCoverage([s], [{ symbol: 'MNQ', bars: many }])[0];
  assert.deepStrictEqual([m.coverage.MNQ.share, m.symbols], [0.999, ['MNQ']]);
  assert.match(describeCoverage({ ...m, coverage: { MNQ: { bars: 10000, carried: 9999 } } }), /99\.9% of 10000 bars/);
  // A market with no bars in range is missing it; one the strategy doesn't trade is not listed.
  assert.deepStrictEqual(fieldCoverage([s], [{ symbol: 'MNQ', bars: [] }, { symbol: 'GC', bars }], (x, sym) => sym === 'MNQ')[0].symbols, ['MNQ']);
  assert.match(describeMissing({ strategy: 'r', path: 'p', symbols: ['MNQ', 'MES'], coverage: { MNQ: { bars: 2, carried: 0 }, MES: { bars: 4, carried: 1 } } }), /which no MNQ bar and only 25% of the MES bars \(1 of 4\) in this data carry:/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { fieldPaths, carries, missingBarFields, describeMissing } = require('../../scripts/lib/backtest/bar-fields');

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
  assert.deepStrictEqual(missingBarFields([s, plain], markets), [{ strategy: 'reader', path: 'a.b', symbols: ['MNQ', 'MYM'] }]);
  // Only the markets it trades.
  assert.deepStrictEqual(missingBarFields([s], markets, (x, sym) => sym !== 'MYM'), [{ strategy: 'reader', path: 'a.b', symbols: ['MNQ'] }]);
  assert.deepStrictEqual(missingBarFields([s], markets.slice(1, 2)), [], 'bars that carry it: nothing to say');
  assert.match(describeMissing({ strategy: 'reader', path: 'a.b', symbols: ['MNQ'] }), /^reader reads field\("a\.b"\), which no MNQ bar in this data carries: .*differently from live and replay/);
});

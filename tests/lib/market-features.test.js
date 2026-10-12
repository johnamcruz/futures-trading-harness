'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { marketFeatures } = require('../../scripts/lib/trading/market-features');
const { normalizeBars } = require('../../scripts/lib/trading/indicators');

function fixtureBars() {
  const csv = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'), 'utf8').trim().split('\n').slice(1);
  return normalizeBars(csv.map(l => {
    const [t, o, h, lo, c, v] = l.split(',');
    return { t: new Date(t.replace(' ', 'T')).toISOString(), o: +o, h: +h, l: +lo, c: +c, v: +v };
  }));
}

const same = (a, b) => (Number.isNaN(a) && Number.isNaN(b)) || a === b;

test('market features are causal: the full series at bar i equals the features of bars 0..i', () => {
  const bars = fixtureBars();
  const full = marketFeatures(bars);
  for (const i of [300, 700, 1100, bars.length - 1]) {
    const part = marketFeatures(bars.slice(0, i + 1));
    for (const k of ['atr20', 'atr100', 'adx', 'vwapRth', 'vwapSession']) assert.ok(same(part[k][i], full[k][i]), `${k} at bar ${i}: ${part[k][i]} vs ${full[k][i]}`);
    for (const m of [240, 60, 15]) assert.ok(same(part.mtf[m][i], full.mtf[m][i]), `mtf ${m} at bar ${i}`);
    for (const k of ['vah', 'val', 'poc']) assert.ok(same(part.profile[k][i], full.profile[k][i]), `profile ${k} at bar ${i}`);
  }
});

test('market features: ATR(20), ATR(100) and ADX(14) settle on a long series; the prior RTH profile exists after a full RTH day', () => {
  const bars = fixtureBars();
  const f = marketFeatures(bars);
  const i = 1100;
  assert.ok(f.atr20[i] > 0 && f.atr100[i] > 0, 'ATRs');
  assert.ok(f.adx[i] >= 0 && f.adx[i] <= 100, 'ADX in [0, 100]');
  assert.ok(Number.isFinite(f.profile.vah[i]) && f.profile.val[i] <= f.profile.poc[i] && f.profile.poc[i] <= f.profile.vah[i], 'value area around the POC');
  assert.strictEqual(f.atr20.length, bars.length);
});

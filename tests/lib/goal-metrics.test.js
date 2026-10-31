'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const GM = require('../../scripts/lib/eval/goal-metrics');
const GT = require('../../scripts/lib/eval/goal-trades');

const ROOT = path.resolve(__dirname, '..', '..');
const tr = (day, side, entryTime, R, o = {}) => ({ day, side, entryTime, exitTime: entryTime, stopTicks: 80, R, mfeR: o.mfeR ?? Math.max(R, 0), maeR: o.maeR ?? Math.min(R, 0) });

test('caught: the first trade the leg\'s way inside its catch window counts its R; R available in the reference risk', () => {
  const legs = [
    { day: 'd1', side: 'long', start: '2022-01-03T14:30:00Z', until: '2022-01-03T15:00:00Z', to: 120, startClose: 100 },
    { day: 'd1', side: 'short', start: '2022-01-03T16:00:00Z', until: '2022-01-03T16:30:00Z', to: 80, startClose: 100 },
  ];
  const trades = [tr('d1', 'long', '2022-01-03T14:45:00Z', 2), tr('d1', 'long', '2022-01-03T14:50:00Z', 5), tr('d1', 'short', '2022-01-03T16:40:00Z', 3)];
  assert.deepStrictEqual(GM.caught(trades, legs, { refRiskPts: 10 }), { legs: 2, caught: 1, rCaught: 2, rAvailable: 4, share: 0.5 });
});

test('tradeStats: mean R, false starts (a loser that never rose past the peak), max drawdown on the R curve', () => {
  const s = GM.tradeStats([tr('d', 'long', 't', 2), tr('d', 'long', 't', -1, { mfeR: 0.2 }), tr('d', 'long', 't', -1, { mfeR: 1.2 }), tr('d', 'long', 't', 1)], { falseStartPeakR: 0.5, tick: 0.25 });
  assert.deepStrictEqual([s.trades, s.meanR, s.falseStartShare, s.maxDrawdownR, s.medianRiskPts], [4, 0.25, 0.25, 2, 20]);
});

test('combineMc: the shipped account\'s 30-session attempts, seeded (the same twice), blows from gaps through the stop, passes from winners', () => {
  const P = GT.shippedOf(ROOT, {});
  const ctx = GM.mcContext(P, { root: ROOT, env: {}, symbol: 'MNQ' });
  const days = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2022, 0, 3 + i)).toISOString().slice(0, 10));
  const regimes = days.map(() => 'normal');
  const at = d => `${d}T15:00:00.000Z`;
  const run = (R, maeR) => GM.combineMc({ trades: days.map(d => tr(d, 'long', at(d), R, { maeR })), days, regimes, ctx, sessions: ctx.account.sessions, paths: 50, seed: 1, meanBlock: 7, symbol: 'MNQ' });
  const win = run(2);
  assert.deepStrictEqual(run(2), win);
  assert.ok(win.pass > 0 && win.blows === 0, JSON.stringify(win));
  // A loser whose path gapped 12R through its stop before it closed: the floor is hit inside the trade.
  const lose = run(-1, -12);
  assert.strictEqual(lose.pass, 0);
  assert.ok(lose.blows > 0, JSON.stringify(lose));
});

test('walkTaken and combineMc: one position at a time after sizing, so a plan the account can\'t size never holds the slot', () => {
  const P = GT.shippedOf(ROOT, {});
  const ctx = GM.mcContext(P, { root: ROOT, env: {}, symbol: 'MNQ' });
  const day = '2022-01-03';
  const t = (entry, exit, stopTicks, R, type) => ({ ...tr(day, 'long', `${day}T${entry}:00.000Z`, R), exitTime: `${day}T${exit}:00.000Z`, stopTicks, setupAt: `${day}T${entry}:00.000Z`, type });
  // A 4000-tick stop sizes no contract; the 14:10 plan inside its span is taken in its place, the 14:20 one inside
  // that one's span is not.
  const wide = t('14:00', '15:00', 4000, 3, 'a');
  const inside = t('14:10', '14:40', 80, 2, 'b');
  const over = t('14:20', '14:30', 80, 2, 'c');
  const taken = GM.walkTaken({ trades: [over, wide, inside], days: [day], regimes: ['normal'], ctx, symbol: 'MNQ' });
  assert.deepStrictEqual(taken.map(x => x.type), ['b']);
  // The same in every combine path: one taken trade a day, never the unsized one.
  const days = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2022, 0, 3 + i)).toISOString().slice(0, 10));
  const each = d => [wide, inside, over].map(x => ({ ...x, day: d, entryTime: x.entryTime.replace(day, d), exitTime: x.exitTime.replace(day, d), setupAt: x.setupAt.replace(day, d) }));
  const mc = GM.combineMc({ trades: days.flatMap(each), days, regimes: days.map(() => 'normal'), ctx, sessions: ctx.account.sessions, paths: 20, seed: 1, meanBlock: 7, symbol: 'MNQ' });
  const only = GM.combineMc({ trades: days.flatMap(d => each(d).filter(x => x.type === 'b')), days, regimes: days.map(() => 'normal'), ctx, sessions: ctx.account.sessions, paths: 20, seed: 1, meanBlock: 7, symbol: 'MNQ' });
  assert.deepStrictEqual(mc, only);
});

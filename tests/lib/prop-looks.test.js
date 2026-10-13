'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { LOOK_BUDGET, PURPOSES, lookUsage, checkLook } = require('../../scripts/lib/prop/looks');

const look = (from, to, purpose = 'judging', candidate = 'c1') => ({ candidate, purpose, from, to });
const HELD = ['2026-10-01', '2027-01-01'];
const HELD2 = ['2027-10-01', '2028-01-01'];
const TUNING = ['2026-07-01', '2026-10-01'];
const OOS = ['2024-07-01', '2025-07-01'];
const JUNE = ['2026-06-01', '2026-06-06'];

test('the budget is 3 looks (the owner\'s decision, R16); three purposes', () => {
  assert.strictEqual(LOOK_BUDGET, 3);
  assert.deepStrictEqual([...PURPOSES], ['tuning', 'judging', 'reasoning-fix']);
  assert.ok(Object.isFrozen(PURPOSES));
});

test('the recorded looks are always in the ledger: the parity look counts against out-of-sample', () => {
  const usage = lookUsage([]);
  const oos = usage.get('oos [2024-07-01, 2025-07-01)');
  assert.deepStrictEqual([oos.looks, oos.budgeted, oos.spent, oos.remaining], [1, true, 1, 2]);
  const select = usage.get('select [2023-07-01, 2024-07-01)');
  assert.deepStrictEqual([select.looks, select.budgeted, select.remaining], [1, false, null]);
  assert.strictEqual(usage.get('recent [2025-07-01, 2026-07-01)').looks, 1, 'the June 1-5, 2026 replay');
  assert.strictEqual(checkLook(look(...OOS), []).units[0].remaining, 2, 'an empty ledger can\'t drop them');
});

test('the ledger is required: without it every look is refused', () => {
  for (const ledger of [undefined, null, 'not a list', {}]) {
    const r = checkLook(look('2022-01-03', '2022-02-03', 'tuning'), ledger);
    assert.strictEqual(r.ok, false);
    assert.match(r.refusals[0], /the ledger can't be read: the ledger is required/);
  }
  assert.throws(() => lookUsage(), /the ledger is required/);
});

test('out-of-sample: judging only, two more looks, then retired and refused', () => {
  const ledger = [];
  for (let i = 0; i < 2; i++) {
    const r = checkLook(look(...OOS, 'judging', `c${i}`), ledger);
    assert.ok(r.ok, JSON.stringify(r));
    ledger.push(look(...OOS, 'judging', `c${i}`));
  }
  const r = checkLook(look(...OOS, 'judging', 'c9'), ledger);
  assert.strictEqual(r.ok, false);
  assert.match(r.refusals[0], /used its 3 looks and is retired/);
  // A look at part of the window counts, and is refused, the same.
  assert.strictEqual(checkLook(look('2025-01-01', '2025-02-01'), ledger).ok, false);
  assert.strictEqual(checkLook(look('2025-01-01', '2025-02-01'), ledger.slice(1)).ok, true);
  for (const purpose of ['tuning', 'reasoning-fix']) {
    assert.match(checkLook(look(...OOS, purpose), []).refusals[0], /allows judging looks only/, purpose);
  }
  // An untagged ledger entry still spends the budget.
  assert.strictEqual(checkLook(look(...OOS), [{ candidate: 'x', from: OOS[0], to: OOS[1] }]).units[0].remaining, 1);
});

test('walk-forward: tuning looks are logged with no budget; held-out looks share one budget of 3 across every quarter', () => {
  const ledger = Array.from({ length: 20 }, () => look(...TUNING, 'tuning'));
  const t = checkLook(look(...TUNING, 'tuning'), ledger);
  assert.ok(t.ok);
  assert.deepStrictEqual([t.units[0].part, t.units[0].budgeted, t.units[0].looks, t.units[0].remaining], ['tuning', false, 20, null]);
  for (const purpose of PURPOSES) assert.ok(checkLook(look(...TUNING, purpose), []).ok, purpose);
  // Tuning looks never touch the held-out budget.
  const h0 = checkLook(look(...HELD), ledger);
  assert.deepStrictEqual([h0.units[0].budget, h0.units[0].remaining], ['walk-forward held-out', 3]);
  // Two looks at 2026-H2's held-out quarter and one at 2027-H2's spend the one shared budget.
  ledger.push(look(...HELD), look('2026-10-05', '2026-11-05'), look(...HELD2));
  for (const q of [HELD, HELD2, ['2028-10-01', '2029-01-01']]) {
    const h = checkLook(look(...q), ledger);
    assert.strictEqual(h.ok, false, q.join('..'));
    assert.match(h.refusals[0], /walk-forward held-out budget has used its 3 looks/);
  }
  // The tuning quarters stay open after the held-out budget is spent.
  assert.ok(checkLook(look(...TUNING, 'tuning'), ledger).ok);
  // Held-out quarters are for the verifiers: judging only.
  for (const purpose of ['tuning', 'reasoning-fix']) {
    assert.match(checkLook(look(...HELD, purpose), []).refusals[0], /allows judging looks only/, purpose);
  }
});

test('a pooled look counts once against the held-out budget, whatever quarters it touches', () => {
  const pooled = { candidate: 'p', purpose: 'judging', ranges: [{ from: HELD[0], to: HELD[1] }, { from: HELD2[0], to: HELD2[1] }, { from: '2026-11-01', to: '2026-12-01' }] };
  const r = checkLook(pooled, []);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.units.map(u => u.block), ['2026-H2', '2027-H2'], 'the same quarter twice is one unit');
  assert.strictEqual(lookUsage([pooled, pooled]).get('2027-H2 held-out [2027-10-01, 2028-01-01)').remaining, 1);
  const p = checkLook(pooled, [pooled, pooled, look(...HELD2)]);
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.refusals.length, 2, 'each quarter names the spent budget');
});

test('Recent: a reasoning-fix look (no market claim) is allowed and logged without spending a budget; nothing else is', () => {
  const fix = look(...JUNE, 'reasoning-fix');
  const ledger = Array.from({ length: 10 }, () => fix);
  const r = checkLook(fix, ledger);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.units[0].role, r.units[0].looks, r.units[0].budgeted], ['recent', 11, false]);
  for (const purpose of ['tuning', 'judging']) {
    const x = checkLook(look(...JUNE, purpose), []);
    assert.strictEqual(x.ok, false, purpose);
    assert.match(x.refusals[0], /only a reasoning-fix look/);
  }
  // Untagged, or tagged with something else: refused.
  for (const purpose of [undefined, '', 'market-claim', 'threshold']) {
    const x = checkLook({ candidate: 'c', purpose, from: JUNE[0], to: JUNE[1] }, []);
    assert.strictEqual(x.ok, false, String(purpose));
    assert.match(x.refusals[0], /a look names its purpose/);
  }
  // Reasoning-fix looks don't spend the out-of-sample budget either: only recorded and other looks do.
  assert.strictEqual(checkLook(look(...OOS), ledger).units[0].remaining, 2);
  // A ledger entry tagged reasoning-fix where a budget's unit doesn't allow one spends, as any other look.
  for (const [from, to] of [['2024-09-01', '2024-10-01'], ['2026-10-01', '2026-11-01']]) {
    const mistagged = Array.from({ length: 3 }, () => look(from, to, 'reasoning-fix'));
    const x = checkLook(look(from, to), mistagged);
    assert.strictEqual(x.ok, false, `${from}..${to}`);
    assert.match(x.refusals[0], /used its 3 looks/);
  }
  const pooledFix = { candidate: 'c', purpose: 'reasoning-fix', ranges: [{ from: JUNE[0], to: JUNE[1] }, { from: '2026-10-01', to: '2026-11-01' }] };
  assert.strictEqual(checkLook(look(...HELD), [pooledFix]).units[0].remaining, 2, 'one mis-tagged unit makes the whole entry spend');
});

test('the reserve half-years are refused for every purpose', () => {
  for (const [from, to] of [['2027-01-04', '2027-02-04'], ['2028-03-01', '2028-07-01']]) {
    for (const purpose of PURPOSES) {
      const r = checkLook(look(from, to, purpose), []);
      assert.strictEqual(r.ok, false, `${from}..${to} ${purpose}`);
      assert.match(r.refusals[0], /reserved for a later out-of-sample window: nothing looks at it/);
    }
  }
});

test('train: any purpose; select: judging only; both logged, no budget', () => {
  const ledger = Array.from({ length: 10 }, () => look('2022-01-01', '2022-02-01', 'tuning'));
  for (const purpose of PURPOSES) {
    const r = checkLook(look('2022-01-03', '2022-02-03', purpose), ledger);
    assert.ok(r.ok, purpose);
    assert.strictEqual(r.units[0].remaining, null);
  }
  assert.ok(checkLook(look('2023-07-01', '2024-07-01', 'judging'), ledger).ok);
  for (const purpose of ['tuning', 'reasoning-fix']) {
    assert.match(checkLook(look('2023-07-01', '2024-07-01', purpose), []).refusals[0], /allows judging looks only/);
  }
});

test('misuse is refused: no candidate, a range across a unit boundary, empty or bad ranges, a bad ledger entry', () => {
  assert.match(checkLook({ purpose: 'judging', from: OOS[0], to: OOS[1] }, []).refusals[0], /names its candidate/);
  assert.match(checkLook(look(...OOS, 'judging', '  '), []).refusals[0], /names its candidate/);
  assert.match(checkLook(look('2026-09-15', '2026-10-15', 'tuning'), []).refusals[0], /crosses a unit boundary/, 'tuning into held-out');
  assert.match(checkLook(look('2025-06-15', '2025-07-15'), []).refusals[0], /crosses a unit boundary/, 'oos into recent');
  assert.match(checkLook(look('2024-09-01', '2024-08-01'), []).refusals[0], /empty or crosses/);
  assert.match(checkLook(look('2020-06-01', '2020-07-01'), []).refusals[0], /before the schedule/);
  assert.match(checkLook(look('2024-02-30', '2024-03-05'), []).refusals[0], /not an ISO date|not a date/);
  assert.match(checkLook({ candidate: 'c', purpose: 'judging', ranges: [] }, []).refusals[0], /at least one range/);
  assert.match(checkLook({ candidate: 'c', purpose: 'judging' }, []).refusals[0], /needs from and to/);
  assert.strictEqual(checkLook(null, []).ok, false);
  // A ledger that can't be read refuses every look, even an unbudgeted one.
  for (const bad of [[look('2026-09-15', '2026-10-15')], [{}]]) {
    const r = checkLook(look('2022-01-03', '2022-02-03', 'tuning'), bad);
    assert.strictEqual(r.ok, false);
    assert.match(r.refusals[0], /the ledger can't be read/);
  }
  assert.throws(() => lookUsage([{}]), /needs from and to/);
});

test('a bar-timestamp range is read by session: an evening bar after the 18:00 ET open is held-out', () => {
  // 18:00 ET (EDT) Sep 30 opens the Oct 1 session: a tuning look ending there passes; one past it is refused.
  assert.strictEqual(checkLook(look(Date.parse('2026-07-01T13:00:00Z'), Date.parse('2026-09-30T22:00:00Z'), 'tuning'), []).units[0].part, 'tuning');
  assert.strictEqual(checkLook(look(Date.parse('2026-07-01T13:00:00Z'), Date.parse('2026-09-30T22:01:00Z'), 'tuning'), []).ok, false);
  // 18:00 ET (EST) Dec 31 opens the Jan 1 session: a held-out look reaching it touches the reserve and is refused.
  assert.strictEqual(checkLook(look(Date.parse('2026-12-01T14:30:00Z'), Date.parse('2026-12-31T23:30:00Z')), []).ok, false);
});

test('an out-of-sample look counts against every window it shares a month with, whatever the window is called (a window moved later)', () => {
  // A later schedule in which one out-of-sample window spans today's oos and Recent: both recorded looks there
  // (the parity look at oos, the June 1-5, 2026 replay at Recent) count against it.
  const splitsPath = require.resolve('../../scripts/lib/prop/splits');
  const looksPath = require.resolve('../../scripts/lib/prop/looks');
  const real = require(splitsPath);
  const wide = Object.freeze({ role: 'oos', block: 'oos', part: null, llm: false, from: '2024-07-01', to: '2026-07-01' });
  delete require.cache[looksPath];
  require.cache[splitsPath].exports = { ...real, unitContaining: (from, to) => (from === '2025-02-01' ? wide : real.unitContaining(from, to)) };
  try {
    // Reasoning-fix looks taken at Recent before the move are logged there but spend nothing.
    const fixes = Array.from({ length: 4 }, () => look(...JUNE, 'reasoning-fix'));
    const r = require(looksPath).checkLook(look('2025-02-01', '2025-03-01'), fixes);
    assert.deepStrictEqual([r.units[0].key, r.units[0].looks, r.units[0].spent, r.units[0].remaining], ['oos [2024-07-01, 2026-07-01)', 6, 2, 1]);
  } finally {
    require.cache[splitsPath].exports = real;
    delete require.cache[looksPath];
  }
});

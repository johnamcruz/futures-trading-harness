'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SPLITS, windowMs, overlaps } = require('../../scripts/lib/prop/splits');

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

test('split windows: train, select and oos are real, ordered [from, to) date ranges', () => {
  assert.deepStrictEqual(Object.keys(SPLITS), ['train', 'select', 'oos']);
  for (const [name, w] of Object.entries(SPLITS)) {
    assert.ok(Array.isArray(w) && w.length === 2 && w.every(d => ISO_DAY.test(d)), `${name}: [from, to] ISO dates`);
    const { from, to } = windowMs(name);
    assert.ok(Number.isFinite(from) && Number.isFinite(to) && from < to, `${name}: from before to`);
  }
  assert.ok(windowMs('train').to <= windowMs('select').from, 'select after train');
  assert.ok(windowMs('select').to <= windowMs('oos').from, 'oos after select');
  assert.throws(() => windowMs('recent'), /no split window/);
});

test('split windows: out of sample never overlaps train or select, and never moves backward', () => {
  const oos = windowMs('oos');
  assert.ok(!overlaps(oos, windowMs('train')), 'oos overlaps train');
  assert.ok(!overlaps(oos, windowMs('select')), 'oos overlaps select');
  // The windows as first set: a window may move forward when the out-of-sample
  // one is retired, never back (raise these floors with it).
  assert.ok(SPLITS.oos[0] >= '2024-07-01' && SPLITS.oos[1] >= '2025-07-01', 'oos moved backward');
  assert.ok(SPLITS.select[0] >= '2023-07-01', 'select moved backward');
  assert.ok(Object.isFrozen(SPLITS) && Object.values(SPLITS).every(Object.isFrozen));
  // overlaps is half-open: touching windows don't overlap.
  assert.strictEqual(overlaps({ from: 0, to: 10 }, { from: 10, to: 20 }), false);
  assert.strictEqual(overlaps({ from: 0, to: 11 }, { from: 10, to: 20 }), true);
});

const {
  RECENT, SCHEDULE_START, NEW_MONTHS_FROM, LLM_FROM, RESERVE_MIN_MONTHS, ROLES, RECORDED_LOOKS,
  roleOf, isLlmMonth, blockByName, blocksBetween, unitContaining, oosQueue,
} = require('../../scripts/lib/prop/splits');

const SESSIONS_PER_MONTH = 21; // an attempt: one billing cycle, about 21 sessions
const ms = iso => Date.parse(`${iso}T00:00:00Z`);
const monthsOf = (from, to) => {
  const out = [];
  for (let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7)); `${y}-${String(m).padStart(2, '0')}` <= to;) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
};
const MONTHS = monthsOf('2021-01', '2030-12');

test('schedule: every month 2021-01..2030-12 has exactly one mechanical role, and no two roles overlap', () => {
  const blocks = blocksBetween('2021-01-01', '2031-01-01');
  for (let i = 1; i < blocks.length; i++) {
    assert.strictEqual(blocks[i - 1].to, blocks[i].from, `${blocks[i - 1].block} and ${blocks[i].block} not contiguous`);
  }
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      assert.ok(!overlaps({ from: ms(blocks[i].from), to: ms(blocks[i].to) }, { from: ms(blocks[j].from), to: ms(blocks[j].to) }),
        `${blocks[i].block} overlaps ${blocks[j].block}`);
    }
  }
  for (const month of MONTHS) {
    const holders = blocks.filter(b => month >= b.from && month < b.to);
    assert.strictEqual(holders.length, 1, `${month}: ${holders.length} roles`);
    const r = roleOf(month);
    assert.ok(ROLES.includes(r.role), `${month}: role ${r.role}`);
    assert.strictEqual(r.block, holders[0].block);
    // Every day of the month has the month's role.
    assert.deepStrictEqual(roleOf(`${month.slice(0, 8)}28`), r);
  }
  assert.strictEqual(blocks[0].from, SCHEDULE_START);
  assert.throws(() => roleOf('2020-12-31'), /before the schedule/);
});

test('schedule: the frozen splits and Recent are blocks of their own roles', () => {
  for (const name of ['train', 'select', 'oos']) {
    const b = blockByName(name);
    assert.deepStrictEqual([b.role, b.from, b.to], [name, ...SPLITS[name]]);
  }
  assert.deepStrictEqual([...RECENT], ['2025-07-01', '2026-07-01']);
  assert.deepStrictEqual({ ...roleOf('2025-07-01'), llm: true }, roleOf('2026-06-30'));
  assert.strictEqual(roleOf('2025-07-01').role, 'recent');
  assert.strictEqual(roleOf('2025-06-30').role, 'oos');
  assert.strictEqual(roleOf('2026-07-01').role, 'walk-forward');
  assert.strictEqual(windowMs('oos').to, ms(RECENT[0]), 'recent starts where oos ends');
  // The recorded looks: the June 1-5, 2026 LLM replay at Recent (adherence only), and the 2024 flow parity
  // check at select and oos (it decided recalibration only).
  assert.strictEqual(RECORDED_LOOKS.length, 3);
  const look = RECORDED_LOOKS[0];
  assert.deepStrictEqual([look.block, look.from, look.to], ['recent', '2026-06-01', '2026-06-06']);
  assert.match(look.use, /adherence only/);
  assert.deepStrictEqual(RECORDED_LOOKS.slice(1).map(l => [l.block, l.from, l.to]), [
    ['select', '2024-03-04', '2024-06-22'],
    ['oos', '2024-08-01', '2024-08-10'],
  ]);
  for (const l of RECORDED_LOOKS) {
    assert.strictEqual(roleOf(l.from).role, l.block, `${l.from} is in ${l.block}`);
    assert.ok(unitContaining(l.from, l.to), `${l.from}..${l.to} lies in one unit`);
    assert.strictEqual(unitContaining(l.from, l.to).role, l.block);
    assert.ok(Object.isFrozen(l));
  }
  for (const l of RECORDED_LOOKS.slice(1)) assert.match(l.use, /recalibration only, no threshold value/);
  assert.ok(Object.isFrozen(RECORDED_LOOKS) && Object.isFrozen(RECENT));
});

test('schedule: half-years alternate from 2026-H2 = walk-forward, by rule', () => {
  assert.strictEqual(NEW_MONTHS_FROM, '2026-07-01');
  assert.strictEqual(blockByName('2026-H2').role, 'walk-forward');
  assert.strictEqual(blockByName('2027-H1').role, 'reserve');
  assert.strictEqual(blockByName('2027-H2').role, 'walk-forward');
  assert.throws(() => blockByName('2026-H1'), /no schedule block/);
  assert.throws(() => blockByName('later'), /no schedule block/);
  const half = blocksBetween(NEW_MONTHS_FROM, '2041-01-01');
  assert.strictEqual(half.length, 29);
  half.forEach((b, i) => {
    assert.strictEqual(b.months, 6, `${b.block}: six months`);
    assert.strictEqual(b.role, i % 2 === 0 ? 'walk-forward' : 'reserve', `${b.block}`);
    assert.deepStrictEqual(blockByName(b.block), b);
  });
});

test('schedule: each walk-forward half-year is tuning then held-out, contiguous quarters of at least two attempts', () => {
  const weekdays = (from, to) => {
    let n = 0;
    for (let t = ms(from); t < ms(to); t += 86400000) if (![0, 6].includes(new Date(t).getUTCDay())) n++;
    return n;
  };
  for (const b of blocksBetween(NEW_MONTHS_FROM, '2031-01-01')) {
    if (b.role !== 'walk-forward') { assert.strictEqual(b.parts, undefined); continue; }
    assert.deepStrictEqual(b.parts.map(p => p.part), ['tuning', 'held-out'], `${b.block}: tuning first`);
    const [tuning, held] = b.parts;
    assert.strictEqual(tuning.from, b.from);
    assert.strictEqual(tuning.to, held.from, `${b.block}: quarters contiguous`);
    assert.strictEqual(held.to, b.to);
    for (const p of b.parts) {
      assert.ok(p.months * SESSIONS_PER_MONTH >= 2 * SESSIONS_PER_MONTH, `${b.block} ${p.part}: two attempts`);
      // Weekdays less up to 5 exchange holidays still hold two 21-session attempts.
      assert.ok(weekdays(p.from, p.to) - 5 >= 2 * SESSIONS_PER_MONTH, `${b.block} ${p.part}: sessions`);
      assert.strictEqual(roleOf(p.from).part, p.part);
      assert.deepStrictEqual([roleOf(p.from).from, roleOf(p.from).to], [p.from, p.to]);
    }
  }
  assert.strictEqual(roleOf('2026-09-30').part, 'tuning');
  assert.strictEqual(roleOf('2026-10-01').part, 'held-out');
  assert.strictEqual(roleOf('2027-03-01').part, null);
  assert.strictEqual(roleOf('2024-03-01').part, null);
});

test('schedule: the windows never move backward', () => {
  // The schedule as first set (raise these floors only when a window is retired).
  assert.ok(RECENT[0] >= '2025-07-01' && RECENT[1] >= '2026-07-01', 'recent moved backward');
  assert.ok(NEW_MONTHS_FROM >= '2026-07-01', 'new months moved backward');
  assert.strictEqual(SCHEDULE_START, '2021-01-01');
  assert.strictEqual(RESERVE_MIN_MONTHS, 12);
  // Time order: train < select < oos < recent < half-years, as roles go.
  const order = blocksBetween('2021-01-01', '2026-07-01').map(b => b.block);
  assert.deepStrictEqual(order, ['train', 'select', 'oos', 'recent']);
});

test('schedule: the LLM role is a flag from 2026-06 on, not a mechanical role', () => {
  assert.strictEqual(LLM_FROM, '2026-06-01');
  assert.ok(!ROLES.includes('llm'));
  assert.deepStrictEqual([roleOf('2026-05-31').llm, roleOf('2026-06-01').llm], [false, true]);
  assert.strictEqual(roleOf('2026-06-03').role, 'recent', 'the June replay keeps Recent\'s role');
  assert.strictEqual(roleOf('2027-02-01').role, 'reserve');
  assert.ok(roleOf('2027-02-01').llm);
  assert.strictEqual(isLlmMonth('2026-06-15'), true);
  assert.strictEqual(isLlmMonth('2024-01-15'), false);
});

test('schedule: blocksBetween and unitContaining bound attempts to one unit', () => {
  assert.deepStrictEqual(blocksBetween('2023-06-15', '2023-07-01').map(b => b.block), ['train']);
  assert.deepStrictEqual(blocksBetween('2023-06-15', '2023-07-02').map(b => b.block), ['train', 'select']);
  assert.deepStrictEqual(blocksBetween('2026-06-01', '2027-01-01').map(b => b.block), ['recent', '2026-H2']);
  assert.deepStrictEqual(blocksBetween('2026-01-01', '2026-01-01'), []);
  assert.strictEqual(unitContaining('2026-07-01', '2026-10-01').part, 'tuning');
  assert.strictEqual(unitContaining('2026-09-15', '2026-10-15'), null, 'tuning into held-out');
  assert.strictEqual(unitContaining('2026-10-01', '2027-01-01').part, 'held-out');
  assert.strictEqual(unitContaining('2027-01-05', '2027-02-05').block, '2027-H1');
  assert.strictEqual(unitContaining('2025-06-15', '2025-07-15'), null, 'oos into recent');
  assert.strictEqual(unitContaining('2024-08-01', '2024-09-01').role, 'oos');
  assert.strictEqual(unitContaining('2024-09-01', '2024-08-01'), null);
  assert.throws(() => roleOf('2026-02-30'), /not an ISO date|not a date/);
  assert.throws(() => roleOf('June 2026'), /not an ISO date/);
  assert.throws(() => roleOf(NaN), /not a date/);
  assert.strictEqual(roleOf(ms('2026-08-10')).part, 'tuning');
  assert.strictEqual(roleOf(new Date(ms('2026-11-10'))).part, 'held-out');
});

test('schedule: the reserve forms out-of-sample windows of at least 12 months, Recent first', () => {
  assert.deepStrictEqual(oosQueue('2026-06-30'), []);
  assert.deepStrictEqual(oosQueue('2026-07-01').map(w => w.blocks), [['recent']]);
  // 2027-H1 alone is six months: not a window yet.
  assert.strictEqual(oosQueue('2028-06-30').length, 1);
  const q = oosQueue('2031-01-01');
  assert.deepStrictEqual(q.map(w => [w.blocks, w.readyAt]), [
    [['recent'], '2026-07-01'],
    [['2027-H1', '2028-H1'], '2028-07-01'],
    [['2029-H1', '2030-H1'], '2030-07-01'],
  ]);
  for (const w of q) {
    assert.ok(w.months >= RESERVE_MIN_MONTHS);
    for (const name of w.blocks) assert.ok(['recent', 'reserve'].includes(blockByName(name).role), `${name} reserved`);
  }
});

test('a bar timestamp belongs to its trading session: an evening bar after the 18:00 ET open is in the next session\'s block or quarter', () => {
  const { roleOf, unitContaining } = require('../../scripts/lib/prop/splits');
  const at = iso => new Date(iso);
  // 18:00 ET (EDT) on Sep 30 opens the Oct 1 session: held-out, never tuning (R17).
  assert.deepStrictEqual([roleOf(at('2026-09-30T22:00:00Z')).block, roleOf(at('2026-09-30T22:00:00Z')).part], ['2026-H2', 'held-out']);
  assert.strictEqual(roleOf(at('2026-09-30T19:00:00Z')).part, 'tuning', 'the afternoon is still Sep 30');
  assert.strictEqual(roleOf(Date.parse('2026-09-30T22:00:00Z')).part, 'held-out', 'a millisecond timestamp too');
  // 18:30 ET on Jun 30 opens the Jul 1 session: walk-forward, not Recent.
  assert.strictEqual(roleOf(at('2026-06-30T22:30:00Z')).role, 'walk-forward');
  // 18:30 ET (EST) on Dec 31 opens the Jan 1 session: 2027-H1 reserve, not 2026-H2 held-out.
  assert.strictEqual(roleOf(at('2026-12-31T23:30:00Z')).block, '2027-H1');
  // An attempt built from bar timestamps, first bar at the Jul 1 session's evening open, inside 2026-H2 tuning.
  const unit = unitContaining(Date.parse('2026-06-30T22:00:00Z'), Date.parse('2026-07-29T21:00:00Z'));
  assert.ok(unit && unit.block === '2026-H2' && unit.part === 'tuning', JSON.stringify(unit));
  // Session-date strings are taken as they are.
  assert.strictEqual(roleOf('2026-09-30').part, 'tuning');
});

test('a timestamp range end holds its own session: a range reaching into the next unit never passes as inside this one', () => {
  const { unitContaining, blocksBetween } = require('../../scripts/lib/prop/splits');
  const t = iso => Date.parse(iso);
  // Ends inside the Oct 1 session (held-out): not a tuning attempt (R17).
  assert.strictEqual(unitContaining(t('2026-07-01T13:00:00Z'), t('2026-10-01T20:59:00Z')), null);
  assert.strictEqual(unitContaining('2026-07-01', t('2026-10-01T15:00:00Z')), null, 'a session-date start too');
  // Ends exactly at the Oct 1 session's first instant (18:00 ET Sep 30): exclusive, so still inside tuning.
  assert.strictEqual(unitContaining(t('2026-07-01T13:00:00Z'), t('2026-09-30T22:00:00Z')).part, 'tuning');
  // blocksBetween includes the block its end session falls in.
  assert.deepStrictEqual(blocksBetween(t('2026-06-01T13:00:00Z'), t('2026-07-01T15:00:00Z')).map(b => b.block), ['recent', '2026-H2']);
  assert.deepStrictEqual(blocksBetween(t('2026-06-01T13:00:00Z'), t('2026-06-30T21:00:00Z')).map(b => b.block), ['recent']);
  // Session-date strings keep their exclusive meaning.
  assert.strictEqual(unitContaining('2026-07-01', '2026-10-01').part, 'tuning');
  assert.deepStrictEqual(blocksBetween('2026-06-01', '2026-07-01').map(b => b.block), ['recent']);
});

test('pins: the frozen windows, Recent, the half-year rule and the recorded looks never move', () => {
  // Raise a window only when one is retired through the ledger (R16), reviewed; never edit a recorded look.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(SPLITS)), {
    train: ['2021-01-01', '2023-07-01'], select: ['2023-07-01', '2024-07-01'], oos: ['2024-07-01', '2025-07-01'],
  });
  assert.deepStrictEqual([...RECENT], ['2025-07-01', '2026-07-01']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(RECORDED_LOOKS)), [
    { block: 'recent', from: '2026-06-01', to: '2026-06-06', what: 'LLM replay, June 1-5 2026', use: 'adherence only, no candidate claims (R22)' },
    { block: 'select', from: '2024-03-04', to: '2024-06-22', what: 'flow parity check', use: 'decided recalibration only, no threshold value' },
    { block: 'oos', from: '2024-08-01', to: '2024-08-10', what: 'flow parity check', use: 'decided recalibration only, no threshold value' },
  ]);
  const shape = b => [b.block, b.role, b.from, b.to, (b.parts || []).map(p => [p.part, p.from, p.to])];
  assert.deepStrictEqual(blocksBetween('2025-07-01', '2029-01-01').map(shape), [
    ['recent', 'recent', '2025-07-01', '2026-07-01', []],
    ['2026-H2', 'walk-forward', '2026-07-01', '2027-01-01', [['tuning', '2026-07-01', '2026-10-01'], ['held-out', '2026-10-01', '2027-01-01']]],
    ['2027-H1', 'reserve', '2027-01-01', '2027-07-01', []],
    ['2027-H2', 'walk-forward', '2027-07-01', '2028-01-01', [['tuning', '2027-07-01', '2027-10-01'], ['held-out', '2027-10-01', '2028-01-01']]],
    ['2028-H1', 'reserve', '2028-01-01', '2028-07-01', []],
    ['2028-H2', 'walk-forward', '2028-07-01', '2029-01-01', [['tuning', '2028-07-01', '2028-10-01'], ['held-out', '2028-10-01', '2029-01-01']]],
  ]);
  // roleOf's contract (tools refuse held-out months by it): these keys, no more, no fewer.
  assert.deepStrictEqual(Object.keys(roleOf('2026-11-02')).sort(), ['block', 'from', 'llm', 'part', 'role', 'to']);
});

const { FLOW_COVERAGE, hasSession, attemptSessions, isFlowCovered, attemptFlowCovered } = require('../../scripts/lib/prop/splits');

test('sessions: weekdays the exchange is open; every exchange holiday is closed', () => {
  assert.strictEqual(hasSession(ms('2025-11-26')), true);
  assert.strictEqual(hasSession(ms('2025-11-27')), false, 'Thanksgiving');
  assert.strictEqual(hasSession(ms('2025-11-29')), false, 'Saturday');
  assert.strictEqual(hasSession(ms('2025-11-28')), true, 'an early close is a session');
  assert.strictEqual(hasSession(ms('2026-07-03')), false, 'Independence Day observed (built-in calendar)');
  assert.strictEqual(hasSession(ms('2025-04-18')), false, 'Good Friday');
  assert.strictEqual(hasSession(ms('2022-04-15')), false, 'Good Friday 2022');
  assert.strictEqual(hasSession(ms('2022-04-22')), true);
  // Juneteenth is an exchange holiday from 2022: 2021-06-18 traded; 2022's, on a Sunday, is kept Monday June 20.
  assert.strictEqual(hasSession('2021-06-18'), true);
  assert.strictEqual(hasSession('2022-06-20'), false);
  // A timestamp is its session: 18:00 ET (EST) on Nov 26 opens the Thanksgiving session, which is closed.
  assert.strictEqual(hasSession(Date.parse('2025-11-26T23:00:00Z')), false);
  assert.strictEqual(hasSession(Date.parse('2025-11-26T20:00:00Z')), true);
  const count = (from, to) => {
    let n = 0;
    for (let t = ms(from); t < ms(to); t += 86400000) if (hasSession(t)) n++;
    return n;
  };
  // Each walk-forward quarter holds about 63 sessions: at least two 30-session attempts (R17).
  for (const b of blocksBetween(NEW_MONTHS_FROM, '2031-01-01').filter(x => x.parts)) {
    for (const p of b.parts) {
      const n = count(p.from, p.to);
      assert.ok(n >= 60 && n <= 66, `${b.block} ${p.part}: ${n} sessions`);
    }
  }
  // Section 4: 2025-07 to 2025-11 hold about 106 sessions.
  assert.strictEqual(count('2025-07-01', '2025-12-01'), 106);
});

test('attemptSessions: the first session on or after the start, the last of `sessions`, and the start plus `sessions`', () => {
  const plain = o => ({ ...o });
  assert.deepStrictEqual(plain(attemptSessions('2025-11-26', 2)), { first: '2025-11-26', last: '2025-11-28', bound: '2025-12-01' });
  assert.deepStrictEqual(plain(attemptSessions('2025-11-27', 1)), { first: '2025-11-28', last: '2025-11-28', bound: '2025-12-01' }, 'a holiday start');
  assert.deepStrictEqual(plain(attemptSessions('2025-11-29', 1)), { first: '2025-12-01', last: '2025-12-01', bound: '2025-12-02' }, 'a weekend start');
  assert.deepStrictEqual(plain(attemptSessions('2025-10-17', 30)), { first: '2025-10-17', last: '2025-11-28', bound: '2025-12-01' });
  // A bar timestamp is read as its session: 18:00 ET (EDT) on Oct 16 opens the Oct 17 session.
  assert.strictEqual(attemptSessions(Date.parse('2025-10-16T22:00:00Z'), 30).first, '2025-10-17');
  assert.strictEqual(attemptSessions(Date.parse('2025-10-16T21:59:00Z'), 30).first, '2025-10-16');
  for (const bad of [0, -1, 1.5, '30', NaN, undefined, null]) assert.throws(() => attemptSessions('2025-07-01', bad), /sessions/);
  assert.throws(() => attemptSessions('2025-13-01', 30), /not an ISO date|not a date/);
});

test('flow coverage: 2021-05 to 2025-11, by session; it changes no role', () => {
  assert.deepStrictEqual([...FLOW_COVERAGE], ['2021-05-01', '2025-12-01']);
  assert.ok(Object.isFrozen(FLOW_COVERAGE));
  assert.deepStrictEqual(['2021-04-30', '2021-05-01', '2021-05-03', '2025-11-28', '2025-11-30', '2025-12-01'].map(d => isFlowCovered(d)),
    [false, true, true, true, true, false]);
  // A timestamp is read as its session: 18:00 ET (EST, after the November DST change) on Sunday Nov 30 opens Dec 1.
  assert.strictEqual(isFlowCovered(Date.parse('2025-11-30T23:00:00Z')), false);
  assert.strictEqual(isFlowCovered(Date.parse('2025-11-28T18:00:00Z')), true);
  assert.strictEqual(isFlowCovered(new Date('2021-05-03T13:30:00Z')), true);
  assert.strictEqual(isFlowCovered(Date.parse('2021-04-29T22:00:00Z')), false, '18:00 EDT Apr 29 opens the Apr 30 session');
  // Select and oos wholly, train from 2021-05, Recent's first five months; not the new months or the LLM months.
  for (const m of MONTHS) {
    const covered = m >= '2021-05-01' && m < '2025-12-01';
    assert.strictEqual(isFlowCovered(m), covered, m);
    assert.strictEqual(isFlowCovered(`${m.slice(0, 8)}28`), covered, m);
  }
  assert.strictEqual(roleOf('2025-11-15').role, roleOf('2025-12-15').role, 'coverage limits flow, never the role');
  assert.throws(() => isFlowCovered('2025-02-30'), /not an ISO date|not a date/);
});

test('flow coverage of an attempt: decided at the start, by its start day plus `sessions` sessions', () => {
  // 30 sessions (every account today): the start plus 30 sessions must itself be a covered session date.
  assert.strictEqual(attemptFlowCovered('2025-10-16', 30), true);
  assert.strictEqual(attemptFlowCovered('2025-10-17', 30), false, 'its 30th session ends coverage; the start plus 30 is Dec 1');
  assert.strictEqual(attemptFlowCovered('2025-10-20', 30), false);
  assert.strictEqual(attemptFlowCovered(Date.parse('2025-10-15T22:00:00Z'), 30), true, 'the Oct 16 session');
  assert.strictEqual(attemptFlowCovered(Date.parse('2025-10-16T22:00:00Z'), 30), false, 'the Oct 17 session');
  // Thanksgiving is not a session: a short attempt across it.
  assert.strictEqual(attemptFlowCovered('2025-11-25', 2), true, 'Nov 25, 26; the start plus 2 is Nov 28');
  assert.strictEqual(attemptFlowCovered('2025-11-26', 2), false, 'Nov 26, 28; the start plus 2 is Dec 1');
  // The start must be covered too.
  assert.strictEqual(attemptFlowCovered('2021-04-30', 30), false);
  assert.strictEqual(attemptFlowCovered('2021-05-01', 30), true, 'a Saturday start: its first session is May 3');
  assert.strictEqual(attemptFlowCovered('2024-08-01', 30), true);
  assert.strictEqual(attemptFlowCovered('2026-08-03', 30), false, 'new months are not covered');
  assert.throws(() => attemptFlowCovered('2024-08-01', 0), /sessions/);
});

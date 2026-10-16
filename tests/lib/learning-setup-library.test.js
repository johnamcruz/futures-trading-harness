'use strict';

// The history library (scripts/lib/learning/setup-library.js, scripts/setup-library.js): the scan over fixture bars
// (the parity NQ bars moved back 312 weeks into practice-train, the same weekdays and offsets), the split refusals,
// determinism, causality, signature parity with compose_check's checker, the walk-forward index, and experience_lookup's
// section of its own within its cap.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('../fixtures/golden-bars');
const { record, tmpHome } = require('../fixtures/learning');
const L = require('../../scripts/lib/learning/setup-library');
const X = require('../../scripts/lib/learning/experience-index');
const H = require('../../scripts/lib/harness-tools/experience');
const R = require('../../scripts/lib/learning/learning-report');
const { fromLifecycleRecord } = require('../../scripts/lib/learning/lifecycle-record');
const { buildBriefing } = require('../../scripts/lib/trading/briefing');
const { checkReads } = require('../../scripts/lib/trading/composed-reads');
const { limitOutcome } = require('../../scripts/lib/learning/experience-log');

const SHIFT = 312 * 7 * 86400000;
const BARS = G.load(G.SERIES[0]).map(({ t, o, h, l, c, v }) => ({ t: new Date(Date.parse(t) - SHIFT).toISOString(), o, h, l, c, v }));
const CLOCK = L.runnerClock({ from: '2020-04-01', to: '2020-06-01' });
const scan = (bars = BARS, validBars = 2) => L.scanLibrary({ bars, root: 'MNQ', minutes: 3, tick: 0.25, from: '2020-04-01', to: '2020-06-01', eodOf: CLOCK.eodOf, inSession: CLOCK.inSession, validBars });
const RECORDS = scan();
const briefAt = t => {
  const i = BARS.findIndex(b => b.t === t);
  return buildBriefing({ symbol: 'MNQ', bars: BARS.slice(Math.max(0, i - 699), i + 1), minutes: 3, now: new Date(Date.parse(t) + 180000) });
};

test('scan: practice-train only; validate, test and final are refused, and so is an index with any record outside practice-train', () => {
  for (const [from, to] of [['2024-08-01', '2024-09-01'], ['2025-02-01', '2025-03-01'], ['2026-04-01', '2026-05-01'], ['2024-06-01', '2024-08-01']]) {
    assert.throws(() => L.scanLibrary({ bars: BARS, root: 'MNQ', from, to, eodOf: CLOCK.eodOf }), /practice refused/, `${from}..${to}`);
  }
  const late = { ...RECORDS.find(r => r.status === 'traded'), id: 'x', day: '2024-08-02', bar: '2024-08-02T14:00:00.000Z', outcome: null };
  assert.throws(() => L.buildLibraryIndex([...RECORDS, late], { reps: 50 }), /leakage/);
});

test('scan: deterministic on the fixture bars; every record from a fixed-level or gap reaction, its status one of the standard\'s', () => {
  assert.deepStrictEqual(scan(), RECORDS, 'the same bars give the same records');
  assert.ok(RECORDS.length > 50, `records: ${RECORDS.length}`);
  const traded = RECORDS.filter(r => r.status === 'traded');
  assert.ok(traded.length > 30, `traded: ${traded.length}`);
  assert.ok(RECORDS.every(r => ['traded', 'no-confirmation', 'not-composable', 'stop-under-floor', 'no-room', 'no-entry-window'].includes(r.status)));
  assert.ok(RECORDS.every(r => r.setupKey && /^setup:15m-(rejected|broke)-/.test(r.setupKey)));
  assert.ok(RECORDS.some(r => r.status === 'no-room'), 'a reaction with no level at 2:1 is recorded as no room');
  assert.strictEqual(new Set(RECORDS.map(r => r.id)).size, RECORDS.length);
});

test('the same-candle rule: every traded record confirms on a candle that closed after the reaction candle, in an entry window', () => {
  const { sessionWindow } = require('../../scripts/lib/trading/briefing');
  const traded = RECORDS.filter(r => r.status === 'traded');
  for (const r of traded) {
    assert.ok(Date.parse(r.bar) + 180000 > Date.parse(r.reactionAt), `${r.id}: bar ${r.bar}, reaction ${r.reactionAt}`);
    assert.strictEqual(sessionWindow(new Date(Date.parse(r.bar) + 180000)).entries, 'allowed', `${r.id} in a no-entry window`);
  }
});

test('every confirming close is tried until one composes: the fixture\'s counts, and a record traded after an earlier close failed', () => {
  const count = {};
  for (const r of RECORDS) count[r.status] = (count[r.status] || 0) + 1;
  assert.deepStrictEqual(count, { traded: 79, 'no-room': 24, 'not-composable': 12, 'no-confirmation': 19, 'no-entry-window': 2 });
  // A traded record whose window had an earlier confirming close that did not compose.
  const later = RECORDS.filter(r => r.status === 'traded').find(r => {
    for (let t = Date.parse(r.reactionAt); t + 180000 < Date.parse(r.bar) + 180000; t += 180000) {
      const bar = new Date(t).toISOString();
      const b = briefAt(bar);
      if (!L.entryRead(b.sections.m3.data.candles['3m'], r.side, '3m')) continue;
      if (L.composeAt(b, r.reaction, { side: r.side, tick: 0.25 }).status !== 'traded') return true;
    }
    return false;
  });
  assert.ok(later, 'a later close traded after an earlier confirming close failed to compose');
});

test('a checker or plan refusal is not-composable with its problem, never no-room; no-room is a verified target short of 2:1', () => {
  for (const r of RECORDS.filter(x => x.status === 'no-room')) assert.match(r.why, /R:R .* under the strategy's min 2|no level on the winning side/, r.id);
  const r = RECORDS.find(x => x.status === 'traded');
  const b = JSON.parse(JSON.stringify(briefAt(r.bar)));
  const m3 = b.sections.m3.data;
  const far = r.side === 'long' ? m3.price + 500 : m3.price - 500;
  // Targets the checker can't verify (a timeframe it doesn't know): a refusal, not a lack of room.
  m3.swingTargets = { above: [{ frame: '7m', price: far }], below: [{ frame: '7m', price: far }] };
  m3.rangeTargets = {};
  m3.fvgs = {};
  const c = L.composeAt(b, r.reaction, { side: r.side, tick: 0.25 });
  assert.strictEqual(c.status, 'not-composable');
  assert.match(c.why, /^the checker refused target 7m swing/);
});

test('the standard: entry at the confirmation close, stop one tick beyond the reaction candle, the target at 2:1 or more, the experience log\'s fill model', () => {
  for (const r of RECORDS.filter(x => x.status === 'traded').slice(0, 12)) {
    const b = briefAt(r.bar);
    const m3 = b.sections.m3.data;
    assert.strictEqual(r.plan.entry, m3.price, 'a limit at the confirmation close');
    const c = m3.candles['15m'];
    assert.strictEqual(c.closedAt, r.reactionAt, 'the reaction candle is still the last completed one');
    assert.strictEqual(r.plan.stop, r.side === 'long' ? c.l - 0.25 : c.h + 0.25, 'one tick beyond the reaction candle');
    assert.ok(r.plan.rr >= 2, `rr ${r.plan.rr}`);
    const bars = BARS.map(x => ({ ...x, ms: Date.parse(x.t) }));
    const fromMs = Date.parse(r.bar) + 180000;
    const again = limitOutcome({ bars, tfMs: 180000, side: r.side, entry: r.plan.entry, stop: r.plan.stop, target: r.plan.target, fromMs, expiresMs: fromMs + 2 * 180000, eodMs: CLOCK.eodOf(fromMs), tick: 0.25 });
    assert.deepStrictEqual({ ...r.outcome, source: again.source }, again);
    assert.strictEqual(r.validBars, 2, 'the window it was measured over');
  }
});

test('the limit window is the strategy\'s valid_bars (the plan the gate allows): required, kept on each record; one bar fills fewer; an index mixing windows is refused', () => {
  assert.strictEqual(L.strategyValidBars(path.resolve(__dirname, '..', '..'), {}), 2, 'the shipped trade_lifecycle');
  for (const bad of [undefined, 0, 1.5, '2']) assert.throws(() => L.scanLibrary({ bars: BARS, root: 'MNQ', from: '2020-04-01', to: '2020-06-01', eodOf: CLOCK.eodOf, inSession: CLOCK.inSession, validBars: bad }), /validBars: the trade_lifecycle strategy's valid_bars/, String(bad));
  const one = scan(BARS, 1);
  const traded = rs => rs.filter(r => r.status === 'traded');
  const filled = rs => traded(rs).filter(r => r.outcome.filled).length;
  assert.deepStrictEqual(one.map(r => r.id), RECORDS.map(r => r.id), 'the same moments and plans');
  assert.ok(filled(one) < filled(RECORDS), `one bar fills ${filled(one)}, two ${filled(RECORDS)}`);
  assert.ok(one.every(r => r.validBars === 1));
  assert.throws(() => L.buildLibraryIndex([...one.slice(0, 5), ...RECORDS.slice(5, 10)], { reps: 10 }), /different limit windows \(valid_bars 1, 2\)/);
  assert.strictEqual(L.buildLibraryIndex(RECORDS, { reps: 10 }).validBars, 2);
});

test('signature parity: a record\'s reads, checked by compose_check\'s checker on its bar\'s briefing, are all true and give its signature', () => {
  for (const r of RECORDS.filter(x => x.status === 'traded').slice(0, 15)) {
    const ch = checkReads({ reads: r.reads, side: r.side, briefing: briefAt(r.bar), tick: 0.25 });
    assert.strictEqual(ch.ok, true, `${r.id}: ${ch.problems.join('; ')}`);
    assert.ok(ch.reads.every(x => x.check === true));
    assert.strictEqual(ch.signature, r.signature);
    assert.deepStrictEqual(ch.context, r.context);
    assert.deepStrictEqual(r.reads.map(x => x.step), ['bias', 'location', 'setup', 'entry', 'stop', 'target']);
  }
});

test('causal: changing the bars after a point changes no read, plan or signature of a moment confirmed before it (only outcomes look ahead)', () => {
  const cut = BARS.findIndex(b => b.t >= '2020-05-01T16:00:00.000Z');
  const moved = BARS.map((b, i) => (i <= cut ? b : { ...b, o: b.o + 300, h: b.h + 700, l: b.l - 700, c: b.c - 300 }));
  const other = scan(moved);
  // A moment whose whole window (its 15m candle's life after the reaction) ended by the cut.
  const before = r => Date.parse(r.reactionAt) + 15 * 60000 <= Date.parse(BARS[cut].t) + 180000;
  const key = r => JSON.stringify([r.id, r.bar, r.status, r.reads, r.signature, r.plan]);
  assert.deepStrictEqual(other.filter(before).map(key), RECORDS.filter(before).map(key));
  assert.ok(RECORDS.filter(before).length > 20);
});

test('index: walk-forward by day (a lookup on day D sees only rows known before D, an exit on a later day dates its row), hashed, pinned per run', () => {
  const doc = L.buildLibraryIndex(RECORDS, { reps: 200, sources: [{ file: '/x/lib.jsonl', sha256: 'a' }] });
  assert.strictEqual(doc.kind, 'setup-library');
  assert.strictEqual(doc.hash, L.libraryHash(doc));
  assert.deepStrictEqual(doc.sources, [{ file: 'lib.jsonl', sha256: 'a' }], 'no machine path');
  const traded = RECORDS.filter(r => r.status === 'traded');
  const sig = traded[0].signature;
  const key = X.cellKey('read', sig);
  for (const day of ['2020-04-30', '2020-05-01', '2020-05-04', '2020-05-05']) {
    const c = L.libraryCellAt(doc, key, day);
    const want = traded.filter(r => r.signature === sig && X.knownDay(r) < day);
    assert.strictEqual(c.n + c.unfilled, want.length, `rows before ${day}`);
    assert.ok(c.lastSeen === null || c.lastSeen < day);
  }
  assert.ok(L.noRoomBefore(doc, RECORDS.find(r => r.status === 'no-room').setupKey, '2099-01-01') >= 1);
  // A row is dated by the day its outcome came.
  const carried = { ...traded[0], id: 'carry', outcome: { ...traded[0].outcome, filled: true, R: 1, exitTime: '2020-05-01T15:00:00.000Z' }, bar: '2020-04-30T15:00:00.000Z' };
  const one = L.buildLibraryIndex([carried], { reps: 50 });
  assert.strictEqual(one.cells[X.cellKey('read', sig)][0][0], '2020-05-01');
  // Pinned: the run keeps its library; another is refused; a run not learning has none.
  const home = tmpHome();
  const file = L.writeLibrary(path.join(home, 'built'), doc);
  assert.strictEqual(L.pinLibrary(home, file).hash, doc.hash);
  assert.strictEqual(L.loadPinnedLibrary(home).hash, doc.hash);
  assert.throws(() => L.pinLibrary(home, L.writeLibrary(path.join(home, 'built'), one)), /a run keeps its library/);
  // An index measured over another window than the strategy's valid_bars is never pinned (one bar against the shipped
  // two; or the shipped two once a strategy says three).
  const oneBar = L.buildLibraryIndex(scan(BARS, 1), { reps: 20 });
  assert.throws(() => L.pinLibrary(tmpHome(), L.writeLibrary(path.join(home, 'built1'), oneBar)), /limits valid 1 bar\(s\); the trade_lifecycle strategy's valid_bars is 2: scan and index it again/);
  assert.throws(() => L.pinLibrary(tmpHome(), file, { validBars: 3 }), /valid_bars is 3/);
  assert.strictEqual(L.pinLibrary(tmpHome(), L.writeLibrary(path.join(home, 'built1'), oneBar), { validBars: 1 }).hash, oneBar.hash);
  fs.writeFileSync(path.join(home, 'built', 'bad.json'), JSON.stringify({ ...doc, records: 1 }));
  assert.throws(() => L.readLibrary(path.join(home, 'built', 'bad.json')), /doesn't match its hash/);
  assert.throws(() => L.readLibrary(path.join(home, 'built', path.basename(file)).replace('library-', 'nope-')), /ENOENT/);
});

/** Library records in the experience fixture's combination (record(): its read signature, context and setup read). */
function libraryFor(rec, { n = 24 } = {}) {
  const days = Array.from({ length: 12 }, (_, i) => `2022-03-${String(i + 1).padStart(2, '0')}`);
  return Array.from({ length: n }, (_, i) => ({
    v: L.VERSION, validBars: 2, id: `l${i}`, root: 'MNQ', day: days[i % 12], bar: `${days[i % 12]}T15:00:00.000Z`, status: i === n - 1 ? 'no-room' : 'traded', side: 'long',
    reads: rec.reads.map(r => ({ step: r.step, skill: r.skill, read: r.read })), signature: rec.signatures.read, setupKey: L.setupKeyOf(rec.reads), context: rec.context,
    outcome: { filled: true, R: i % 3 ? 2 : -1, exitTime: `${days[i % 12]}T16:00:00.000Z` },
  }));
}

test('experience_lookup: the history library in a section of its own, after the model\'s record, within 4 KB; the learning report keeps it apart', () => {
  const AT = '2023-03-15T14:00:00.000Z';
  const rec = fromLifecycleRecord(record({ at: AT }));
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'trade-lifecycle'));
  const long = record({ at: AT });
  long.reads = long.reads.map(r => ({ ...r, why: 'w'.repeat(160) }));
  fs.writeFileSync(path.join(home, 'trade-lifecycle', 'MNQ.jsonl'), `${JSON.stringify(long)}\n`);
  const ctx = { env: { FTH_HOME: home }, now: () => new Date('2023-03-15T14:01:00.000Z') };
  // No library pinned: the lookup is as before.
  const plain = H.experienceLookup({ symbol: 'MNQ' }, ctx).text;
  assert.doesNotMatch(plain, /History library/);
  L.pinLibrary(home, L.writeLibrary(path.join(home, 'built'), L.buildLibraryIndex(libraryFor(rec), { reps: 200 })), { display: true });
  const text = H.experienceLookup({ symbol: 'MNQ' }, ctx).text;
  assert.match(text, /No experience index is pinned for this run: no record\.\nHistory library [0-9a-f]{16} \(code-measured, not your decisions\): every number is the standard plan's \(a limit at the confirmation close.*\), not your own stop and target; no record for a signature means the standard never composes it, not that it fails:/);
  assert.match(text, /- read signature, any context: n 23 \(12 days, 0 unfilled\), win 0\.\d\d \[0\.\d\d, [01]\.\d\d\]\n/);
  assert.match(text, /- setup:15m-rejected-prior-vah-up, any context: n 23 \(12 days, 0 unfilled\), win 0\.\d\d \[0\.\d\d, [01]\.\d\d\]; 1 more had no room at 2:1/);
  // Counts, the win rate and no-room only: never an R (the library measures one fixed plan, not the model's trades).
  const libText = text.slice(text.indexOf('History library'));
  assert.doesNotMatch(libText, /mean R|\bR\b|\blast \d/, libText);
  assert.ok(Buffer.byteLength(text) <= H.MAX_BYTES);
  assert.doesNotMatch(text, /\b(should|enter|take it|avoid)\b/i, 'never advice');
  // With the model's own index too: its record first; the cap drops the library's lines before the model's cells.
  const X2 = X.buildIndex(libraryFor(rec).filter(r => r.status === 'traded').map((r, i) => ({ id: `p${i}`, day: r.day, bar: r.bar, decision: 'entered', side: 'long', signatures: rec.signatures, reads: long.reads, context: rec.context, outcome: { R: r.outcome.R } })), { reps: 200 });
  X.pinIndex(home, X.writeIndex(path.join(home, 'built'), X2));
  const both = H.experienceLookup({ symbol: 'MNQ' }, ctx).text;
  // The library (code-measured, not the model's) goes first when over the cap; when shown, it follows the model's record.
  const libAt = both.indexOf('History library') === -1 ? Infinity : both.indexOf('History library');
  assert.ok(both.indexOf('Cells:') < libAt, 'the model\'s record first');
  assert.ok(Buffer.byteLength(both) <= H.MAX_BYTES, `${Buffer.byteLength(both)} bytes`);
  const modelCells = both.split('\n').filter(l => /^- (read|skill) signature, /.test(l) && both.indexOf(l) < libAt);
  assert.ok(modelCells.length >= 2);
  const lib = L.loadPinnedLibrary(home);
  const section = H.librarySection(lib, rec, '2023-03-15');
  assert.strictEqual(section.length, 5);
  // Walk-forward in the section: an earlier candidate's day sees fewer rows and fewer no-room days.
  const early = H.librarySection(lib, rec, '2022-03-07');
  assert.match(early.find(l => /read signature, any context/.test(l)), /too few samples \(n=12, 6 days\)/);
  assert.match(section.find(l => /read signature, any context/.test(l)), /n 23 \(12 days/);
  assert.match(early.find(l => /any context/.test(l) && /^- setup:/.test(l)), /too few samples \(n=12, 6 days\)$/, 'the no-room day (the 12th) is after it');
  // A pin whose hash isn't its file's is refused; an unreadable library is said, whatever the cap.
  const pinFile = path.join(home, 'experience', 'library-pinned.json');
  const pin = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
  fs.writeFileSync(pinFile, JSON.stringify({ ...pin, hash: 'f'.repeat(64) }));
  assert.throws(() => L.loadPinnedLibrary(home), /the pinned library's hash ffffffffffffffff is not its file's/);
  assert.match(H.experienceLookup({ symbol: 'MNQ' }, ctx).text, /History library \(code-measured, not your decisions\): unreadable \(the pinned library's hash/);
  fs.writeFileSync(pinFile, JSON.stringify(pin));
  // The learning report: the library's hash, apart; none of its rows in the measures.
  const m = R.learningMeasures({ library: { hash: lib.hash.slice(0, 16), shown: true } });
  assert.deepStrictEqual({ ...m, library: null }, R.learningMeasures({}));
  assert.match(R.learningMarkdown(m), /History library [0-9a-f]{16} pinned: code-measured, shown in experience_lookup apart; never counted below or as the model's record/);
  assert.match(R.learningMarkdown(R.learningMeasures({ library: { hash: lib.hash.slice(0, 16), shown: false } })), /History library [0-9a-f]{16} pinned: code-measured, not shown to the model \(its display off\)/);
});

test('experience_lookup: a pinned library is hidden unless the run enables its display; the pin keeps the choice', () => {
  const AT = '2023-03-15T14:00:00.000Z';
  const rec = fromLifecycleRecord(record({ at: AT }));
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'trade-lifecycle'));
  fs.writeFileSync(path.join(home, 'trade-lifecycle', 'MNQ.jsonl'), `${JSON.stringify(record({ at: AT }))}\n`);
  const ctx = { env: { FTH_HOME: home, FTH_CYCLE_TRANSCRIPT: path.join(home, 'cycle.jsonl') }, now: () => new Date('2023-03-15T14:01:00.000Z') };
  const file = L.writeLibrary(path.join(home, 'built'), L.buildLibraryIndex(libraryFor(rec), { reps: 200 }));
  // Pinned alone: code's (loadPinnedLibrary reads it), never the model's.
  assert.strictEqual(L.pinLibrary(home, file).display, false);
  assert.strictEqual(L.loadPinnedLibrary(home).hash.length, 64);
  assert.strictEqual(L.libraryShown(home), false);
  const hidden = H.experienceLookup({ symbol: 'MNQ' }, ctx).text;
  assert.doesNotMatch(hidden, /History library|history library/);
  assert.strictEqual(hidden, `${hidden.split('\n').slice(0, 5).join('\n')}\n`, 'the lookup as it is without a library');
  const lookups = require('../../scripts/lib/learning/experience-lookups');
  assert.strictEqual(lookups.readExperienceLookups(ctx.env.FTH_CYCLE_TRANSCRIPT)[0].library, undefined, 'its record names no library it was not shown');
  // A broken library while hidden says nothing either (the model is never told of it).
  const pinFile = path.join(home, 'experience', 'library-pinned.json');
  const pin = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
  assert.strictEqual(pin.display, false, 'a hidden pin says so (a pin without the key is from before the flag)');
  fs.writeFileSync(pinFile, JSON.stringify({ ...pin, hash: 'f'.repeat(64) }));
  assert.doesNotMatch(H.experienceLookup({ symbol: 'MNQ' }, ctx).text, /History library/);
  fs.writeFileSync(pinFile, JSON.stringify(pin));
  // A run keeps its display: a resume asking for the other is refused; the same is fine.
  assert.throws(() => L.pinLibrary(home, file, { display: true }), /pinned its library with the display off; a run keeps it/);
  assert.throws(() => L.pinLibrary(home, file, { display: 'yes' }), /display: true or false/);
  assert.strictEqual(L.pinLibrary(home, file, { display: false }).display, false);
  // Only an explicit true shows it.
  for (const display of [1, 'true', null]) {
    fs.writeFileSync(pinFile, JSON.stringify({ ...pin, display }));
    assert.strictEqual(L.libraryShown(home), false, String(display));
  }
  const shownHome = tmpHome();
  fs.mkdirSync(path.join(shownHome, 'trade-lifecycle'));
  fs.writeFileSync(path.join(shownHome, 'trade-lifecycle', 'MNQ.jsonl'), `${JSON.stringify(record({ at: AT }))}\n`);
  L.pinLibrary(shownHome, file, { display: true });
  assert.strictEqual(L.libraryShown(shownHome), true);
  const shownEnv = { FTH_HOME: shownHome, FTH_CYCLE_TRANSCRIPT: path.join(shownHome, 'cycle.jsonl') };
  assert.match(H.experienceLookup({ symbol: 'MNQ' }, { ...ctx, env: shownEnv }).text, /History library [0-9a-f]{16} \(code-measured/);
  assert.strictEqual(lookups.readExperienceLookups(shownEnv.FTH_CYCLE_TRANSCRIPT)[0].library, L.loadPinnedLibrary(shownHome).hash);
  assert.throws(() => L.pinLibrary(shownHome, file), /pinned its library with the display on; a run keeps it/);
});

test('one briefing, one context key: the library\'s cells and experience_lookup\'s candidate key the same context, and the lookup shows a this-context cell', () => {
  // A traded scan record whose raw context (compose_check's: trendSide, raw case) differs from the record's view.
  const r = RECORDS.find(x => x.status === 'traded' && x.context && x.context.trendSide);
  assert.ok(r, 'the fixture has a traded record with a trend side');
  const ch = checkReads({ reads: r.reads, side: r.side, briefing: briefAt(r.bar), tick: 0.25 });
  assert.deepStrictEqual(ch.context, r.context, 'the scan keeps the checker\'s context');
  // The trade_lifecycle record compose_check writes on that briefing: its context the checker's, as the library's.
  const AT = '2023-03-15T14:00:00.000Z';
  const raw = { ...record({ at: AT, side: r.side }), reads: r.reads.map(x => ({ ...x, check: 'true' })), signature: r.signature, context: ch.context };
  const cand = fromLifecycleRecord(raw);
  const days = Array.from({ length: 12 }, (_, i) => `2022-03-${String(i + 1).padStart(2, '0')}`);
  const lib = Array.from({ length: 24 }, (_, i) => ({ ...r, id: `k${i}`, day: days[i % 12], bar: `${days[i % 12]}T15:00:00.000Z`, outcome: { filled: true, R: i % 3 ? 2 : -1, exitTime: `${days[i % 12]}T16:00:00.000Z` } }));
  const doc = L.buildLibraryIndex(lib, { reps: 200 });
  const key = X.cellKey('read', r.signature, X.contextKey(cand.context));
  assert.ok(doc.cells[key], `the library keys the candidate's context: ${key}`);
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'trade-lifecycle'));
  fs.writeFileSync(path.join(home, 'trade-lifecycle', 'MNQ.jsonl'), `${JSON.stringify(raw)}\n`);
  L.pinLibrary(home, L.writeLibrary(path.join(home, 'built'), doc), { display: true });
  const text = H.experienceLookup({ symbol: 'MNQ' }, { env: { FTH_HOME: home }, now: () => new Date('2023-03-15T14:01:00.000Z') }).text;
  assert.match(text, /- read signature, this context: n 24 \(12 days/);
});

test('the cap drops the library\'s lines before the model\'s cells', () => {
  const line = (k, n) => `- ${k} ${n} ${'x'.repeat(90)}`;
  const cells = Array.from({ length: 33 }, (_, i) => line('cell', i));
  const lib = ['History library header', ...Array.from({ length: 10 }, (_, i) => line('lib', i))];
  const text = H.capped(['head'], cells.slice(), ['similar'], ['tail'], lib.slice());
  assert.ok(Buffer.byteLength(text) <= H.MAX_BYTES);
  assert.ok(cells.every(c => text.includes(c)), 'every model cell kept');
  assert.ok(text.includes('lib 0') && !text.includes('lib 9'), 'the library\'s last lines dropped');
  // More than the library can free: it goes entirely, then the model's cells are trimmed from the end (they run most
  // specific first: the "this context" cells lead and stay; the least specific go first).
  const many = Array.from({ length: 45 }, (_, i) => line('cell', i));
  const tight = H.capped(['head'], many.slice(), ['similar'], ['tail'], lib.slice());
  assert.ok(!tight.includes('History library header') && tight.includes('cell 0') && tight.includes('cell 1') && !tight.includes('cell 44'));
});

test('CLI: scan, index, pin and show on fixture bars', () => {
  const dir = tmpHome('fth-lib-cli-');
  const bars = path.join(dir, 'MNQ-3m.json');
  fs.writeFileSync(bars, JSON.stringify(BARS));
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'setup-library.js'), ...args], { encoding: 'utf8', env: { ...process.env, FTH_HOME: dir } });
  const lib = path.join(dir, 'lib.jsonl');
  let r = cli('scan', '--bars', bars, '--root', 'MNQ', '--from', '2020-04-01', '--to', '2020-06-01', '--out', lib);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /reaction moment\(s\) of MNQ 2020-04-01\.\.2020-06-01: .*traded \d+/);
  assert.strictEqual(fs.readFileSync(lib, 'utf8').trim().split('\n').length, RECORDS.length);
  r = cli('scan', '--bars', bars, '--root', 'MNQ', '--from', '2025-01-01', '--to', '2025-02-01', '--out', lib);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /practice refused/);
  r = cli('index', lib, '--out', path.join(dir, 'idx'));
  assert.strictEqual(r.status, 0, r.stderr);
  const file = path.join(dir, 'idx', fs.readdirSync(path.join(dir, 'idx'))[0]);
  assert.strictEqual(cli('index', lib, lib).status, 1, 'the same file twice is refused');
  const run = path.join(dir, 'run');
  fs.mkdirSync(run);
  assert.strictEqual(cli('pin', file, run).status, 0);
  r = cli('show', file);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^history library [0-9a-f]{16}: \d+ records, 2020-04-\d\d to 2020-05-\d\d; one fixed standard/);
});

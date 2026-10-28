'use strict';

// The per-session bars archive (scripts/lib/session/bars-archive.js, R35): appended, gzip JSON lines,
// every field kept, a torn append skipped with every later one kept, the day before's overlap never
// archived again, and retention (live sessions only) by days and size.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { tmpDir } = require('../helpers');
const A = require('../../scripts/lib/session/bars-archive');

const iso = ms => new Date(ms).toISOString();
const T0 = Date.parse('2026-10-07T14:00:00Z');
const bar = k => ({ t: iso(T0 + k * 60000), o: 1, h: 2, l: 0, c: 1, v: k, deep: { a: { b: k / 10 }, n: null, s: 'x' } });
const range = (a, b) => Array.from({ length: b - a }, (_, k) => a + k);

test('archive: appended per call (never rewritten), only bars newer than the last archived, every field and the contract kept', () => {
  const dir = path.join(tmpDir(), 'sessions', '2026-10-07');
  const day = '2026-10-07';
  const first = A.appendBars(dir, day, { symbol: 'MNQ', contractId: 'C1', minutes: 1, bars: [0, 1, 2].map(bar) });
  assert.deepStrictEqual(first, { added: 3, created: true });
  const size1 = fs.statSync(A.archiveFile(dir, day)).size;
  const head = fs.readFileSync(A.archiveFile(dir, day));
  // The next poll's window overlaps: only the new bar goes on, appended after the bytes already there.
  assert.deepStrictEqual(A.appendBars(dir, day, { symbol: 'MNQ', contractId: 'C1', minutes: 1, bars: [1, 2, 3].map(bar) }), { added: 1, created: false });
  assert.deepStrictEqual(A.appendBars(dir, day, { symbol: 'MNQ', contractId: 'C1', minutes: 1, bars: [1, 2, 3].map(bar) }), { added: 0, created: false });
  const after = fs.readFileSync(A.archiveFile(dir, day));
  assert.ok(after.length > size1 && after.subarray(0, size1).equals(head), 'the earlier bytes untouched');
  // Another symbol, or a new contract of the same one (a roll), is archived on its own, its bars marked with it.
  A.appendBars(dir, day, { symbol: 'MES', contractId: 'C2', minutes: 1, bars: [2].map(bar) });
  A.appendBars(dir, day, { symbol: 'MNQ', contractId: 'C9', minutes: 1, bars: [2].map(k => ({ ...bar(k), c: 9 })) });
  // Plain gzip: any gunzip reads it (each append a member).
  const text = zlib.gunzipSync(fs.readFileSync(A.archiveFile(dir, day))).toString('utf8');
  assert.strictEqual(text.trim().split('\n').length, 6);
  const lines = A.readArchive(A.archiveFile(dir, day));
  assert.deepStrictEqual(lines.map(x => [x.symbol, x.contractId, x.minutes, x.bar.t]), [
    ['MNQ', 'C1', 1, bar(0).t], ['MNQ', 'C1', 1, bar(1).t], ['MNQ', 'C1', 1, bar(2).t], ['MNQ', 'C1', 1, bar(3).t], ['MES', 'C2', 1, bar(2).t], ['MNQ', 'C9', 1, bar(2).t],
  ]);
  assert.deepStrictEqual(lines[3].bar, bar(3), 'every field the broker sent, nested and null ones too');
  const got = A.archivedBars(dir);
  // By contract: the roll's two bars at one time stay apart; without a contract, only a time one contract has.
  assert.deepStrictEqual(got.get('MNQ', 'C1', 1, bar(2).t), bar(2));
  assert.strictEqual(got.get('MNQ', 'C9', 1, bar(2).t).c, 9);
  assert.deepStrictEqual(got.get('MNQ', null, 1, bar(2).t), bar(2), 'two contracts at that time: the first archived (the front when the bar closed), never none');
  assert.deepStrictEqual(got.get('MNQ', null, 1, bar(3).t), bar(3));
  assert.strictEqual(got.get('MNQ', 'C1', 3, bar(3).t), null, 'another timeframe');
  assert.strictEqual(A.readArchive(path.join(dir, 'none.gz')).length, 0);
});

test('archive: a torn append is skipped and every later append kept; the bars it held come back with the next poll', () => {
  const dir = tmpDir();
  const day = '2026-10-07';
  A.appendBars(dir, day, { symbol: 'MNQ', minutes: 1, bars: [0, 1].map(bar) });
  const file = A.archiveFile(dir, day);
  const whole = fs.readFileSync(file).length;
  // A crash mid-append: half a member written, the index never updated.
  const member = zlib.gzipSync(`${[2, 3, 4].map(k => JSON.stringify({ symbol: 'MNQ', contractId: null, minutes: 1, bar: bar(k) })).join('\n')}\n`);
  fs.appendFileSync(file, member.subarray(0, Math.floor(member.length / 2)));
  assert.deepStrictEqual(A.readArchive(file).map(x => x.bar), [bar(0), bar(1)], 'the torn tail: what is whole');
  // The restarted runner appends again after the tear: those bars (its index never moved) and the next.
  assert.deepStrictEqual(A.appendBars(dir, day, { symbol: 'MNQ', minutes: 1, bars: [1, 2, 3, 4].map(bar) }), { added: 3, created: false });
  A.appendBars(dir, day, { symbol: 'MNQ', minutes: 1, bars: [5].map(bar) });
  assert.ok(fs.readFileSync(file).length > whole + member.length / 2);
  assert.deepStrictEqual(A.readArchive(file).map(x => x.bar), range(0, 6).map(bar), 'every bar but the torn member\'s copy, once each');
  // A lost index repeats bars; readers keep the first of each.
  fs.rmSync(A.indexFile(dir, day));
  A.appendBars(dir, day, { symbol: 'MNQ', minutes: 1, bars: [4, 5].map(bar) });
  assert.strictEqual(A.readArchive(file).length, 8);
  assert.strictEqual(A.archivedBars(dir).size, 6, 'each bar once');
});

/** The member an append of these bars would write (a torn one is a prefix of it). */
const memberOf = ks => zlib.gzipSync(ks.map(k => `${JSON.stringify({ symbol: 'MNQ', contractId: null, minutes: 1, bar: bar(k) })}\n`).join(''));

test('archive: a torn append of any length, at the head, the middle or the tail, never loses an indexed bar', () => {
  const day = '2026-10-07';
  const torn = memberOf([90, 91]);
  for (const where of ['head', 'middle', 'tail']) {
    for (let len = 1; len < torn.length; len += 1) {
      const dir = tmpDir();
      const file = A.archiveFile(dir, day);
      const tear = () => fs.appendFileSync(file, torn.subarray(0, len)); // a crash mid-append: the index never moved
      if (where === 'head') {
        // The day's first append torn: it is written aside, so only its temporary file is left, never the archive.
        fs.writeFileSync(`${file}.12345.tmp`, torn.subarray(0, len));
        assert.ok(!fs.existsSync(file));
      }
      A.appendBars(dir, day, { symbol: 'MNQ', minutes: 1, bars: [0, 1].map(bar) });
      if (where === 'middle') tear();
      A.appendBars(dir, day, { symbol: 'MNQ', minutes: 1, bars: [1, 2, 3].map(bar) });
      if (where === 'tail') tear();
      // The next poll after the crash: the torn bytes cut off, then its bars.
      A.appendBars(dir, day, { symbol: 'MNQ', minutes: 1, bars: [3, 4, 5].map(bar) });
      const got = A.readArchive(file).map(x => x.bar);
      assert.deepStrictEqual(got, range(0, 6).map(bar), `${where}, ${len} of ${torn.length} bytes torn`);
      assert.strictEqual(fs.statSync(file).size, JSON.parse(fs.readFileSync(A.indexFile(dir, day), 'utf8'))[A.BYTES], 'the index commits the file\'s length');
    }
  }
});

test('reader: a member that doesn\'t decode whole is skipped and every member after it kept (a file whose index was lost)', () => {
  const file = path.join(tmpDir(), 'bars-2026-10-07.jsonl.gz');
  const torn = memberOf([2, 3]);
  for (const len of [3, Math.floor(torn.length / 2), torn.length - 1]) {
    fs.writeFileSync(file, Buffer.concat([memberOf([0, 1]), torn.subarray(0, len), memberOf([4]), memberOf([5])]));
    assert.deepStrictEqual(A.readArchive(file).map(x => x.bar), [0, 1, 4, 5].map(bar), `${len} bytes torn`);
  }
});

test('archive: the data is synced before the index moves - a crash between them repeats bars, never loses them', () => {
  const dir = tmpDir();
  const day = '2026-10-07';
  A.appendBars(dir, day, { symbol: 'MNQ', minutes: 1, bars: [0, 1].map(bar) });
  const before = fs.readFileSync(A.indexFile(dir, day), 'utf8');
  // The machine goes down while the append's data is being synced: the index must not have moved yet.
  const sync = fs.fsyncSync;
  let calls = 0;
  fs.fsyncSync = _fd => { calls += 1; throw new Error('power lost'); };
  try {
    assert.throws(() => A.appendBars(dir, day, { symbol: 'MNQ', minutes: 1, bars: [1, 2, 3].map(bar) }), /power lost/);
  } finally {
    fs.fsyncSync = sync;
  }
  assert.strictEqual(calls, 1, 'the data synced first');
  assert.strictEqual(fs.readFileSync(A.indexFile(dir, day), 'utf8'), before, 'the index still says what the file held before');
  // The next poll archives those bars again: each bar once (the unsynced bytes are cut off).
  A.appendBars(dir, day, { symbol: 'MNQ', minutes: 1, bars: [2, 3, 4].map(bar) });
  assert.deepStrictEqual(A.readArchive(A.archiveFile(dir, day)).map(x => x.bar), range(0, 5).map(bar));
  // An index that claims more than the file holds (the data lost after all): forgotten, the window archived again.
  const idx = JSON.parse(fs.readFileSync(A.indexFile(dir, day), 'utf8'));
  fs.writeFileSync(A.indexFile(dir, day), JSON.stringify({ ...idx, [A.BYTES]: idx[A.BYTES] + 1000 }));
  assert.deepStrictEqual(A.appendBars(dir, day, { symbol: 'MNQ', minutes: 1, bars: [4, 5].map(bar) }), { added: 2, created: false }, 'a repeat, never a gap');
  // A day's first append is written aside: a crash during it leaves no archive to glue the next one to.
  const fresh = tmpDir();
  fs.fsyncSync = _fd => { throw new Error('power lost'); };
  try {
    assert.throws(() => A.appendBars(fresh, day, { symbol: 'MNQ', minutes: 1, bars: [0, 1].map(bar) }), /power lost/);
  } finally {
    fs.fsyncSync = sync;
  }
  assert.ok(!fs.existsSync(A.archiveFile(fresh, day)) && !fs.existsSync(A.indexFile(fresh, day)));
  A.appendBars(fresh, day, { symbol: 'MNQ', minutes: 1, bars: [0, 1].map(bar) });
  assert.deepStrictEqual(A.readArchive(A.archiveFile(fresh, day)).map(x => x.bar), [bar(0), bar(1)]);
});

test('archive: the first poll of a day never archives again the window the day before archived', () => {
  for (const replay of [false, true]) {
    const home = tmpDir();
    const env = replay ? { FTH_REPLAY_NOW: 'x', FTH_REPLAY_RECORD_DIR: path.join(home, 'replay', 'r1') } : {};
    let now = new Date('2026-10-07T14:30:00Z');
    const archive = A.barsArchiver({ home, env, minutes: 1, now: () => now, log: () => {} });
    // Day 1: the session's first poll archives its whole window, then one bar a poll.
    assert.deepStrictEqual(archive('MNQ', { bars: range(0, 100).map(bar), contractId: 'C1' }), { added: 100 });
    assert.deepStrictEqual(archive('MNQ', { bars: range(1, 101).map(bar), contractId: 'C1' }), { added: 1 });
    // Day 2's first poll: its window overlaps day 1's by 99 bars; only the new ones go on.
    now = new Date('2026-10-08T14:30:00Z');
    assert.deepStrictEqual(archive('MNQ', { bars: range(3, 103).map(bar), contractId: 'C1' }), { added: 2 });
    // A symbol day 1 never archived: its whole window.
    assert.deepStrictEqual(archive('MES', { bars: range(0, 50).map(bar), contractId: 'C2' }), { added: 50 });
    const dir2 = A.recordDirFor(home, env, '2026-10-08');
    assert.deepStrictEqual(A.readArchive(A.archiveFile(dir2, '2026-10-08')).filter(x => x.symbol === 'MNQ').map(x => x.bar.t), [bar(101).t, bar(102).t], replay ? 'replay' : 'live');
  }
});

/** A home with live session archives for the given days, each `kb` kilobytes or so. */
function homeWith(days, { kb = 0 } = {}) {
  const home = tmpDir();
  for (const day of days) {
    const dir = path.join(home, 'sessions', day);
    A.appendBars(dir, day, { symbol: 'MNQ', minutes: 1, bars: [bar(0)] });
    if (kb) fs.appendFileSync(A.archiveFile(dir, day), zlib.gzipSync(require('crypto').randomBytes(kb * 1024)));
  }
  return home;
}
const left = (home, top = 'sessions') => [...new Set((() => {
  try { return fs.readdirSync(path.join(home, top)).flatMap(d => fs.readdirSync(path.join(home, top, d))); } catch (_err) { return []; }
})().filter(n => n.endsWith('.gz')).map(n => n.slice(5, 15)))].sort();

test('retention: the newest N trading days kept (default 90), then a size cap, oldest first; the newest day never', () => {
  assert.deepStrictEqual(A.retention({}), { days: 90, mb: null });
  assert.deepStrictEqual(A.retention({ FTH_BARS_ARCHIVE_DAYS: '20', FTH_BARS_ARCHIVE_MB: '500' }), { days: 20, mb: 500 });
  assert.deepStrictEqual(A.retention({ FTH_BARS_ARCHIVE_DAYS: '0', FTH_BARS_ARCHIVE_MB: 'x' }), { days: 90, mb: null }, 'nonsense: the default');
  assert.deepStrictEqual(A.retention({ FTH_BARS_ARCHIVE_DAYS: '3650' }), { days: 3650, mb: null });
  const capped = A.retention({ FTH_BARS_ARCHIVE_DAYS: '99999' });
  assert.strictEqual(capped.days, A.MAX_DAYS);
  assert.match(capped.warning, /FTH_BARS_ARCHIVE_DAYS 99999 is above the cap: 3650 trading days kept/);
  const days = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'];
  let home = homeWith(days);
  const removed = A.pruneArchives(home, { days: 3 });
  assert.strictEqual(removed.length, 2);
  assert.deepStrictEqual(left(home), days.slice(-3));
  assert.ok(!fs.existsSync(A.indexFile(path.join(home, 'sessions', '2026-10-01'), '2026-10-01')), 'its index too');
  // Each removed day leaves its marker, so its decisions say pruned; a kept day has none.
  assert.ok(A.wasPruned(path.join(home, 'sessions', '2026-10-01'), '2026-10-01') && A.wasPruned(path.join(home, 'sessions', '2026-10-02'), '2026-10-02'));
  assert.ok(!A.wasPruned(path.join(home, 'sessions', '2026-10-05'), '2026-10-05'));
  assert.deepStrictEqual(A.pruneArchives(home, { days: 3 }), [], 'nothing more over the cap');
  // By size: about 1 MB each, a 2.5 MB cap keeps the newest two.
  home = homeWith(days, { kb: 1024 });
  A.pruneArchives(home, { days: 90, mb: 2.5 });
  assert.deepStrictEqual(left(home), days.slice(-2));
  // A cap below the newest day's size never removes it.
  A.pruneArchives(home, { days: 90, mb: 0.001 });
  assert.deepStrictEqual(left(home), days.slice(-1));
  assert.deepStrictEqual(A.pruneArchives(tmpDir(), {}), [], 'an empty home');
});

test('retention: a replay run\'s archive is its data, never pruned, however long the run', () => {
  const home = tmpDir();
  const runDir = path.join(home, 'replay', 'r1');
  const env = { FTH_REPLAY_NOW: 'x', FTH_REPLAY_RECORD_DIR: runDir, FTH_BARS_ARCHIVE_DAYS: '2', FTH_BARS_ARCHIVE_MB: '0.0001' };
  let now = null;
  const archive = A.barsArchiver({ home, env, minutes: 1, now: () => now, log: () => {} });
  const days = range(1, 6).map(d => `2026-10-0${d}`);
  for (const [i, d] of days.entries()) {
    now = new Date(`${d}T14:30:00Z`);
    archive('MNQ', { bars: [bar(i)], contractId: 'C1' });
  }
  assert.deepStrictEqual(left(home, 'replay'), days.map(d => d), 'day 1 survives a run longer than the day cap');
  // The prune itself never looks at replay runs either.
  assert.deepStrictEqual(A.pruneArchives(home, { days: 1 }), []);
  assert.deepStrictEqual(left(home, 'replay'), days);
});

test('archiver: the live session\'s dir, or a replay step\'s record dir; prunes live archives when a day starts; never throws', () => {
  assert.strictEqual(A.recordDirFor('/h', {}, '2026-10-07'), path.join('/h', 'sessions', '2026-10-07'));
  assert.strictEqual(A.recordDirFor('/h', { FTH_REPLAY_RECORD_DIR: '/r/replay/x' }, '2026-10-07'), path.join('/h', 'sessions', '2026-10-07'), 'only under a replay clock');
  assert.strictEqual(A.recordDirFor('/h', { FTH_REPLAY_NOW: 'x', FTH_REPLAY_RECORD_DIR: '/r/replay/x' }, '2026-10-07'), path.resolve('/r/replay/x'));
  const home = homeWith(['2026-10-01', '2026-10-02']);
  let now = new Date('2026-10-07T14:03:02Z');
  const errors = [];
  const archive = A.barsArchiver({ home, env: { FTH_BARS_ARCHIVE_DAYS: '2' }, minutes: 1, now: () => now, log: (m, l) => errors.push([m, l]) });
  assert.deepStrictEqual(archive('MNQ', { bars: [5, 6].map(bar), contractId: 'C' }), { added: 2 });
  assert.deepStrictEqual(left(home), ['2026-10-02', '2026-10-07'], 'the new day\'s file started: the oldest beyond 2 days pruned');
  assert.strictEqual(A.readArchive(A.archiveFile(path.join(home, 'sessions', '2026-10-07'), '2026-10-07')).length, 2);
  // A home that can't be written: logged, never thrown (recording never stops the runner).
  const file = path.join(tmpDir(), 'a-file');
  fs.writeFileSync(file, '');
  now = new Date('2026-10-08T14:03:02Z');
  const broken = A.barsArchiver({ home: file, env: {}, minutes: 1, now: () => now, log: (m, l) => errors.push([m, l]) });
  assert.strictEqual(broken('MNQ', { bars: [bar(0)] }), null);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0][0], /MNQ: could not archive the bars/);
});

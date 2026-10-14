'use strict';

// experience_lookup (scripts/lib/harness-tools/experience.js) and its record (scripts/lib/learning/experience-lookups.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('../../scripts/lib/harness-tools/experience');
const L = require('../../scripts/lib/learning/experience-lookups');
const X = require('../../scripts/lib/learning/experience-index');
const { fromLifecycleRecord } = require('../../scripts/lib/learning/lifecycle-record');
const { BY_NAME, listTools } = require('../../scripts/lib/harness-tools/registry');
const { validate } = require('../../scripts/lib/harness-tools/validate');
const { record, tmpHome } = require('../fixtures/learning');

const AT = '2023-03-15T14:00:00.000Z';
const NOW = () => new Date('2023-03-15T14:01:00.000Z');

/** A home with one verified record at AT, and (pin) an index built from `n` past decisions of the same combination. */
function home({ pin = true, n = 24, records = [record({ at: AT })], transcript = true } = {}) {
  const h = tmpHome();
  fs.mkdirSync(path.join(h, 'trade-lifecycle'));
  fs.writeFileSync(path.join(h, 'trade-lifecycle', 'MNQ.jsonl'), records.map(r => `${JSON.stringify(r)}\n`).join(''));
  if (pin) {
    const r = fromLifecycleRecord(record({ at: AT }));
    const days = Array.from({ length: 12 }, (_, i) => `2022-03-${String(i + 1).padStart(2, '0')}`);
    const past = Array.from({ length: n }, (_, i) => ({
      id: `p${i}`, day: days[i % 12], decision: i % 2 ? 'entered' : 'passed', side: 'long', signatures: r.signatures, reads: r.reads,
      context: i % 3 ? r.context : { ...r.context, regime: 'range' }, outcome: { R: i % 2 ? 2 : -1 }, grade: i % 2 ? 'win' : 'good-pass',
    }));
    const file = X.writeIndex(path.join(h, 'built'), X.buildIndex(past, { reps: 200 }));
    X.pinIndex(h, file);
  }
  const env = { FTH_HOME: h, ...(transcript ? { FTH_CYCLE_TRANSCRIPT: path.join(h, 'cycle.jsonl') } : {}) };
  return { h, env, ctx: { env, now: NOW, wallNow: () => 1000 } };
}

test('experience_lookup: the candidate\'s signatures and context, its cells exact first, similar decisions, the index; under 4 KB', () => {
  const { ctx, env } = home();
  const { text } = H.experienceLookup({ symbol: 'MNQ', role: 'risk-manager' }, ctx);
  const lines = text.split('\n');
  assert.match(lines[0], /^Experience for MNQ long, bar 2023-03-15T13:57:00.000Z:/);
  assert.match(text, /skill signature: bias:bos-vs-choch\+location:vwap-volume-profile/);
  assert.match(text, /context: regime=trend-up;volatility=normal;window=ny-am;biasSide=with;alignment=aligned;dayType=normal/);
  const cells = lines.filter(l => l.startsWith('- ') && /signature|alternative/.test(l));
  assert.match(cells[0], /^- read signature, this context: too few samples \(n=16, 8 days\)/);
  assert.match(cells.find(l => l.includes('skill signature, any context')), /n 24 \(12 days; 12 entered, 12 passed\), win 0\.50 \[0\.\d+, 0\.\d+\], mean R 0\.50 \[/);
  assert.match(text, /Similar past decisions \(same skills, closest context\):\n- 2022-03-12 long entered, 2\.00R win: bias 1h bos up \(broke the last swing\)/);
  assert.strictEqual(lines.filter(l => /^- 2022-/.test(l)).length, 3);
  assert.match(text, /Index [0-9a-f]{16}, practice-train 2022-03-01 to 2022-03-12/);
  assert.ok(Buffer.byteLength(text) <= H.MAX_BYTES);
  assert.doesNotMatch(text, /\b(should|enter|take it|avoid)\b/i, 'it never says what to do');
  // Recorded: who asked, the record and the index.
  const rec = L.readExperienceLookups(env.FTH_CYCLE_TRANSCRIPT);
  assert.deepStrictEqual(rec.map(r => [r.at, r.role, r.root, r.bar, r.side]), [[1000, 'risk-manager', 'MNQ', '2023-03-15T13:57:00.000Z', 'long']]);
  assert.match(rec[0].index, /^[0-9a-f]{64}$/);
});

test('experience_lookup: an alternative swaps one step\'s skill; at most two; a step the candidate lacks is refused', () => {
  const { ctx } = home();
  const { text } = H.experienceLookup({ symbol: 'MNQ', alternative: [{ step: 'setup', skill: 'breakout-vs-fakeout' }] }, ctx);
  assert.match(text, /- alternative setup:breakout-vs-fakeout, any context: no record/);
  assert.strictEqual(H.swapStep('bias:a,b+setup:c', 'setup', 'd'), 'bias:a,b+setup:d');
  assert.throws(() => H.experienceLookup({ symbol: 'MNQ', alternative: [{ step: 'exit', skill: 'x' }] }, ctx), /no step "exit"/);
  assert.throws(() => H.experienceLookup({ symbol: 'MNQ', alternative: [1, 2, 3] }, ctx), /at most two/);
  assert.throws(() => H.experienceLookup({ symbol: 'MNQ', alternative: [{ step: 'setup', skill: '../x' }] }, ctx), /alternative: \{ step, skill \}/);
});

test('experience_lookup: two calls a bar, the third refused; a new bar starts again; outside a cycle no budget and no record', () => {
  const { ctx, env } = home();
  H.experienceLookup({ symbol: 'MNQ' }, ctx);
  H.experienceLookup({ symbol: 'MNQ' }, ctx);
  assert.throws(() => H.experienceLookup({ symbol: 'MNQ' }, ctx), /2 calls on this bar already/);
  assert.strictEqual(L.callsOnBar(env, 'MNQ', '2023-03-15T13:57:00.000Z'), 2);
  const next = home({ records: [record({ at: AT }), record({ at: '2023-03-15T14:03:00.000Z' })] });
  fs.copyFileSync(env.FTH_CYCLE_TRANSCRIPT + '.experience.jsonl', next.env.FTH_CYCLE_TRANSCRIPT + '.experience.jsonl');
  assert.ok(H.experienceLookup({ symbol: 'MNQ' }, { ...next.ctx, now: () => new Date('2023-03-15T14:04:00.000Z') }).text);
  const loose = home({ transcript: false });
  for (let i = 0; i < 3; i += 1) H.experienceLookup({ symbol: 'MNQ' }, loose.ctx);
  assert.strictEqual(L.recordExperienceLookup({}, { root: 'MNQ' }), false);
});

test('experience_lookup: no verified unexpired record is refused (nothing recorded); no pinned index says no record', () => {
  const stale = home({ records: [record({ at: AT })] });
  assert.throws(() => H.experienceLookup({ symbol: 'MNQ' }, { ...stale.ctx, now: () => new Date('2023-03-15T14:03:00.000Z') }), /no verified trade_lifecycle record for MNQ/);
  const unverified = home({ records: [record({ at: AT, ok: false })] });
  assert.throws(() => H.experienceLookup({ symbol: 'MNQ' }, unverified.ctx), /call it first/);
  assert.throws(() => H.experienceLookup({ symbol: 'MES' }, unverified.ctx), /no verified/);
  assert.deepStrictEqual(L.readExperienceLookups(unverified.env.FTH_CYCLE_TRANSCRIPT), []);
  const bare = home({ pin: false });
  assert.match(H.experienceLookup({ symbol: 'MNQ' }, bare.ctx).text, /No experience index is pinned for this run: no record\.\n$/);
  assert.throws(() => H.experienceLookup({ symbol: 'mnq' }, bare.ctx), /--symbol/);
  assert.throws(() => H.experienceLookup({ symbol: 'MNQ', role: 'Bad Role' }, bare.ctx), /--role/);
});

test('experience_lookup: the output is capped at 4 KB, dropping whole lines', () => {
  const long = record({ at: AT });
  long.reads = long.reads.map(r => ({ ...r, why: 'w'.repeat(160) }));
  const { ctx } = home({ records: [long] });
  const { text } = H.experienceLookup({ symbol: 'MNQ', alternative: [{ step: 'setup', skill: 'a' }, { step: 'entry', skill: 'b' }] }, ctx);
  assert.ok(Buffer.byteLength(text) <= 4096, String(Buffer.byteLength(text)));
  assert.match(text, /Index [0-9a-f]{16}/, 'the index line is kept');
});

test('the tool: schema, arguments, a short description (its listing under 1 KB), and the CLI', () => {
  const tool = BY_NAME.get('experience_lookup');
  assert.deepStrictEqual(validate(tool.inputSchema, { symbol: 'MNQ', alternative: [{ step: 'setup', skill: 'rejection' }], role: 'risk-manager' }), []);
  assert.match(validate(tool.inputSchema, {}).join(), /symbol/);
  assert.match(validate(tool.inputSchema, { symbol: 'MNQ', alternative: [{ step: 'setup', skill: 'x', extra: 1 }] }).join(), /unknown argument/);
  assert.match(validate(tool.inputSchema, { symbol: 'MNQ', alternative: [{}, {}, {}] }).join(), /at most 2/);
  assert.deepStrictEqual(tool.args({ symbol: 'MNQ' }), { symbol: 'MNQ', alternative: [] });
  const listing = listTools().find(t => t.name === 'experience_lookup');
  assert.ok(Buffer.byteLength(JSON.stringify(listing)) < 1024, 'the tool listing stays under 1 KB');
  assert.deepStrictEqual(H.parseArgv(['--symbol', 'MNQ', '--alternative', 'setup:rejection', '--role=risk-manager']), { symbol: 'MNQ', alternative: [{ step: 'setup', skill: 'rejection' }], role: 'risk-manager' });
  assert.throws(() => H.parseArgv(['--symbol']), /give its value/);
  assert.throws(() => H.parseArgv(['--x']), /unknown argument/);
  const { env } = home({ pin: false, transcript: false });
  // The CLI at the real clock: the 2023 record has expired, so it is refused, nothing printed but the reason.
  const cli = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'experience-lookup.js'), '--symbol', 'MNQ'], { encoding: 'utf8', env: { ...process.env, FTH_REPLAY_NOW: '', ...env } });
  assert.strictEqual(cli.status, 1);
  assert.match(cli.stderr, /^\[experience-lookup\] no verified trade_lifecycle record for MNQ/);
});

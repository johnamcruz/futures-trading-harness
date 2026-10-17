'use strict';

// The runner's record of the roles it ran itself this cycle (runner-roles.js): what the order gate reads beside the transcript.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const RR = require('../../scripts/lib/trading/runner-roles');
const { tmpDir } = require('../helpers');

const T = 1.7e12; // wall-clock ms, as the runner records them
const run = (o = {}) => ({ role: 'market-structure-analyst', start: T, end: T + 1000, text: 'Data: bar_briefing m3@1\nBias: long', lookups: ['breakout'], ok: true, ...o });

test('roleRunsFile: FTH_CYCLE_ROLES, trimmed; unset or blank is none', () => {
  assert.strictEqual(RR.roleRunsFile({ FTH_CYCLE_ROLES: ' /h/logs/r.jsonl ' }), '/h/logs/r.jsonl');
  for (const env of [{}, { FTH_CYCLE_ROLES: '  ' }, null]) assert.strictEqual(RR.roleRunsFile(env), null);
  const f = RR.newRoleRunsFile('/h');
  assert.strictEqual(path.dirname(f), path.join('/h', 'logs'));
  assert.match(path.basename(f), /^cycle-roles-\d+-[0-9a-f]{12}\.jsonl$/);
  assert.notStrictEqual(f, RR.newRoleRunsFile('/h'), 'a file of each cycle\'s own');
});

test('appendRoleRun / readRoleRuns: one line per run, mode 0600, read back in order; lookups deduplicated and sorted', () => {
  const file = path.join(tmpDir(), 'logs', 'r.jsonl');
  RR.appendRoleRun(file, run({ lookups: ['breakout', 'breakout-vs-fakeout', 'breakout'] }));
  RR.appendRoleRun(file, run({ role: 'risk-manager', start: T + 10, end: T + 20, text: '## Risk state', lookups: [], ok: false }));
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  const runs = RR.readRoleRuns(file);
  assert.deepStrictEqual(runs.map(r => [r.role, r.ok]), [['market-structure-analyst', true], ['risk-manager', false]]);
  assert.deepStrictEqual(runs[0].lookups, ['breakout', 'breakout-vs-fakeout']);
});

test('appendRoleRun refuses what is no run: the caller logs it, nothing is written', () => {
  const file = path.join(tmpDir(), 'r.jsonl');
  for (const bad of [run({ role: '' }), run({ role: ' risk-manager' }), run({ start: NaN }), run({ end: T - 1 }), run({ start: 5, end: 10 }), run({ text: null }), run({ lookups: [1] }), run({ ok: 'yes' }), null]) {
    assert.throws(() => RR.appendRoleRun(file, bad), /not a role run/, JSON.stringify(bad));
  }
  assert.throws(() => RR.appendRoleRun(null, run()), /no record file/);
  assert.strictEqual(fs.existsSync(file), false);
});

test('readRoleRuns fails closed: no file, an unreadable or too large one is none; a torn or foreign line is skipped', () => {
  assert.deepStrictEqual(RR.readRoleRuns(null), []);
  assert.deepStrictEqual(RR.readRoleRuns(path.join(tmpDir(), 'none.jsonl')), []);
  const dir = tmpDir();
  assert.deepStrictEqual(RR.readRoleRuns(dir), [], 'a directory is no record');
  const file = path.join(dir, 'r.jsonl');
  fs.writeFileSync(file, [JSON.stringify(run()), '{"role":"risk-manager","start":', JSON.stringify({ role: 'risk-manager', at: T }), '[1,2]', JSON.stringify(run({ role: 'risk-manager' }))].join('\n'));
  assert.deepStrictEqual(RR.readRoleRuns(file).map(r => r.role), ['market-structure-analyst', 'risk-manager']);
  const big = path.join(dir, 'big.jsonl');
  const max = require('../../scripts/lib/tunables').runner().limits.rolesRanBytes;
  fs.writeFileSync(big, `${JSON.stringify(run())}\n${' '.repeat(max)}`);
  assert.deepStrictEqual(RR.readRoleRuns(big), [], 'over the size limit: none');
});

test('asRoleCalls: an ok run with a report is a call marked the runner\'s; a failed or empty one is none; every trade-executor run is a launch', () => {
  const { calls, launches } = RR.asRoleCalls([
    run(), run({ role: 'trend-momentum-analyst', ok: false }), run({ role: 'volume-liquidity-analyst', text: '  ' }),
    run({ role: 'trade-executor', start: T + 50, end: T + 60, ok: false }), run({ role: 'trade-executor', start: T + 70, end: T + 80 }),
  ]);
  assert.deepStrictEqual(calls, [{ role: 'market-structure-analyst', start: T, end: T + 1000, text: 'Data: bar_briefing m3@1\nBias: long', lookups: ['breakout'], source: 'runner' }]);
  assert.deepStrictEqual(launches.map(l => [l.start, l.end, l.background]), [[T + 50, T + 60, false], [T + 70, T + 80, false]]);
  assert.ok(RR.isRunnerCall(calls[0]));
  assert.ok(!RR.isRunnerCall({ role: 'risk-manager', start: T, end: T, text: '' }), 'a transcript call is never the runner\'s');
  assert.deepStrictEqual(RR.asRoleCalls(null), { calls: [], launches: [] });
});

test('removeRoleRuns: the file is gone; none is nothing', () => {
  const file = path.join(tmpDir(), 'r.jsonl');
  RR.appendRoleRun(file, run());
  RR.removeRoleRuns(file);
  assert.strictEqual(fs.existsSync(file), false);
  RR.removeRoleRuns(file);
  RR.removeRoleRuns(null);
});

test('newRoleRunsFile sweeps the records no cycle runs with: this process\'s earlier ones and a gone process\'s; a live one\'s stays', () => {
  const home = tmpDir();
  const logs = path.join(home, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const name = pid => path.join(logs, `cycle-roles-${pid}-abcdef012345.jsonl`);
  const gone = 2 ** 22 + 7; // above any pid this machine hands out
  for (const pid of [process.pid, gone, process.ppid]) fs.writeFileSync(name(pid), '');
  fs.writeFileSync(path.join(logs, 'cycle-transcript-1-x.jsonl'), '');
  RR.newRoleRunsFile(home);
  assert.deepStrictEqual([process.pid, gone, process.ppid].map(p => fs.existsSync(name(p))), [false, false, true]);
  assert.ok(fs.existsSync(path.join(logs, 'cycle-transcript-1-x.jsonl')), 'another file is left alone');
});

test('appendHeadSkills / readHeadSkills: the head trader\'s loads as the runner recorded them, beside the runs (never a run); bad lists refused; none when absent or unreadable', () => {
  const file = path.join(tmpDir(), 'logs', 'r.jsonl');
  assert.deepStrictEqual(RR.readHeadSkills(file), [], 'no file');
  assert.deepStrictEqual(RR.readHeadSkills(null), []);
  RR.appendRoleRun(file, run());
  assert.deepStrictEqual(RR.readHeadSkills(file), [], 'no such line');
  RR.appendHeadSkills(file, ['trade-session', 'trade-lifecycle', 'trade-session']);
  fs.appendFileSync(file, `${JSON.stringify({ kind: 'head-skills', skills: ['multi-timeframe-analysis', 'Not A Skill', 7] })}\ntorn{\n`);
  assert.deepStrictEqual(RR.readHeadSkills(file), ['multi-timeframe-analysis', 'trade-lifecycle', 'trade-session']);
  // A head-skills line is no role run: the gate's calls are the runs alone.
  assert.deepStrictEqual(RR.readRoleRuns(file).map(r => r.role), ['market-structure-analyst']);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  for (const bad of [null, 'trade-session', ['../x'], [''], [7]]) assert.throws(() => RR.appendHeadSkills(file, bad), /not a list of skill names/, JSON.stringify(bad));
  assert.throws(() => RR.appendHeadSkills(null, []), /no record file/);
  // A file over the size limit: none (fails closed).
  const big = path.join(tmpDir(), 'big.jsonl');
  fs.writeFileSync(big, `${JSON.stringify({ kind: 'head-skills', skills: ['trade-session'] })}\n`);
  fs.truncateSync(big, require('../../scripts/lib/tunables').runner().limits.rolesRanBytes + 1);
  assert.deepStrictEqual(RR.readHeadSkills(big), []);
});

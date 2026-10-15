'use strict';

// The training preflight (scripts/lib/learning/preflight.js): every check passes on a good fixture and fails on a
// broken one; N/A never fails; scripts/replay.js run refuses a run on a FAIL, before anything is seeded, and records
// the result in the run home; the CLI's exit codes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../../scripts/lib/learning/preflight');
const PF = require('../fixtures/preflight');

const ROOT = path.join(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-preflight-'));
const D = iso => new Date(iso);
const CORE = ['trade-lifecycle', 'setup-judgment', 'trade-plan', 'trader-process'];
const READS = ['confluence-counting', 'invalidation', 'rejection', 'breakout'];
const SKILL_TEXT = fs.readFileSync(path.join(ROOT, 'skills', 'trade-lifecycle', 'SKILL.md'), 'utf8');
const DAY_BARS = (() => {
  const dir = tmp();
  return PF.writeMinuteBars(path.join(dir, 'MNQ-1m.csv'), '2022-03-07');
})();

/** A run that passes every check, with every feature merged; `over` patches the run, `gate` the gate, `read` the readers. */
function ctx({ run = {}, gate = {}, read = {}, lifecycle = {}, policy = {}, book = {} } = {}) {
  const strategies = [
    { name: 'trade_lifecycle', valid: true, errors: [], status: 'active', signal: 'composed', valid_bars: 2, risk: { stop: 'structure', min_rr: 2, max_risk_usd: 300 }, ...lifecycle },
    { name: 'prop_portfolio', valid: true, errors: [], status: 'active', signal: 'policy', strategies: ['trade_lifecycle'], account: 'acct', ...policy },
  ];
  const rulebook = { valid: true, errors: [], daily_loss_soft: 1000, loss_streak_stop: 2, policies: { prop_portfolio: { sizing: { cushion_frac: 0.3, cap_usd: 1000 }, exit: { mode: 'trail' } } }, ...book };
  const real = P.defaultReaders(ROOT, {}, { barsFiles: { MNQ: DAY_BARS } });
  return {
    run: {
      runId: 'r', learning: true, start: D('2022-03-07T14:30:00Z'), end: D('2022-03-07T15:00:00Z'), cfg: { ...PF.AUTOTRADER, harness: 'opencode', barDelaySeconds: 2 },
      practice: PF.PRACTICE, curated: { file: 'c.json', list: 'mix', fingerprint: 'f1' }, latency: true, libraryDisplay: false, experienceIndex: 'i.json', prop: null, stage: 1, ...run,
    },
    gate: { from: D('2022-03-07T14:30:00Z'), to: D('2022-03-07T15:00:00Z'), runId: 'r', learning: true, ...gate },
    read: {
      strategies: () => strategies,
      skillText: () => SKILL_TEXT,
      skillExists: () => true,
      roleSkillsMode: () => 'index',
      head: () => ({ prompt: 'p', core: [...CORE, ...READS], composedReads: READS, embedded: [...CORE, ...READS], attestation: { sha256: 'a'.repeat(64) }, expectedSha256: 'a'.repeat(64) }),
      syncStale: () => [],
      sampleBriefing: real.sampleBriefing,
      curatedDoc: () => ({ fingerprint: 'f1', use: 'practice', market: { roots: ['MNQ'], minutes: 3, setupTf: 15 }, lists: { 'trend-up': [{}], 'trend-down': [{}] }, coverage: { mix: { under: [] } } }),
      index: () => ({ hash: 'b'.repeat(64), walkForward: true, roles: ['practice-train'], months: { from: '2020-01-06', to: '2024-06-28' } }),
      learningGate: () => ({ learning: true, role: 'practice-train', look: null }),
      rulebook: name => (name === 'acct' ? rulebook : null),
      sizingKeys: () => ['cushion_frac', 'cap_usd'],
      features: () => ({ validBars: true, scorecardComposed: true, lossStreakStop: true, exitMode: true, skillUsage: true, accountFacts: true, monteCarlo: true }),
      ...read,
    },
  };
}

const one = (fn, c) => fn(c);

test('the good fixture: every check passes (every feature merged)', () => {
  const res = P.runChecks(ctx());
  assert.deepStrictEqual(res.results.filter(x => x.status !== P.PASS), [], P.formatReport(res));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.results.length, P.CHECKS.length);
  assert.ok(P.formatReport(res).split('\n').every(l => !l || /^(PASS|FAIL|WARN|N\/A) /.test(l) || /^training preflight/.test(l)));
});

test('each check fails on a broken fixture', () => {
  const cases = [
    [P.strategy, { lifecycle: { max_risk_usd: undefined, risk: { stop: 'structure', min_rr: 2, max_risk_usd: 301 } } }, /max_risk_usd 301/],
    [P.strategy, { lifecycle: { risk: { stop: 'structure', min_rr: 1.5, max_risk_usd: 300 } } }, /min_rr 1.5/],
    [P.strategy, { lifecycle: { risk: { stop: 'swing', min_rr: 2, max_risk_usd: 300 } } }, /not structure/],
    [P.strategy, { lifecycle: { status: 'paper' } }, /not active/],
    [P.strategy, { lifecycle: { signal: 'rules' } }, /not composed/],
    [P.strategy, { lifecycle: { valid: false, errors: ['bad'] } }, /invalid: bad/],
    [P.strategyValidBars, { lifecycle: { valid_bars: 4 } }, /valid_bars 4/],
    [P.strategyValidBars, { lifecycle: { valid_bars: undefined } }, /valid_bars undefined/],
    [P.skillsCrosswalk, { read: { skillExists: n => n !== 'invalidation' } }, /don't exist: invalidation/],
    [P.skillsCrosswalk, { read: { skillText: () => SKILL_TEXT.replace(/^ *\| stop \|.*$/m, '') } }, /no skill for stop/],
    [P.headPromptCheck, { read: { head: () => ({ ...ctx().read.head(), embedded: CORE.slice(1) }) } }, /doesn't embed the current text of trade-lifecycle/],
    [P.headPromptCheck, { read: { head: () => ({ ...ctx().read.head(), attestation: { sha256: 'c'.repeat(64) } }) } }, /attestation hash/],
    [P.headPromptCheck, { read: { head: () => ({ ...ctx().read.head(), prompt: null }) } }, /no head prompt/],
    [P.headComposedReads, { read: { head: () => ({ ...ctx().read.head(), embedded: CORE }) } }, /rejection not embedded/],
    [P.headComposedReads, { read: { head: () => ({ ...ctx().read.head(), composedReads: READS.slice(1), core: CORE.concat(READS.slice(1)) }) } }, /fewer than 4/],
    [P.adaptersInSync, { read: { syncStale: () => ['workspace/AGENTS.md'] } }, /stale generated files: workspace\/AGENTS.md/],
    [P.facts, { run: { cfg: { ...ctx().run.cfg, lanes: undefined } } }, /5m candle .*5m structure/],
    [P.facts, { run: { cfg: { ...ctx().run.cfg, symbols: ['MES'] } } }, /no bar data for MES/],
    [P.facts, { run: { start: D('2023-03-06T14:30:00Z'), end: D('2023-03-06T15:00:00Z') } }, /no 3m bar closing in the run's window/],
    [P.facts, { run: { cfg: { ...ctx().run.cfg, barDelaySeconds: 600 } } }, /min old at its decision time \(limit 9 min\)/],
    [P.curatedList, { read: { curatedDoc: () => ({ ...ctx().read.curatedDoc(), fingerprint: 'f2' }) } }, /fingerprint/],
    [P.curatedList, { read: { curatedDoc: () => ({ ...ctx().read.curatedDoc(), use: 'validate' }) } }, /a validate list on a practice-train run/],
    [P.curatedList, { read: { curatedDoc: () => ({ ...ctx().read.curatedDoc(), lists: { 'trend-up': [], 'trend-down': [{}] } }) } }, /trend-up list is empty/],
    [P.curatedList, { read: { curatedDoc: () => ({ ...ctx().read.curatedDoc(), market: { roots: ['MES'], minutes: 3, setupTf: 15 } }) } }, /its market MES/],
    [P.curatedList, { read: { curatedDoc: () => ({ ...ctx().read.curatedDoc(), market: { roots: ['MNQ'], minutes: 5, setupTf: 15 } }) } }, /5m bars are not the run's 3m/],
    [P.curatedList, { read: { curatedDoc: () => { throw new Error('c.json: its content doesn\'t match its fingerprint'); } } }, /doesn't match its fingerprint/],
    [P.splitWindow, { gate: { from: D('2024-06-28T00:00:00Z'), to: D('2024-07-03T00:00:00Z') } }, /spans practice-train \+ practice-validate/],
    [P.splitWindow, { gate: { from: D('2019-03-04T00:00:00Z'), to: D('2019-03-05T00:00:00Z') } }, /no learning role/],
    [P.latency, { run: { latency: false } }, /latency: true/],
    [P.practiceMode, { run: { practice: null } }, /sets its practice mode/],
    [P.libraryDisplay, { run: { libraryDisplay: true } }, /no library comparison arm/],
    [P.experienceIndex, { read: { index: () => ({ ...ctx().read.index(), roles: ['practice-validate'] }) } }, /not practice-train only/],
    [P.experienceIndex, { read: { index: () => ({ ...ctx().read.index(), walkForward: false }) } }, /not walk-forward/],
    [P.experienceIndex, { read: { index: () => ({ ...ctx().read.index(), months: { from: '2020-01-06', to: '2024-08-01' } }) } }, /index refused/],
    [P.experienceIndex, { read: { index: () => { throw new Error('i.json: its content doesn\'t match its hash'); } } }, /doesn't match its hash/],
    [P.ledgerLook, { read: { learningGate: () => { throw new Error('learning run refused: test is sealed: name the candidate'); } } }, /test is sealed/],
    [P.ledgerLook, { read: { learningGate: () => ({ learning: true, role: 'test', look: null }) } }, /held out: a run on it takes a look/],
    [P.stage, { gate: { from: D('2025-03-03T14:30:00Z'), to: D('2025-03-03T15:00:00Z') } }, /stage 1 run is practice or validate .* not test/],
    [P.stage, { run: { curated: null } }, /replays a curated list/],
    [P.stage, { run: { latency: false } }, /latency is charged/],
    [P.stage, { run: { libraryDisplay: true } }, /history library stays hidden/],
    [P.stage, { run: { prop: 'acct' } }, /no prop attempt in stage 1/],
    [P.propPortfolio, { policy: { strategies: [] } }, /strategies \[\], not \[trade_lifecycle\]/],
    [P.propPortfolio, { policy: { status: 'paper' } }, /not active/],
    [P.propPortfolio, { book: { valid: false, errors: ['policies: refused'] } }, /rulebook is refused: policies: refused/],
    [P.propPortfolio, { policy: { account: 'none' } }, /has no rulebook/],
    [P.rulebookValues, { book: { daily_loss_soft: undefined } }, /missing daily_loss_soft/],
    [P.rulebookValues, { book: { policies: { prop_portfolio: { sizing: { cushion_frac: 0.3 } } } } }, /sizing.cap_usd/],
    [P.rulebookMissing, { book: { loss_streak_stop: undefined } }, /missing loss_streak_stop/],
    [P.rulebookMissing, { book: { policies: { prop_portfolio: { sizing: {}, exit: {} } } } }, /exit.mode/],
  ];
  for (const [fn, over, why] of cases) {
    const res = one(fn, ctx(over));
    assert.strictEqual(res.status, P.FAIL, `${fn.name} ${why}: ${JSON.stringify(res)}`);
    assert.match(res.detail, why, fn.name);
    assert.strictEqual(P.runChecks(ctx(over)).ok, false, `${fn.name}: a FAIL fails the preflight`);
  }
});

test('passing variants: a library comparison arm, a validate run, no curated list or index, a stage-2 prop run', () => {
  assert.strictEqual(P.libraryDisplay(ctx({ run: { libraryDisplay: true }, gate: { evaluation: 'ev1' } })).status, P.PASS);
  assert.strictEqual(P.practiceMode(ctx({ gate: { from: D('2024-08-05T14:30:00Z'), to: D('2024-08-05T15:00:00Z') }, run: { practice: null } })).status, P.PASS);
  assert.strictEqual(P.curatedList(ctx({ run: { curated: null } })).status, P.PASS);
  assert.strictEqual(P.experienceIndex(ctx({ run: { experienceIndex: null } })).status, P.PASS);
  assert.strictEqual(P.stage(ctx({ run: { stage: 2, prop: 'acct' } })).status, P.PASS);
  assert.strictEqual(P.stage(ctx({ run: { stage: null, curated: null, prop: 'acct' } })).status, P.PASS);
  const validate = ctx({ read: { learningGate: () => ({ learning: true, role: 'practice-validate', look: { purpose: 'validate', evaluation: 'r' } }) } });
  assert.strictEqual(P.ledgerLook(validate).status, P.PASS);
  // A validate list on a validate run.
  const val = ctx({ gate: { from: D('2024-08-05T14:30:00Z'), to: D('2024-08-05T15:00:00Z') }, read: { curatedDoc: () => ({ ...ctx().read.curatedDoc(), use: 'validate' }) } });
  assert.strictEqual(P.curatedList(val).status, P.PASS);
  // A skill under its minimum warns, never fails.
  const under = ctx({ read: { curatedDoc: () => ({ ...ctx().read.curatedDoc(), coverage: { mix: { under: ['absorption'] } } }) } });
  assert.deepStrictEqual([P.curatedList(under).status, P.runChecks(under).ok], [P.WARN, true]);
  // The head prompt doesn't apply to another harness or full mode: N/A, never a FAIL.
  assert.strictEqual(P.headPromptCheck(ctx({ run: { cfg: { ...ctx().run.cfg, harness: 'custom' } }, read: { head: () => ({ prompt: null }) } })).status, P.NA);
  assert.strictEqual(P.headPromptCheck(ctx({ read: { roleSkillsMode: () => 'full', head: () => ({ prompt: null }) } })).status, P.NA);
});

test('N/A never fails: a feature not merged reports "not available (needs <branch>)"', () => {
  const none = { validBars: false, scorecardComposed: false, lossStreakStop: false, exitMode: false, skillUsage: false, accountFacts: false, monteCarlo: false };
  const c = ctx({ run: { curated: undefined, latency: undefined, libraryDisplay: undefined }, read: { features: () => none, head: () => ({ ...ctx().read.head(), composedReads: null }) }, lifecycle: { valid_bars: undefined } });
  const res = P.runChecks(c);
  assert.strictEqual(res.ok, true, P.formatReport(res));
  const na = res.results.filter(x => x.status === P.NA).map(x => x.check);
  assert.deepStrictEqual(na.sort(), ['account-facts', 'curated-list', 'head-composed-reads', 'latency', 'library-display', 'monte-carlo', 'rulebook-missing', 'scorecard-composed', 'strategy-valid-bars'].sort());
  for (const x of res.results.filter(y => y.status === P.NA)) assert.match(x.detail, /^not available \(needs .+\)$/, x.check);
  assert.match(res.results.find(x => x.check === 'stage').detail, /not available yet: .*curatedList/);
});

test('a check that throws is a FAIL with its message', () => {
  const res = P.runChecks(ctx({ read: { strategies: () => { throw new Error('boom'); } } }));
  assert.strictEqual(res.ok, false);
  assert.match(res.results.find(x => x.check === 'strategy').detail, /boom/);
});

test('the crosswalk: the trade-lifecycle step table, each step\'s skills', () => {
  const t = P.crosswalkOf(SKILL_TEXT);
  for (const s of ['bias', 'location', 'setup', 'entry', 'stop', 'target']) assert.ok(t[s] && t[s].length, s);
  assert.deepStrictEqual(t.stop, ['invalidation']);
  assert.ok(!t.location.includes('at 15m fvg'.replace(/ /g, '-')), 'the read forms column is not a skill');
});

test('the repository and the parity bars: the defaults pass (main: the merged features only)', () => {
  const run = { ...ctx().run, cfg: { ...PF.AUTOTRADER, barDelaySeconds: 2 }, curated: undefined, latency: undefined, libraryDisplay: undefined, experienceIndex: null };
  const gate = { from: run.start, to: run.end, runId: 'r', learning: true, endOfDay: true, practice: run.practice, env: { HOME: tmp() } };
  const read = P.defaultReaders(ROOT, { HOME: gate.env.HOME }, { barsFiles: { MNQ: DAY_BARS } });
  const res = P.runChecks({ run, gate, read });
  assert.strictEqual(res.ok, true, P.formatReport(res));
  for (const name of ['strategy', 'skills-crosswalk', 'adapters-in-sync', 'facts', 'split-window', 'practice-mode', 'ledger-look', 'prop-portfolio', 'rulebook-values']) {
    assert.strictEqual(res.results.find(x => x.check === name).status, P.PASS, name);
  }
});

test('preflightForRun: none for a run declared not learning; throws the report on a FAIL; records the result', () => {
  assert.strictEqual(P.preflightForRun({ learning: false }, {}), null);
  const bad = ctx({ run: { practice: null } });
  assert.throws(() => P.preflightForRun(bad.run, bad.gate, { read: bad.read }), /training preflight refused the run:\n[^]*FAIL practice-mode/);
  const good = ctx();
  const lines = [];
  const pre = P.preflightForRun(good.run, good.gate, { read: good.read, log: l => lines.push(l), now: () => D('2026-10-14T00:00:00Z') });
  assert.ok(lines.some(l => /^preflight PASS strategy/.test(l)));
  const home = tmp();
  const file = pre.record(home);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.deepStrictEqual([path.basename(file), rec.ok, rec.runId, rec.results.length, rec.at], [P.RECORD, true, 'r', P.CHECKS.length, '2026-10-14T00:00:00.000Z']);
});

/** scripts/replay.js run on a 30-minute window of a Monday, with the parity 1m bars of that week. */
function replayRun(start, over = {}, flags = []) {
  const user = tmp();
  const config = path.join(user, 'replay.json');
  const bars = PF.writeMinuteBars(path.join(user, 'MNQ-1m.csv'), start.slice(0, 10));
  const end = new Date(Date.parse(start) + 30 * 60000).toISOString().replace('.000Z', 'Z');
  fs.writeFileSync(config, JSON.stringify({ runId: 'r', workDir: path.join(user, 'replays'), broker: 'replaymock', start, end, premarket: false, autotrader: PF.AUTOTRADER, practice: PF.PRACTICE, ...over }));
  const live = path.join(user, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ brokers: { replaymock: { command: ['true'], replay: true, journalEnv: 'MOCK_JOURNAL', env: ['MOCK_JOURNAL'] } } }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'replay.js'), 'run', '--config', config, '--bars', `MNQ=${bars}`, ...flags], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: user, FTH_HOME: live }, timeout: 60000 });
  return { ...r, user, home: path.join(user, 'replays', 'r'), config, bars };
}

test('scripts/replay.js run: refuses on a FAIL before anything is seeded; a run that passes records its preflight', () => {
  const bad = replayRun('2022-03-07T14:30:00Z', { practice: undefined });
  assert.strictEqual(bad.status, 1, bad.stdout);
  assert.match(bad.stderr, /training preflight refused the run/);
  assert.match(bad.stderr, /FAIL practice-mode: a practice-train run sets its practice mode/);
  assert.ok(!fs.existsSync(bad.home), 'nothing seeded');
  assert.ok(!fs.existsSync(path.join(bad.user, '.futures-trading-harness', 'learning', 'looks.jsonl')), 'no look taken');
  const noBars = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'replay.js'), 'run', '--config', bad.config], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: bad.user, FTH_HOME: path.join(bad.user, 'live') }, timeout: 60000 });
  assert.match(noBars.stderr, /FAIL facts: no bar data for MNQ/);
  const ok = replayRun('2022-03-07T14:30:00Z');
  assert.match(ok.stdout, /preflight PASS facts/);
  const recs = fs.readFileSync(path.join(ok.home, P.RECORD), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].ok, true);
  // A run declared not learning has no training preflight.
  const not = replayRun('2027-02-01T14:30:00Z', { learning: false, practice: undefined });
  assert.doesNotMatch(not.stdout + not.stderr, /\[replay\] preflight |training preflight/);
  assert.ok(!fs.existsSync(path.join(not.home, P.RECORD)));
});

test('scripts/training-preflight.js: 0 on a pass, 1 on a FAIL, 2 on a usage error; never seeds', () => {
  const cli = path.join(ROOT, 'scripts', 'training-preflight.js');
  const user = tmp();
  const bars = PF.writeMinuteBars(path.join(user, 'MNQ-1m.csv'), '2022-03-07');
  const write = over => {
    const f = path.join(user, `replay-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify({ runId: 'r', workDir: path.join(user, 'replays'), broker: 'replaymock', start: '2022-03-07T14:30:00Z', end: '2022-03-07T15:00:00Z', premarket: false, autotrader: PF.AUTOTRADER, practice: PF.PRACTICE, ...over }));
    return f;
  };
  fs.mkdirSync(path.join(user, 'live'));
  fs.writeFileSync(path.join(user, 'live', 'brokers.json'), JSON.stringify({ brokers: { replaymock: { command: ['true'], replay: true, journalEnv: 'MOCK_JOURNAL', env: ['MOCK_JOURNAL'] } } }));
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: user, FTH_HOME: path.join(user, 'live') } });
  const ok = run(['--config', write({}), '--bars', `MNQ=${bars}`]);
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^PASS strategy: /m);
  assert.match(ok.stdout, /^N\/A {2}monte-carlo: not available/m);
  const bad = run(['--config', write({ practice: undefined }), '--bars', `MNQ=${bars}`]);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /^FAIL practice-mode/m);
  assert.strictEqual(run([]).status, 2);
  assert.strictEqual(run(['--config', write({ stage: 1, learning: false })]).status, 2, 'a stage contradiction is a config error');
  assert.ok(!fs.existsSync(path.join(user, 'replays')), 'nothing seeded');
});

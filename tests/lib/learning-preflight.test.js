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

// A list moment the standard traded on the day's bars: its decision bar's open and close (its entry).
const REAL = P.defaultReaders(ROOT, {}, { barsFiles: { MNQ: DAY_BARS } });
const [BAR_MS, BAR_CLOSE] = [...REAL.barCloses('MNQ', 3)].find(([ms]) => ms >= Date.parse('2022-03-07T14:30:00Z'));
const MOMENT = { bar: new Date(BAR_MS).toISOString(), standard: { plan: { entry: BAR_CLOSE, stop: BAR_CLOSE - 10, target: BAR_CLOSE + 20, rr: 2 } } };

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
      barCloses: real.barCloses,
      tickOf: () => 0.25,
      curatedDoc: () => ({ fingerprint: 'f1', use: 'practice', market: { roots: ['MNQ'], minutes: 3, setupTf: 15 }, lists: { 'trend-up': [MOMENT], 'trend-down': [{}] }, coverage: { mix: { under: [] } } }),
      index: () => ({ hash: 'b'.repeat(64), walkForward: true, roles: ['practice-train'], months: { from: '2020-01-06', to: '2024-06-28' } }),
      learningGate: () => ({ learning: true, role: 'practice-train', look: null }),
      riskRecord: () => ({ hash: 'c'.repeat(64), walkForward: true, roles: ['practice-train'], days: 3, entries: [{ day: '2022-03-01', role: 'practice-train', cells: {} }] }),
      riskPin: () => null,
      rulebook: name => (name === 'acct' ? rulebook : null),
      sizingKeys: () => ['cushion_frac', 'cap_usd'],
      features: () => ({ scorecardComposed: true, lossStreakStop: true, exitMode: true, skillUsage: true, accountFacts: true, monteCarlo: true }),
      statesDoc: () => STATES_DOC,
      gateLimits: () => ({ maxDailyLosses: 3, maxConsecutiveLosses: 2, lossCooldownMin: 30 }),
      accountProfile: () => ({ name: 'acct', daily_loss_limit: 2000, daily_loss_soft: 1000 }),
      attemptLine: (_name, state) => attemptLineOf(state),
      ...read,
    },
  };
}

const one = (fn, c) => fn(c);

/** A drawn account-states document (prop/account-states.js), as the preflight reads it: two draws, one after losses. */
const AFTER = { sessionsDone: 3, balance: 50500, peak: 51000, dayPnl: -400, days: [300, 200, 400], tradesToday: 2, lossesToday: 1, lossStreak: 1 };
const STATES_DOC = {
  kind: 'account-states', v: 1, hash: 'd'.repeat(64), account: 'acct', gate: { maxDailyLosses: 3, maxConsecutiveLosses: 2, lossCooldownMin: 30 }, source: [{ runId: 's', role: 'practice-train' }],
  draws: [{ id: 0, bucket: 'mid', weight: 2, state: { ...AFTER, dayPnl: 0, balance: 50900, tradesToday: 0, lossesToday: 0, lossStreak: 0 } }, { id: 1, bucket: 'after-losses', weight: 0.5, state: AFTER }],
};
const STATES_RUN = { file: 's.json', hash: 'd'.repeat(64), account: 'acct', assignment: { days: [{ day: '2022-03-07', draw: 1 }], weights: { 'after-losses': 0.5 }, sampledDays: { 'after-losses': 1 }, unsampled: [] } };
/** The runner's attempt line for a state (or a fresh attempt), as autotrader.js accountText words it. */
function attemptLineOf(s) {
  const st = s || { sessionsDone: 0, balance: 50000, tradesToday: 0, lossesToday: 0, lossStreak: 0, dayPnl: 0 };
  return ` Account 1 at 10:00 ET: balance $${st.balance}; flat; 0 working orders. acct attempt (active): floor $48,000, cushion $2,500, profit +$500 of $3,000, day $${st.dayPnl}, 27 sessions left; day ${st.sessionsDone + 1}, needs $2,500, daily room $600, soft stop $1,000 (room $600), today ${st.tradesToday} trade${st.tradesToday === 1 ? '' : 's'}, ${st.lossesToday} loss${st.lossesToday === 1 ? '' : 'es'}, losing streak ${st.lossStreak}; prop_portfolio size budget $500.`;
}

test('the good fixture: every check passes (every feature merged); the risk record, off, is N/A', () => {
  // A stage-2 practice run, its days from drawn account states: every check judged and passing.
  const two = P.runChecks(ctx({ run: { stage: 2, accountStates: STATES_RUN } }));
  assert.deepStrictEqual(two.results.filter(x => x.status !== P.PASS).map(x => [x.check, x.status]), [['risk-record', P.NA]], P.formatReport(two));
  // A stage-1 run: the same, but for the account states it has none of (N/A, never a FAIL).
  const res = P.runChecks(ctx());
  assert.deepStrictEqual(res.results.filter(x => x.status !== P.PASS).map(x => [x.check, x.status]), [['risk-record', P.NA], ['account-states', P.NA]], P.formatReport(res));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.results.length, P.CHECKS.length);
  assert.deepStrictEqual(res.results.find(x => x.check === 'curated-source'), { check: 'curated-source', status: P.PASS, detail: '1 list moment(s) closed at their entry in the bars given: one source' });
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
    // Merged (#188): a head-prompt module without the composed reads is a FAIL, not "not available".
    [P.headComposedReads, { read: { head: () => ({ ...ctx().read.head(), composedReads: null }) } }, /lists no composed reads/],
    [P.adaptersInSync, { read: { syncStale: () => ['workspace/AGENTS.md'] } }, /stale generated files: workspace\/AGENTS.md/],
    [P.facts, { run: { cfg: { ...ctx().run.cfg, lanes: undefined } } }, /5m candle .*5m structure/],
    [P.facts, { run: { cfg: { ...ctx().run.cfg, symbols: ['MES'] } } }, /no bar data for MES/],
    [P.facts, { run: { start: D('2023-03-06T14:30:00Z'), end: D('2023-03-06T15:00:00Z') } }, /no 3m bar closing in the run's window/],
    [P.facts, { run: { cfg: { ...ctx().run.cfg, barDelaySeconds: 600 } } }, /min old at its decision time \(limit 9 min\)/],
    // The age against the gate's limit, and the briefing's own validity, each on its own.
    [P.facts, { read: { sampleBriefing: o => { const s = ctx().read.sampleBriefing(o); return { ...s, now: new Date(Date.parse(s.briefing.closedAt) + 5 * 60000), limitMin: 3 }; } } }, /5\.0 min old at its decision time \(limit 3 min\)/],
    [P.facts, { read: { sampleBriefing: o => ({ ...ctx().read.sampleBriefing(o), current: false }) } }, /min old at its decision time/],
    [P.curatedList, { read: { curatedDoc: () => ({ ...ctx().read.curatedDoc(), fingerprint: 'f2' }) } }, /fingerprint/],
    [P.curatedList, { read: { curatedDoc: () => ({ ...ctx().read.curatedDoc(), use: 'validate' }) } }, /a validate list on a practice-train run/],
    [P.curatedList, { read: { curatedDoc: () => ({ ...ctx().read.curatedDoc(), lists: { 'trend-up': [], 'trend-down': [{}] } }) } }, /trend-up list is empty/],
    [P.curatedList, { read: { curatedDoc: () => ({ ...ctx().read.curatedDoc(), market: { roots: ['MES'], minutes: 3, setupTf: 15 } }) } }, /its market MES/],
    [P.curatedList, { read: { curatedDoc: () => ({ ...ctx().read.curatedDoc(), market: { roots: ['MNQ'], minutes: 5, setupTf: 15 } }) } }, /5m bars are not the run's 3m/],
    [P.curatedList, { read: { curatedDoc: () => { throw new Error('c.json: its content doesn\'t match its fingerprint'); } } }, /doesn't match its fingerprint/],
    // Merged (#191, #190, #189): a resolved run without the setting is a FAIL, not "not available".
    [P.curatedList, { run: { curated: undefined } }, /no curated list setting/],
    [P.latency, { run: { latency: undefined } }, /no latency setting/],
    [P.libraryDisplay, { run: { libraryDisplay: undefined } }, /no libraryDisplay setting/],
    [P.stage, { run: { curated: undefined } }, /replays a curated list/],
    [P.stage, { run: { latency: undefined } }, /latency is charged/],
    [P.stage, { run: { libraryDisplay: undefined } }, /history library stays hidden/],
    // Stage 2's stage-1 part is still judged.
    [P.stage, { run: { stage: 2, latency: false } }, /stage 2: latency is charged/],
    // The list scanned from another series: its moment's entry isn't the run's bar's close.
    [P.curatedSource, { read: { curatedDoc: () => ({ ...ctx().read.curatedDoc(), lists: { 'trend-up': [{ ...MOMENT, standard: { plan: { ...MOMENT.standard.plan, entry: BAR_CLOSE + 7.5 } } }] } }) } }, /1 of 1 list moment\(s\) disagree with the run's bars .*scanned from another series/],
    [P.curatedSource, { read: { curatedDoc: () => { throw new Error('c.json: unreadable'); } } }, /unreadable/],
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
  // A resume of a run started before latency was charged keeps its pinned clock: PASS, noted. A new pinned run FAILs (above).
  const resumed = P.latency(ctx({ run: { latency: false, latencyPinnedResume: true } }));
  assert.deepStrictEqual([resumed.status, /^pinned: a resume of a run started before latency was charged/.test(resumed.detail)], [P.PASS, true]);
  assert.strictEqual(P.latency(ctx({ run: { latency: false, latencyPinnedResume: false } })).status, P.FAIL);
  // The source check: within half a tick is one source; nothing to compare (no list, no moment in the bars, no bars) is N/A.
  assert.strictEqual(P.curatedSource(ctx({ read: { curatedDoc: () => ({ ...ctx().read.curatedDoc(), lists: { 'trend-up': [{ ...MOMENT, standard: { plan: { ...MOMENT.standard.plan, entry: BAR_CLOSE + 0.1 } } }] } }) } })).status, P.PASS);
  // The reader: the bars given aggregated to the list's timeframe; another symbol, or no timeframe, says why.
  assert.ok(REAL.barCloses('MNQ', 3).size > 0 && REAL.barCloses('MNQ', 1).size > REAL.barCloses('MNQ', 3).size);
  assert.match(REAL.barCloses('MES', 3).error, /no MES bars given/);
  assert.match(REAL.barCloses('MNQ', null).error, /no bar timeframe/);
  for (const c of [ctx({ run: { curated: null } }), ctx({ read: { curatedDoc: () => ({ ...ctx().read.curatedDoc(), lists: { 'trend-up': [{ ...MOMENT, bar: '2023-01-03T15:00:00.000Z' }] } }) } }), ctx({ read: { barCloses: () => ({ error: 'no MNQ bars given (--bars)' }) } })]) assert.strictEqual(P.curatedSource(c).status, P.NA);
  assert.strictEqual(P.experienceIndex(ctx({ run: { experienceIndex: null } })).status, P.PASS);
  // Stage 2's own requirements are real checks now: a practice run without account states FAILs; with them it passes;
  // a validate run doesn't need them; the prop risk rules and the Monte Carlo must be there.
  const two = P.stage(ctx({ run: { stage: 2 } }));
  assert.strictEqual(two.status, P.FAIL);
  assert.match(two.detail, /stage 2: a stage 2 practice run starts its days from drawn account states/);
  assert.match(P.stage(ctx({ run: { stage: 2, accountStates: STATES_RUN } })).detail, /stage 2 on practice-train: .*days from account states dddddddddddd, the prop risk rules and the Monte Carlo/);
  assert.strictEqual(P.stage(ctx({ run: { stage: 2, prop: 'acct', curated: null }, gate: { from: D('2024-08-05T14:30:00Z'), to: D('2024-08-05T15:00:00Z') } })).status, P.PASS);
  assert.match(P.stage(ctx({ run: { stage: 2, accountStates: STATES_RUN }, read: { features: () => ({ ...ctx().read.features(), lossStreakStop: false }) } })).detail, /prop risk rules are needed/);
  assert.match(P.stage(ctx({ run: { stage: 2, accountStates: STATES_RUN }, read: { features: () => ({ ...ctx().read.features(), monteCarlo: false }) } })).detail, /the Monte Carlo is needed/);
  assert.match(P.stage(ctx({ run: { stage: 1, accountStates: STATES_RUN } })).detail, /no account states in stage 1/);
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

test('N/A never fails: a feature not merged reports "not available (needs <branch>)"; the merged ones (#188-#191) are judged', () => {
  const none = { scorecardComposed: false, lossStreakStop: false, exitMode: false, skillUsage: false, accountFacts: false, monteCarlo: false };
  const c = ctx({ read: { features: () => none } });
  const res = P.runChecks(c);
  assert.strictEqual(res.ok, true, P.formatReport(res));
  // The risk record's check is N/A when the display is off (it doesn't wait for a branch); so are account-states on a stage-1 run.
  const own = ['risk-record', 'account-states'];
  const na = res.results.filter(x => x.status === P.NA && !own.includes(x.check)).map(x => x.check);
  assert.deepStrictEqual(na.sort(), ['account-facts', 'monte-carlo', 'rulebook-missing', 'scorecard-composed']);
  for (const x of res.results.filter(y => y.status === P.NA && !own.includes(y.check))) assert.match(x.detail, /^not available \(needs .+\)$/, x.check);
  // The merged features' checks judge them on the good fixture.
  for (const name of ['strategy-valid-bars', 'head-composed-reads', 'curated-list', 'latency', 'library-display', 'stage']) assert.strictEqual(res.results.find(x => x.check === name).status, P.PASS, name);
  assert.ok(!Object.keys(P.NEEDS).some(k => ['validBars', 'latency', 'libraryDisplay', 'curatedList', 'composedReads'].includes(k)), 'no merged feature waits');
});

test('feature detection reads an exported symbol, never the source text: a comment naming "composed" doesn\'t flip it', () => {
  const root = tmp();
  const file = path.join(root, 'scripts', 'lib', 'replay', 'scorecard.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const features = () => P.defaultReaders(root, {}).features();
  fs.writeFileSync(file, "'use strict';\n// The scorecard doesn't score composed setups yet.\nconst composed = null;\nmodule.exports = { composed };\n");
  assert.strictEqual(features().scorecardComposed, false, 'the word in a comment or a name');
  fs.writeFileSync(path.join(root, 'scripts', 'lib', 'replay', 'other.js'), '');
  const again = path.join(tmp(), 'scripts', 'lib', 'replay');
  fs.mkdirSync(again, { recursive: true });
  fs.writeFileSync(path.join(again, 'scorecard.js'), "module.exports = { SCORES_COMPOSED: true };\n");
  assert.strictEqual(P.defaultReaders(path.resolve(again, '..', '..', '..'), {}).features().scorecardComposed, true, 'the exported symbol');
  assert.strictEqual(P.defaultReaders(tmp(), {}).features().scorecardComposed, false, 'no scorecard');
  // On this repository (no scorecard fix merged): N/A.
  assert.strictEqual(P.defaultReaders(ROOT, {}).features().scorecardComposed, false);
  // The skill-usage report: merged when its module exports readSkillUsage, not when a file merely exists.
  const su = path.join(tmp(), 'scripts', 'lib', 'learning');
  fs.mkdirSync(su, { recursive: true });
  const usage = () => P.defaultReaders(path.resolve(su, '..', '..', '..'), {}).features().skillUsage;
  fs.writeFileSync(path.join(su, 'skill-usage.js'), "// readSkillUsage\nmodule.exports = { other: 1 };\n");
  assert.strictEqual(usage(), false, 'a file without the export');
  const merged = path.join(tmp(), 'scripts', 'lib', 'learning');
  fs.mkdirSync(merged, { recursive: true });
  fs.writeFileSync(path.join(merged, 'skill-usage.js'), 'module.exports = { readSkillUsage() {} };\n');
  assert.strictEqual(P.defaultReaders(path.resolve(merged, '..', '..', '..'), {}).features().skillUsage, true, 'the exported function');
  assert.strictEqual(P.defaultReaders(ROOT, {}).features().skillUsage, true, 'this repository');
});

test('account-states and account-facts: real checks of the run\'s draw and of the attempt line the model is shown', () => {
  const states = o => ctx({ run: { stage: 2, accountStates: { ...STATES_RUN, ...o } } });
  assert.strictEqual(P.accountStates(ctx()).status, P.NA);
  assert.match(P.accountStates(states({})).detail, /dddddddddddd on acct: 1 day\(s\): after-losses 1 \(weight 0.5\)/);
  const fails = [
    [states({ hash: 'e'.repeat(64) }), /its hash dddddddddddd is not the config's eeeeeeeeeeee/],
    [ctx({ run: { stage: 2, accountStates: STATES_RUN }, policy: { account: 'other' } }), /drawn on acct, but prop_portfolio trades other/],
    [ctx({ run: { stage: 2, accountStates: STATES_RUN }, read: { statesDoc: () => ({ ...STATES_DOC, source: [{ runId: 'v', role: 'practice-validate' }] }) } }), /not practice-train only/],
    [ctx({ run: { stage: 2, accountStates: STATES_RUN }, read: { gateLimits: () => ({ maxDailyLosses: 4, maxConsecutiveLosses: 2, lossCooldownMin: 30 }) } }), /drawn under the gate's loss limits/],
    [states({ assignment: { ...STATES_RUN.assignment, unsampled: ['near-mll'] } }), /no day of the run starts in near-mll: the reweighting can't restore the natural rates/],
    [ctx({ run: { stage: 2, accountStates: STATES_RUN }, read: { statesDoc: () => { throw new Error('s.json: its content doesn\'t match its hash'); } } }), /doesn't match its hash/],
  ];
  for (const [c, re] of fails) {
    const x = P.accountStates(c);
    assert.strictEqual(x.status, P.FAIL, x.detail);
    assert.match(x.detail, re);
  }
  // The attempt line: from the run's after-losses draw, every fact shown and nothing saying it was drawn.
  const good = P.accountFacts(states({}));
  assert.strictEqual(good.status, P.PASS, good.detail);
  assert.match(good.detail, /from a drawn after-losses state/);
  const line = fn => P.accountFacts(ctx({ run: { stage: 2, accountStates: STATES_RUN }, read: { attemptLine: (_n, st) => fn(attemptLineOf(st)) } }));
  assert.match(line(l => l.replace(/, losing streak \d+/, '')).detail, /misses losing streak/);
  assert.match(line(l => l.replace(/daily room \$\d+, /, '')).detail, /misses daily room/);
  assert.match(line(l => `${l} (a drawn practice state)`).detail, /says the state was drawn \("drawn"\)/);
  assert.match(line(l => l.replace('today 2 trades, 1 loss', 'today 0 trades, 0 losses')).detail, /doesn't show its state \(today 2 trade, 1 loss\)/);
  assert.strictEqual(P.accountFacts(ctx({ policy: { account: undefined } })).status, P.FAIL);
  // The real reader on this repository: the live path renders the seeded line.
  const real = P.defaultReaders(ROOT, {});
  const acct = require('../../scripts/lib/trading/strategies').loadStrategies(ROOT, {}).strategies.find(x => x.name === 'prop_portfolio').account;
  const prof = real.accountProfile(acct);
  const st = { sessionsDone: 2, days: [300, -100], peak: prof.starting_balance + 300, dayPnl: -150, balance: prof.starting_balance + 50, tradesToday: 2, lossesToday: 1, lossStreak: 1 };
  const shown = real.attemptLine(acct, st, D('2022-03-08T15:00:00Z'));
  for (const want of ['day 3,', 'today 2 trades, 1 loss', 'losing streak 1', 'daily room $', 'soft stop $']) assert.ok(shown.includes(want), `${want}: ${shown}`);
  assert.doesNotMatch(shown, /drawn|sampl|bucket|weight|seed/i);
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

test('the repository and the parity bars: the defaults pass on the combined code', () => {
  // As replay/config.js resolves a learning run with no curated list, index or stage: latency charged, library hidden.
  const run = { ...ctx().run, cfg: { ...PF.AUTOTRADER, barDelaySeconds: 2 }, curated: null, latency: true, libraryDisplay: false, experienceIndex: null, stage: null };
  const gate = { from: run.start, to: run.end, runId: 'r', learning: true, endOfDay: true, practice: run.practice, env: { HOME: tmp() } };
  const read = P.defaultReaders(ROOT, { HOME: gate.env.HOME }, { barsFiles: { MNQ: DAY_BARS } });
  const res = P.runChecks({ run, gate, read });
  assert.strictEqual(res.ok, true, P.formatReport(res));
  for (const name of ['strategy', 'strategy-valid-bars', 'skills-crosswalk', 'adapters-in-sync', 'facts', 'curated-list', 'split-window', 'latency', 'practice-mode', 'library-display', 'ledger-look', 'prop-portfolio', 'rulebook-values']) {
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
  // The merged features, judged on the resolved config: valid_bars, latency charged, the library hidden, no list.
  for (const line of [/preflight PASS strategy-valid-bars: trade_lifecycle valid_bars 2/, /preflight PASS latency: charged/, /preflight PASS library-display: off/, /preflight PASS curated-list: none pinned/]) assert.match(ok.stdout, line);
  // A stage-1 practice run without its curated list: refused, nothing seeded.
  const staged = replayRun('2022-03-07T14:30:00Z', { stage: 1 });
  assert.strictEqual(staged.status, 1, staged.stdout);
  assert.match(staged.stderr, /FAIL stage: stage 1: a stage practice run replays a curated list/);
  assert.ok(!fs.existsSync(staged.home));
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
  assert.match(ok.stdout, /^PASS monte-carlo: the 30-day Monte Carlo scores the run/m);
  assert.match(ok.stdout, /^PASS account-facts: .*a fresh attempt: balance, floor, cushion/m);
  const bad = run(['--config', write({ practice: undefined }), '--bars', `MNQ=${bars}`]);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /^FAIL practice-mode/m);
  assert.strictEqual(run([]).status, 2);
  assert.strictEqual(run(['--config', write({ stage: 1, learning: false })]).status, 2, 'a stage contradiction is a config error');
  assert.ok(!fs.existsSync(path.join(user, 'replays')), 'nothing seeded');
});

test('risk-record: N/A when off; on, it needs a pinned practice-train-built record on a practice-train run', () => {
  const on = { riskRecordDisplay: true, riskRecord: 'rr.json', comparisonArm: true, stage: 2 };
  assert.strictEqual(P.riskRecord(ctx()).status, P.NA, 'off by default');
  assert.strictEqual(P.riskRecord(ctx({ run: { riskRecord: 'rr.json' } })).status, P.NA, 'pinned alone, not shown: N/A');
  const good = P.riskRecord(ctx({ run: on }));
  assert.strictEqual(good.status, P.PASS, good.detail);
  assert.match(good.detail, /^cccccccccccc: walk-forward, practice-train-built, 3 day\(s\); pinned at the run's start, shown$/);
  const pinned = { file: 'risk-record-cccccccccccccccc.json', hash: 'c'.repeat(64), display: true, comparisonArm: true };
  assert.strictEqual(P.riskRecord(ctx({ run: { ...on, paths: { runHome: '/h' } }, read: { riskPin: () => pinned } })).status, P.PASS, 'a resume of the same shown record');
  const rec = ctx().read.riskRecord();
  const cases = [
    [{ run: { ...on, riskRecord: null } }, /without a risk record to pin/],
    [{ run: on, read: { riskRecord: () => { throw new Error('rr.json: its content doesn\'t match its hash'); } } }, /doesn't match its hash/],
    [{ run: on, read: { riskRecord: () => ({ ...rec, walkForward: false }) } }, /not walk-forward/],
    [{ run: on, read: { riskRecord: () => ({ ...rec, roles: ['practice-train', 'practice-validate'] }) } }, /not practice-train only/],
    [{ run: on, read: { riskRecord: () => ({ ...rec, entries: [{ day: '2024-08-05', role: 'practice-validate', cells: {} }] }) } }, /an entry not of practice-train/],
    [{ run: { ...on, paths: { runHome: '/h' } }, read: { riskPin: () => ({ ...pinned, hash: 'd'.repeat(64) }) } }, /pinned risk record dddddddddddd, not this one/],
    [{ run: { ...on, paths: { runHome: '/h' } }, read: { riskPin: () => ({ ...pinned, display: false }) } }, /pinned its risk record with the display off/],
    // The comparison arm is pinned with the record: a resume whose config says otherwise is refused.
    [{ run: { ...on, paths: { runHome: '/h' } }, read: { riskPin: () => ({ ...pinned, comparisonArm: false }) } }, /pinned its risk record not as a declared comparison arm/],
    [{ run: { ...on, comparisonArm: false, paths: { runHome: '/h' } }, read: { riskPin: () => ({ ...pinned, comparisonArm: true }) } }, /pinned its risk record as a declared comparison arm/],
    // Test, final (and a window spanning two roles) are never shown it.
    [{ run: on, gate: { from: D('2025-03-03T14:30:00Z'), to: D('2025-03-03T15:00:00Z') } }, /on a test run: the risk record is shown on practice-train and practice-validate only/],
    [{ run: on, gate: { from: D('2024-06-28T00:00:00Z'), to: D('2024-07-03T00:00:00Z') } }, /on a no-role run/],
  ];
  // Train-derived evidence may be shown on practice-validate (the record holds practice-train days only).
  const validate = P.riskRecord(ctx({ run: on, gate: { from: D('2024-08-05T14:30:00Z'), to: D('2024-08-05T15:00:00Z') } }));
  assert.strictEqual(validate.status, P.PASS, JSON.stringify(validate));
  for (const [over, why] of cases) {
    const res = P.riskRecord(ctx(over));
    assert.strictEqual(res.status, P.FAIL, `${why}: ${JSON.stringify(res)}`);
    assert.match(res.detail, why);
    assert.strictEqual(P.runChecks(ctx(over)).ok, false, `${why}: a FAIL fails the preflight`);
  }
});

test('stage: stage 1 keeps the risk record hidden; stage 2 shows it only on a declared comparison arm', () => {
  const on = { riskRecordDisplay: true, riskRecord: 'rr.json' };
  assert.match(P.stage(ctx({ run: { ...on, comparisonArm: true } })).detail, /stage 1: the risk record stays hidden/);
  assert.strictEqual(P.stage(ctx({ run: { ...on, comparisonArm: true } })).status, P.FAIL);
  const two = P.stage(ctx({ run: { ...on, stage: 2 } }));
  assert.deepStrictEqual([two.status, /shown only on a run declared a comparison arm \(comparisonArm\)/.test(two.detail)], [P.FAIL, true]);
  assert.strictEqual(P.stage(ctx({ run: { ...on, stage: 2, comparisonArm: true, accountStates: STATES_RUN } })).status, P.PASS, 'stage 2 on a comparison arm, from account states: holds');
  assert.strictEqual(P.stage(ctx({ run: { stage: 2, accountStates: STATES_RUN } })).status, P.PASS, 'off: nothing to declare');
});

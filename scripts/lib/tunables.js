'use strict';

/**
 * The harness's tunables as config: config/training.json, config/replay.json, config/runner.json and
 * config/analysis.json, each with its schema here, all loaded through config-files.js (the loader config/schedule.json
 * uses). Code reads a value from here; it never states one. The exceptions stay where they are: a value with a
 * document home (RULEBOOK.md, ACCOUNT.md, a STRATEGY.md) is read from that document, the promotion gate stays frozen
 * code (prop/promotion.js), and pure mechanics (units, indices, parse and protocol limits) stay in code
 * (tests/plugin/no-tunable-literals.test.js lists them).
 *
 *   training   the learning loop's statistics: the stage-1 exit test, the experience index, the risk record, the keep
 *              rule, the paired decision rule, the probe screen, the probe and loop settings' ranges, the A/B
 *              comparison, the proposal limits, the learning report and the field studies
 *   replay     the replay's training presets and draws: latency, the stage presets, the curated lists and moments, the
 *              setup moments, the account-state draw, the driver's retries and the decision labels
 *   runner     the live runner and the order gate: the gate's limits and timing, the trade lifecycle's stop floor and
 *              size cap, the account snapshot, the replay clock, cycles, bars, the prompt's sizes, the live session,
 *              alerts, read-size caps and page sizes, and the Monte Carlo's size (prop/mc-size.js)
 *   analysis   the reads' parameters: indicators, the snapshot, regime, CISD, CRT, volume profile, candles, the
 *              multi-timeframe read, day context, structure, momentum, fair value gaps and the briefing's frames. A
 *              strategy's `params` still override them (market-snapshot.js PARAMS is the defaults a strategy overrides)
 *
 * Fail closed: a missing, unreadable or refused file throws, on every call, naming the file (never a default), so a
 * module that reads one at load refuses to load, and the gate, the runner or the run that needs it refuses to start.
 * Every value is deep-frozen. Tighten-only keys (SPECS[name].tightenOnly; 'exact' is pinned) are held by
 * tests/lib/tunables.test.js against the loosest value ever committed.
 *
 *   NAMES                  ['training', 'replay', 'runner', 'analysis']
 *   SPECS                  { name: spec } (config-files.js specs: name, validate, tightenOnly)
 *   load(name, file)       the value of a file (pure: tests); throws when refused
 *   training(), replay(), runner(), analysis()   the committed value, loaded once per process; throws when refused
 *   fingerprints()         { name: { version, hash } } for every file: what a run and a ledger entry record
 */

const { loadConfigFile, fingerprintOf, shapes, shapeErrors } = require('./config-files');

const { num, bool, str, list, record } = shapes;
const int = (min = 0, max = Infinity) => num({ min, max, int: true });
const pos = (max = Infinity) => num({ min: Number.MIN_VALUE, max });
const nonneg = (max = Infinity) => num({ min: 0, max });
const frac = () => num({ min: 0, max: 1 });
const ms = () => int(0);
const VERSION = str();
/** A setting's default and its allowed range ({ default, min, max }, whole numbers, min <= default <= max). */
const range = () => ({ default: int(), min: int(), max: int() });
const PRESET_VALUE = shapes.record(bool()); // stage defaults: booleans by key

const TRAINING = {
  version: VERSION,
  exitTest: { plannedRR: pos(), avgWinnerR: pos(), expectancyR: nonneg(), expectancyLoAbove: num(), correctReadRate: frac(), processAdherence: frac(), seed: int(), reps: int(1) },
  experienceIndex: { minN: int(1), minDays: int(1), level: num({ min: 0.5, max: 0.999 }), examplesPerMonth: int(1), whyChars: int(1), seed: int(), reps: int(1) },
  experienceLookups: { maxPerBar: int(0) },
  experienceTool: { maxBytes: int(256), similar: int(0) },
  riskRecord: { minN: int(1), maxBytes: int(256) },
  keepRule: { maxChallengerBlows: int(0), level: num({ min: 0.5, max: 0.999 }), primary: str(['passRate']), minBlocks: int(1), minOverlap: frac() },
  decisionRule: { alpha: frac(), minPairs: int(1), minDiscordant: int(1), minEffect: frac(), harmTolerance: frac(), maxExcluded: frac() },
  screen: { gainAlpha: frac(), harmAlpha: frac(), minDiscordant: int(1), minPairs: int(1), minEffect: frac() },
  probe: { k: range(), parallel: range() },
  abCompare: { level: num({ min: 0.5, max: 0.999 }), reps: int(1) },
  loop: {
    repeats: range(), seed: range(), maxFlagged: range(), controlPoints: range(), maxProposals: range(),
    limits: { maxIterations: range(), maxModelCalls: range(), maxWallMinutes: range() },
  },
  proposal: { maxEdits: int(1), maxText: int(1), maxChanged: int(1) },
  learningReport: { rollingDays: int(1), collapseShare: frac(), minCollapse: int(1) },
  looks: { maxArms: int(1) },
  fieldStudy: { quantiles: list(frac(), { min: 1 }), confluenceLevels: list(frac(), { min: 1 }), minEvents: int(1), minDays: int(1), costTicks: nonneg(), reps: int(1), seed: int() },
};

// A stage preset's refused value: true or false (that value refused), or 'set' (any value refused).
const REFUSED = shapes.custom(v => (typeof v === 'boolean' || v === 'set' ? null : "true, false or 'set'"));
const STAGE = { name: str(), defaults: PRESET_VALUE, refused: record(REFUSED), comparisonOnly: list(str()) };
const REPLAY = {
  version: VERSION,
  latency: { tickMs: int(1) },
  stages: { 1: STAGE, 2: STAGE },
  curatedLists: { total: int(1), mix: record(frac()), minSkill: int(0), passShare: record(frac()), seed: int(), yearCap: pos() },
  curatedMoments: { leadSetup: int(0), firstBar: int(0) },
  windowBars: int(1),
  setupLibrary: { minRR: pos() },
  setupMoments: { setupTf: int(1), quietSample: frac(), seed: int(), levels: str(['key', 'wide']), setupTfs: list(int(1), { min: 1 }) },
  accountStates: { seed: int(), count: int(1), meanBlock: int(1), perBucket: int(1), oversample: record(pos()), cutoffs: { nearMll: frac(), nearTarget: frac() } },
  driver: { eodRetries: int(1) },
  labels: { stopAtrMultiples: list(pos(), { min: 1 }), stopAtrRange: list(pos(), { min: 2, max: 2 }), sizeSteps: list(pos(1), { min: 1 }), pairMs: ms() },
};

const RUNNER = {
  version: VERSION,
  gate: {
    pendingOrderTtlMs: ms(), orderGraceMs: ms(), callTimeoutMs: int(1), laneTimeoutMs: int(1), lookupExtraMs: ms(), markerLookbackMs: ms(),
    planMaxAgeMin: int(1), maxConsecutiveLosses: int(1), lossCooldownMin: int(0), maxDailyLosses: int(1), maxEntriesPerDay: int(0),
    mtfMaxAgeMin: int(1), signalMaxAgeBars: int(1), signalMaxAgeCeilingMin: int(1), futureToleranceMin: nonneg(), minConfluence: int(1),
    maxCorrelatedPositions: int(1), noEntryWindows: list(str()), bracketToleranceTicks: nonneg(), bracketSpanToleranceTicks: nonneg(),
  },
  lifecycle: { stopBufferTicks: int(0), floorTicks: int(1), floorAtr: nonneg(), maxSize: int(1) },
  account: { snapshotMaxAgeMs: int(1), balanceToleranceUsd: nonneg(), snapshotFutureToleranceMs: ms(), verdictsKept: int(1) },
  clock: { serverTimeToleranceMs: int(1), wallStartMaxAgeMs: int(1), wallStartAheadMs: ms() },
  cycle: { timeoutMinMinutes: int(1), timeoutBars: int(1), extraCyclesPerDay: int(0), maxConsecutiveErrors: int(1), slowFromMin: int(1), coalesceHoldMs: ms() },
  bars: {
    timeframe: int(1), delaySeconds: nonneg(), pollSeconds: pos(), timeoutSeconds: pos(), staleAfterBars: pos(), maxPollMs: int(1), sleepMaxMs: int(1),
    sleepMinMs: int(1), historyMinBars: int(1), historyDays: int(1), historyDayHours: int(1, 24), premarketAt: str(),
  },
  runner: {
    idleMs: int(1), resyncsBeforeReroll: int(1), lookupRetryMs: ms(), maxRetryMs: int(1), closeSettleMs: ms(), fillGraceMs: ms(), accountReadMs: int(1),
    closeRetryMs: ms(), closeTries: int(1), premarketRetryMs: list(int(1), { min: 1 }), composedWatchMs: ms(), wakeEarlyMs: ms(), minManagedRiskTicks: nonneg(),
    runnerCloseToleranceMs: ms(),
  },
  prompt: {
    recentDecisions: int(1), historyPerLane: int(1), slowerContext: int(0), planChars: int(1), reasonChars: int(1), exitsKept: int(1), unseenReads: int(0),
    sessionStartLessons: int(0), sessionStartLessonChars: int(1), reportMaxText: int(1), phase1MaxAgeMs: ms(), trackRecordMinSlice: int(1),
    trackRecordLiveSlice: int(1), instinctsMinSetupTrades: int(1), instinctsRecentReviews: int(1),
  },
  session: {
    fillsTimeoutMs: int(1), retryTimeoutMs: int(1), retryMs: int(1), retryAlertAfter: int(1), backoffMs: int(1), recentSessions: int(1), archiveDays: int(1),
    archiveMaxDays: int(1), entryMatchMs: ms(), reconcileWindowMin: int(0), gateSlackMs: ms(),
  },
  alerts: { throttleMinutes: nonneg(), staleMinutes: pos(), webhookTimeoutMs: int(1) },
  limits: {
    gateTailBytes: int(1), rolesRanBytes: int(1), skillsLoadedBytes: int(1), skillLookupsBytes: int(1), experienceLookupsBytes: int(1), journalTailBytes: int(1),
    lifecycleBytes: int(1), skillUsageBytes: int(1), barsFileBytes: int(1), headPromptConfigBytes: int(1), historyChunkBars: int(1), entryOrdersKept: int(1), pendingKept: int(1),
  },
  monteCarlo: { paths: int(0), reps: int(0), max: int(1) },
};

const ANALYSIS = {
  version: VERSION,
  indicators: { atrPeriod: int(1), stopAtrPeriod: int(1), adxPeriod: int(1), supertrendPeriod: int(1), supertrendMult: pos(), keltnerLen: int(1), keltnerMult: pos(), keltnerAtr: int(1), swingK: int(1), openingRangeMinutes: int(1) },
  snapshot: { emaFast: int(1), emaSlow: int(1), adxSlopeBars: int(1), stopAtrMult: pos(), vpLookback: int(1) },
  regime: { trendAdx: pos(), rangeAdx: pos(), slopeBars: int(1), slopeAtr: pos(), crossBars: int(1), maxTrendCrosses: int(0), rangeCrosses: int(0), volLookback: int(1), highVol: pos(), lowVol: pos(), minBars: int(1), minBarsOverSlope: int(0) },
  cisd: { minRun: int(1), maxWait: int(1), expiry: int(1), voidTol: nonneg(), bufferAtr: nonneg(), minBody: frac(), minRangeAtr: nonneg() },
  crt: { sweepBars: int(1), shiftBars: int(1), maxDepth: frac(), minRangeAtr: nonneg(), bufferAtr: nonneg(), minRR: pos() },
  volumeProfile: { vpRows: int(1), vpRowSize: nonneg(), vpValueArea: num({ min: 1, max: 100 }), vpNodePct: num({ min: 0, max: 100 }), vpTroughPct: num({ min: 0, max: 100 }), vpThreshold: num({ min: 0, max: 100 }) },
  candles: {
    dojiBody: frac(), wickBody: pos(), wickRange: frac(), otherWick: frac(), dispBody: frac(), dispAtr: pos(), volLen: int(1), volMin: int(1), maxActive: int(1),
    maxLevels: int(1), timeframes: list(int(1), { min: 1 }), rangeFrames: list(int(1), { min: 1 }),
  },
  mtf: { fast: int(1), slow: int(1), rangeLen: int(1), maxCandles: int(1), historyHours: int(1), historyMarginHours: int(0), ruleFrames: list(int(1), { min: 1 }) },
  dayContext: { ibMinutes: int(1), openMinutes: int(1), adrDays: int(1) },
  levelCloses: { maxCloses: int(1) },
  structure: { sweepBars: int(1), swingLevels: int(1), m5Recent: int(1) },
  momentum: { rangeAtr: nonneg(), volRatio: nonneg() },
  composedReads: { volumeHigh: pos(), absorptionProgressAtr: nonneg() },
  fvg: { frames: list(int(1), { min: 1 }), window: int(1), max: int(1) },
  briefing: { equalK: int(1), cisdFrames: list(int(1), { min: 1 }) },
};

const spec = (name, shape, tightenOnly) => Object.freeze({ name, validate: v => shapeErrors(shape, v), tightenOnly: Object.freeze(tightenOnly) });

const SPECS = Object.freeze({
  training: spec('training', TRAINING, {
    // The stage-1 exit test's bars only rise; its sample floors only rise.
    'exitTest.avgWinnerR': 'up', 'exitTest.expectancyR': 'up', 'exitTest.expectancyLoAbove': 'up', 'exitTest.correctReadRate': 'up', 'exitTest.processAdherence': 'up',
    'experienceIndex.minN': 'up', 'experienceIndex.minDays': 'up', 'experienceIndex.level': 'up',
    'experienceLookups.maxPerBar': 'down', 'riskRecord.minN': 'up',
    'keepRule.maxChallengerBlows': 'down', 'keepRule.level': 'up', 'keepRule.primary': 'exact', 'keepRule.minBlocks': 'up', 'keepRule.minOverlap': 'up',
    'decisionRule.alpha': 'down', 'decisionRule.minPairs': 'up', 'decisionRule.minDiscordant': 'up', 'decisionRule.minEffect': 'up', 'decisionRule.harmTolerance': 'down', 'decisionRule.maxExcluded': 'down',
    'screen.gainAlpha': 'down', 'screen.harmAlpha': 'up', 'screen.minDiscordant': 'up', 'screen.minPairs': 'up', 'screen.minEffect': 'up',
    'loop.limits.maxIterations.max': 'down', 'loop.limits.maxModelCalls.max': 'down', 'loop.limits.maxWallMinutes.max': 'down',
    'proposal.maxEdits': 'down', 'proposal.maxText': 'down', 'proposal.maxChanged': 'down',
    'looks.maxArms': 'down',
  }),
  replay: spec('replay', REPLAY, {
    stages: 'exact',
  }),
  runner: spec('runner', RUNNER, {
    // The gate's timing: pinned, each user's stricter direction differs (trading/gate-timing.js).
    'gate.pendingOrderTtlMs': 'exact', 'gate.orderGraceMs': 'exact', 'gate.callTimeoutMs': 'exact', 'gate.laneTimeoutMs': 'exact', 'gate.lookupExtraMs': 'exact', 'gate.markerLookbackMs': 'exact',
    'gate.planMaxAgeMin': 'down', 'gate.maxConsecutiveLosses': 'down', 'gate.lossCooldownMin': 'up', 'gate.maxDailyLosses': 'down', 'gate.maxEntriesPerDay': 'exact',
    'gate.mtfMaxAgeMin': 'down', 'gate.signalMaxAgeBars': 'down', 'gate.signalMaxAgeCeilingMin': 'down', 'gate.futureToleranceMin': 'down', 'gate.minConfluence': 'up',
    'gate.maxCorrelatedPositions': 'down', 'gate.noEntryWindows': 'exact', 'gate.bracketToleranceTicks': 'down', 'gate.bracketSpanToleranceTicks': 'down',
    'lifecycle.stopBufferTicks': 'exact', 'lifecycle.floorTicks': 'up', 'lifecycle.floorAtr': 'up', 'lifecycle.maxSize': 'down',
    'account.snapshotMaxAgeMs': 'down', 'account.balanceToleranceUsd': 'down', 'account.snapshotFutureToleranceMs': 'down',
    'clock.serverTimeToleranceMs': 'down', 'clock.wallStartMaxAgeMs': 'down', 'clock.wallStartAheadMs': 'down',
    'cycle.maxConsecutiveErrors': 'down',
    'bars.staleAfterBars': 'down',
    'runner.closeSettleMs': 'up', 'runner.fillGraceMs': 'exact', 'runner.minManagedRiskTicks': 'exact',
    'monteCarlo.max': 'down',
  }),
  analysis: spec('analysis', ANALYSIS, {}),
});

const NAMES = Object.freeze(Object.keys(SPECS));

function specOf(name) {
  if (!Object.prototype.hasOwnProperty.call(SPECS, name)) throw new Error(`no config "${name}" (${NAMES.join(', ')})`);
  return SPECS[name];
}

const load = (name, file) => loadConfigFile(specOf(name), { file }).value;

const cache = new Map();
/** The committed file, once per process; a refused one throws on every call (never cached, never a default). */
function loaded(name) {
  if (!cache.has(name)) cache.set(name, loadConfigFile(specOf(name)));
  return cache.get(name);
}

const training = () => loaded('training').value;
const replay = () => loaded('replay').value;
const runner = () => loaded('runner').value;
const analysis = () => loaded('analysis').value;

/** { name: { version, hash } } for every config file: recorded by every run and ledger entry. */
function fingerprints() {
  return Object.fromEntries(NAMES.map(n => {
    const f = fingerprintOf(loaded(n));
    return [n, { version: f.version, hash: f.hash }];
  }));
}

module.exports = { NAMES, SPECS, load, training, replay, runner, analysis, fingerprints };

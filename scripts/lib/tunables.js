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
 *              comparison, the proposal, compose, lesson and probe-edit limits, the skills' byte caps, the learning
 *              report and the field studies
 *   replay     the replay's training presets and draws: latency, the stage presets, the curated lists and moments, the
 *              setup moments, the exit-decision scorecard's thresholds, the account-state draw, the driver's retries, the decision labels, the scorecard's
 *              give-back rule and the backtester's plain-run defaults
 *   runner     the live runner and the order gate: the gate's limits and timing, the trade lifecycle's stop floor and
 *              size cap, the account snapshot, the replay clock, cycles, bars, the prompt's sizes, the live session,
 *              alerts, read-size caps and page sizes, and the Monte Carlo's size (prop/mc-size.js)
 *   analysis   the reads' parameters: indicators, the snapshot, regime, CISD, CRT, volume profile, candles, the
 *              multi-timeframe read, day context, structure, momentum, fair value gaps and the briefing's frames. A
 *              strategy's `params` still override them (market-snapshot.js PARAMS is the defaults a strategy overrides),
 *              and the rules evaluator's window
 *
 * A broken file is a CRITICAL config error (config-files.js CriticalConfigError): a missing, unreadable, non-JSON,
 * mistyped, incomplete or unknown-keyed file, or a tighten-only key past its pin (PINS), is refused, naming the file,
 * each key path, what is wrong and what is expected, every problem at once. It is said on stderr, and the gate and the
 * runner log it (gate log, run log). Nothing that opens risk runs on a default: the gate refuses every new entry with
 * it, the runner runs exits-only, and a run, replay, training run or preflight throws it (assertUsable). Exits are
 * never held: a refused runner or analysis file stands in its BUILT_IN values (equal to the shipped file, deep-frozen),
 * so the modules the exits need still load. Every value is deep-frozen.
 *
 *   NAMES                  ['training', 'replay', 'runner', 'analysis']
 *   SPECS                  { name: spec } (config-files.js specs: name, validate, tightenOnly)
 *   PINS                   { name: { key: pin } }: each tighten-only key's loosest value (refused past it on load)
 *   BUILT_IN               { runner, analysis }: the shipped values, used only while that file is refused
 *   load(name, file)       the value of a file (pure: tests); throws the critical error when refused
 *   training(), replay()   the committed value, loaded once per process; throws the critical error when refused
 *   runner(), analysis()   the committed value; refused: BUILT_IN (and critical() says so)
 *   critical()             the critical error naming every refused file, or null
 *   assertUsable()         throws critical() when there is one: a run, replay, training run or preflight starts with it
 *   fingerprints()         { name: { version, hash } } for every file: what a run and a ledger entry record
 */

const { loadConfigFile, fingerprintOf, shapes, shapeErrors, loosened, deepFreeze, hashOf, CriticalConfigError } = require('./config-files');

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
  exitScreen: { epsR: frac(), runnerMfeR: pos() },
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
  // perSkill: one skill's own cap (owner-approved, improves context): candle-reading's reaction-at-a-level read
  // (feat/sweep-candle-control, 2026-10-31; 5916 with the owner rule: a higher timeframe's reaction is stronger confirmation; 6212, owner: rejection relies on candle-reading; the side is the candle's (q30); 6230, owner: no bare rejection (plain is no rejection read); sweeps need candle-reading too; 6338, owner: q30 side confusion; side rule first; 7216 (+878), fix/quiz-side-doji, owner: q29/q30/q33 answered correctly: the side never from the bias, the briefing's side, a stall decides nothing, a refused counter-bias example, a refused counter-bias example). A fixed
  // key, so no other skill can be given more room here.
  skillCaps: { skillBytes: int(1), setupSkillBytes: int(1), perSkill: { 'candle-reading': int(1) } },
  compose: { maxExpects: int(1), maxWhy: int(1) },
  lessons: { maxLines: int(1), maxChars: int(1) },
  probeEdit: { maxLine: int(1), growBytes: int(0) },
  skillUsage: { top: int(1) },
  trendBatch: { start: int(2), max: int(2), half: num({ min: 0.1, max: 0.9 }), growAfter: int(1), growFactor: int(2), plateauRounds: int(1) },
  trendScreen: { rollFlagGaps: list(int(0)) },
  trendWindows: { leadBars: int(0), controlPerLeg: int(0), reach: str(['catch', 'end']) },
  trendSet: { align: str(['all', 'htf']), opening: str(['keep', 'drop']), openingMaxBars: int(1) },
  trendFindings: { examples: int(1), exampleChars: int(80), saidChars: int(40), setupTypes: int(1), setupMinN: int(1) },
  exitFindings: { examples: int(1), exampleChars: int(80) },
  // The round report's control-window false start (train/curriculum.js): a loser whose best R never rose above this.
  trendReport: { falseStartPeakR: pos() },
  // The goal regression (eval/goal-check.js, tests/plugin/goal-regression.test.js): the fixture's draw (goal-fixture.js),
  // its combine Monte Carlo, and how far below main's baseline a metric may fall (tighten-only: they only fall).
  goalRegression: {
    seed: int(), split: str(), blocksPerHalf: int(1), blockSessions: int(1), trendPerHalf: int(0),
    monteCarlo: { paths: int(1), seed: int(), meanBlock: int(1) },
    tolerance: { passRate: frac(), meanR: nonneg(), rCaught: frac() },
    // Tier 2 (eval/goal-path.js, tests/goal/tier2.goal.js): its days (seeded, from the fixture's trend and other days),
    // how many run at once, and its tolerances below main (tighten-only).
    // The golden catch-the-move days (tests/fixtures/goal/move-scenarios.json): known trend legs, a block each in the fixture.
    moveDays: list(str()),
    // The synthetic fixture (eval/goal-synth.js): its draws, the day shapes (ticks a bar, shares of sigma) and its layout.
    // The local goal:real fixture's larger draw (scripts/goal-fixture.js --replay-config).
    real: { blocksPerHalf: int(1), trendPerHalf: int(0), chunkDays: int(1), segmentDays: int(1) },
    synth: {
      seed: int(), symbol: str(), minutes: int(1), startPrice: pos(), breakMin: int(0, 1439), macroDrift: nonneg(), noise: nonneg(),
      sigma: { overnight: pos(), rth: pos() }, wick: { with: nonneg(), against: nonneg() }, volume: { overnight: pos(), rth: pos(), decay: frac() },
      fakeout: { day: str(), startBar: int(0), impulseBars: int(1), reversalBars: int(1), impulseDrift: nonneg(), reversalDrift: nonneg(), volume: pos() },
      quiet: { day: str() },
      compress: { vwapDay: str(), limitDay: str(), boxBars: int(1), quietNoise: nonneg(), expandBars: int(1), expandDrift: nonneg(), confirmDrift: nonneg(), confirmDip: nonneg(), trendDrift: nonneg(), runBars: int(0), gapTicks: nonneg(), wick: { with: nonneg(), against: nonneg() } },
      bleed: { from: str(), sessions: int(1), gapTicks: nonneg() },
      floor: { ticksDay: str(), atrDay: str(), quietBars: int(0), approachBars: int(2), reactionBars: int(1), ticks: { depthTicks: int(0), belowTicks: int(0), crossTicks: int(1), wickTicks: int(1), confirmTicks: int(1), openUnderTicks: int(0), approachBars: int(0) }, atr: { depthTicks: int(0), belowTicks: int(0), crossTicks: int(1), wickTicks: int(1), confirmTicks: int(1), openUnderTicks: int(0) } },
    },
    tier2: { seed: int(), trendDays: int(0), otherDays: int(0), entryMinutes: int(1), maxLossR: pos(), states: { cushionShare: frac(), targetShare: frac() }, parallel: int(1), tolerance: { trades: int(0), totalR: nonneg(), fills: frac(), moveShare: frac() } },
  },
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
  trendCapture: { minMoveAtr: pos(), catchShare: pos(1), messageChars: int(1), curationSessions: list(str(), { min: 1 }), censusBatch: int(1), sizeEdges: list(num({ min: 1 }), { min: 1 }) },
  exitScore: { cutR: pos(), rightR: pos(), lateGivebackR: pos(), horizonBars: int(1), matchBars: int(0) },
  setupMoments: { setupTf: int(1), quietSample: frac(), seed: int(), levels: str(['key', 'wide']), setupTfs: list(int(1), { min: 1 }) },
  accountStates: { seed: int(), count: int(1), meanBlock: int(1), perBucket: int(1), oversample: record(pos()), cutoffs: { nearMll: frac(), nearTarget: frac() } },
  driver: { eodRetries: int(1) },
  labels: { stopAtrMultiples: list(pos(), { min: 1 }), stopAtrRange: list(pos(), { min: 2, max: 2 }), sizeSteps: list(pos(1), { min: 1 }), pairMs: ms() },
  backtest: {
    maxContracts: int(1), maxDailyLoss: nonneg(), warmupBars: int(0), auditJumpAtr: pos(), auditTop: int(1),
    walkForward: { trainMonths: int(1), testMonths: int(1), minTrades: int(1) },
  },
  scorecard: { giveBackMinMfeR: nonneg(), giveBackShare: frac() },
};

const RUNNER = {
  version: VERSION,
  gate: {
    pendingOrderTtlMs: ms(), orderGraceMs: ms(), callTimeoutMs: int(1), laneTimeoutMs: int(1), lookupExtraMs: ms(), markerLookbackMs: ms(),
    planMaxAgeMin: int(1), maxConsecutiveLosses: int(1), lossCooldownMin: int(0), maxDailyLosses: int(1), maxEntriesPerDay: int(0),
    mtfMaxAgeMin: int(1), signalMaxAgeBars: int(1), signalMaxAgeCeilingMin: int(1), futureToleranceMin: nonneg(), minConfluence: int(1),
    maxCorrelatedPositions: int(1), noEntryWindows: list(str()), bracketToleranceTicks: nonneg(), bracketSpanToleranceTicks: nonneg(),
    factsMinChecked: int(0), factsMaxItems: int(1), lateEntryDriftShare: frac(), freshPriceTimeoutMs: int(1),
  },
  lifecycle: { maxSize: int(1) }, // the stop's buffer and floor are the strategy's own: strategies/trade_lifecycle/STRATEGY.md risk
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
    runnerCloseToleranceMs: ms(), calendarWarnDays: int(0), killGraceMs: ms(), exitKillGraceMs: ms(), probeTimeoutMs: int(1), preflightSampleBars: int(1), keptAlertBars: int(1),
  },
  prompt: {
    recentDecisions: int(1), historyPerLane: int(1), slowerContext: int(0), planChars: int(1), reasonChars: int(1), exitsKept: int(1), unseenReads: int(0),
    sessionStartLessons: int(0), sessionStartLessonChars: int(1), reportMaxText: int(1), phase1MaxAgeMs: ms(), trackRecordMinSlice: int(1), lessonMinPlans: int(1),
    trackRecordLiveSlice: int(1), instinctsMinSetupTrades: int(1), instinctsRecentReviews: int(1), valuesPerStrategy: int(1), brokerFieldsKept: int(1),
    brokerFieldsBytes: int(1), brokerFieldChars: int(1), cycleDataMaxBytes: int(1), situationalSkillBytes: int(0), maxPromptBytes: int(1),
  },
  session: {
    fillsTimeoutMs: int(1), retryTimeoutMs: int(1), retryMs: int(1), retryAlertAfter: int(1), backoffMs: int(1), recentSessions: int(1), archiveDays: int(1),
    archiveMaxDays: int(1), entryMatchMs: ms(), reconcileWindowMin: int(0), gateSlackMs: ms(),
  },
  alerts: { throttleMinutes: nonneg(), staleMinutes: pos(), webhookTimeoutMs: int(1) },
  limits: {
    gateTailBytes: int(1), rolesRanBytes: int(1), skillsLoadedBytes: int(1), skillLookupsBytes: int(1), experienceLookupsBytes: int(1), journalTailBytes: int(1),
    lifecycleBytes: int(1), skillUsageBytes: int(1), barsFileBytes: int(1), headPromptConfigBytes: int(1), roleSteps: int(1), repeatReminderAt: list(int(2), { min: 1 }), repeatSameStepMs: int(1), historyChunkBars: int(1), entryOrdersKept: int(1), pendingKept: int(1),
    probeOutputBytes: int(1),
  },
  broker: { cacheKeepDays: int(1), siblingDays: int(0) },
  monteCarlo: { paths: int(0), reps: int(0), max: int(1) },
  // managedBudgetShare: the most of a managed cycle's time its desk may take (runner.js managedCycle), the rest the head trader's.
  desk: { concurrency: int(1), timeoutMinutes: int(1), managedBudgetShare: pos(1) },
  entry: { timeoutMinutes: int(1), phase2RestateRetries: int(0, 1) },
  reviews: { scratchR: nonneg() },
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
  // The reaction read at a level (candle-reaction.js): the long wick's share of the body and of the range, a breakout's
  // body share, and the frames a rejection is checked against (a frame's minutes -> the higher frame's).
  reaction: { wickBody: pos(), wickRange: frac(), breakoutBody: frac(), conflict: record(int(1)) },
  mtf: { fast: int(1), slow: int(1), rangeLen: int(1), maxCandles: int(1), historyHours: int(1), historyMarginHours: int(0), legacyHistoryHours: int(1), ruleFrames: list(int(1), { min: 1 }) },
  dayContext: { ibMinutes: int(1), openMinutes: int(1), adrDays: int(1) },
  levelCloses: { maxCloses: int(1) },
  structure: { sweepBars: int(1), swingLevels: int(1), m5Recent: int(1) },
  momentum: { rangeAtr: nonneg(), volRatio: nonneg() },
  composedReads: { volumeHigh: pos(), absorptionProgressAtr: nonneg(), roomIgnoreR: nonneg(), roomIgnoreTicks: int(0) },
  composeHints: { perStep: int(1), maxTries: int(1) },
  fvg: { frames: list(int(1), { min: 1 }), window: int(1), max: int(1) },
  compression: {
    frames: list(int(1), { min: 1 }), nr: list(int(2), { min: 1 }), maxWidthAtr: pos(), poleBars: int(0), expandAtr: nonneg(), minBeyondAtr: nonneg(), recentBars: int(0),
    maxRunAtr: nonneg(), levelBandAtr: nonneg(), maxLevels: int(1),
  },
  briefing: { equalK: int(1), cisdFrames: list(int(1), { min: 1 }) },
  tradeRead: { frames: list(int(1), { min: 1 }), deepPullback: frac(), minSigns: int(1) },
  evaluator: { windowBars: int(1) },
};

/**
 * The loosest value each tighten-only key may hold ('exact': the one value it may hold). A file past one is refused when
 * it loads, like a mistyped one. A change may only tighten a value here (and in the file), never loosen it; a key leaves
 * the list only with the owner's yes (a change here is a review finding by default: CLAUDE.md).
 */
const PINS = deepFreeze({
  training: {
    'exitTest.avgWinnerR': 1.8, 'exitTest.expectancyR': 0.3, 'exitTest.expectancyLoAbove': 0, 'exitTest.correctReadRate': 0.8, 'exitTest.processAdherence': 0.8,
    'experienceIndex.minN': 20, 'experienceIndex.minDays': 10, 'experienceIndex.level': 0.9, 'experienceLookups.maxPerBar': 2, 'riskRecord.minN': 10,
    'keepRule.maxChallengerBlows': 0, 'keepRule.level': 0.9, 'keepRule.primary': 'passRate', 'keepRule.minBlocks': 2, 'keepRule.minOverlap': 0.5,
    'decisionRule.alpha': 0.05, 'decisionRule.minPairs': 20, 'decisionRule.minDiscordant': 6, 'decisionRule.minEffect': 0.1, 'decisionRule.harmTolerance': 0.02, 'decisionRule.maxExcluded': 0.1,
    'screen.gainAlpha': 0.1, 'screen.harmAlpha': 0.2, 'screen.minDiscordant': 4, 'screen.minPairs': 10, 'screen.minEffect': 0.1, 'exitScreen.epsR': 0.05, 'exitScreen.runnerMfeR': 3,
    'loop.limits.maxIterations.max': 100, 'loop.limits.maxModelCalls.max': 100000, 'loop.limits.maxWallMinutes.max': 10080,
    'proposal.maxEdits': 3, 'proposal.maxText': 2000, 'proposal.maxChanged': 3000, 'looks.maxArms': 3,
    'skillCaps.skillBytes': 3459, 'skillCaps.setupSkillBytes': 4000, 'skillCaps.perSkill.candle-reading': 7216,
    'goalRegression.tolerance.passRate': 0.005, 'goalRegression.tolerance.meanR': 0.005, 'goalRegression.tolerance.rCaught': 0,
    'goalRegression.tier2.tolerance.trades': 0, 'goalRegression.tier2.tolerance.totalR': 0.05, 'goalRegression.tier2.tolerance.fills': 0, 'goalRegression.tier2.tolerance.moveShare': 0, 'goalRegression.tier2.maxLossR': 1.25,
    'goalRegression.seed': 1, 'goalRegression.split': '2022-11-23', 'goalRegression.blocksPerHalf': 3, 'goalRegression.blockSessions': 5, 'goalRegression.trendPerHalf': 8,
    'goalRegression.monteCarlo.paths': 2000, 'goalRegression.monteCarlo.seed': 1, 'goalRegression.monteCarlo.meanBlock': 7,
    'goalRegression.moveDays': ['2021-06-15', '2021-06-24', '2021-10-04', '2021-10-06', '2021-11-19'],
    'goalRegression.tier2.seed': 1, 'goalRegression.tier2.trendDays': 4, 'goalRegression.tier2.otherDays': 2,
    'goalRegression.tier2.entryMinutes': 60, 'goalRegression.tier2.states': {'cushionShare': 0.5, 'targetShare': 0.5}, 'goalRegression.real': {'blocksPerHalf': 6, 'trendPerHalf': 15, 'chunkDays': 7, 'segmentDays': 56},
    'goalRegression.synth': {'seed': 1, 'symbol': 'MNQ', 'minutes': 3, 'startPrice': 15000, 'breakMin': 1020, 'macroDrift': 0.6, 'noise': 0.4, 'sigma': {'overnight': 6, 'rth': 14}, 'wick': {'with': 0.15, 'against': 0.6}, 'volume': {'overnight': 900, 'rth': 900, 'decay': 0.002}, 'fakeout': {'day': '2024-01-08', 'startBar': 4, 'impulseBars': 2, 'reversalBars': 6, 'impulseDrift': 1.8, 'reversalDrift': 1.8, 'volume': 2.5}, 'quiet': {'day': '2024-02-05'}, 'compress': {'vwapDay': '2024-04-08', 'limitDay': '2024-05-06', 'boxBars': 10, 'quietNoise': 0.12, 'expandBars': 5, 'expandDrift': 1, 'confirmDrift': 0.4, 'confirmDip': 0.9, 'trendDrift': 0.8, 'runBars': 25, 'gapTicks': 6, 'wick': {'with': 0.05, 'against': 0.15}}, 'bleed': {'from': '2024-03-04', 'sessions': 10, 'gapTicks': 105}, 'floor': {'ticksDay': '2024-06-03', 'atrDay': '2024-06-10', 'quietBars': 0, 'approachBars': 10, 'reactionBars': 5, 'ticks': {'depthTicks': 0, 'belowTicks': 2, 'crossTicks': 3, 'wickTicks': 3, 'confirmTicks': 1, 'openUnderTicks': 2, 'approachBars': 0}, 'atr': {'depthTicks': 1000, 'belowTicks': 3, 'crossTicks': 4, 'wickTicks': 6, 'confirmTicks': 3, 'openUnderTicks': 0}}},
  },
  replay: {
    stages: {
      1: { name: 'learn to trade', defaults: { latency: true, libraryDisplay: false, riskRecordDisplay: false }, refused: { learning: false, latency: false, libraryDisplay: true, riskRecordDisplay: true, prop: 'set', accountStates: 'set' }, comparisonOnly: [] },
      2: { name: 'pass prop', defaults: { latency: true, libraryDisplay: false, riskRecordDisplay: false }, refused: { learning: false, latency: false, libraryDisplay: true }, comparisonOnly: ['riskRecordDisplay'] },
    },
  },
  runner: {
    'gate.pendingOrderTtlMs': 30000, 'gate.orderGraceMs': 120000, 'gate.callTimeoutMs': 15000, 'gate.laneTimeoutMs': 30000, 'gate.lookupExtraMs': 5000, 'gate.markerLookbackMs': 60000,
    'gate.planMaxAgeMin': 120, 'gate.maxConsecutiveLosses': 2, 'gate.lossCooldownMin': 30, 'gate.maxDailyLosses': 3, 'gate.maxEntriesPerDay': 6, 'gate.mtfMaxAgeMin': 15,
    'gate.signalMaxAgeBars': 3, 'gate.signalMaxAgeCeilingMin': 45, 'gate.futureToleranceMin': 1, 'gate.minConfluence': 1, 'gate.maxCorrelatedPositions': 1,
    'gate.noEntryWindows': ['09:30-09:35@America/New_York', '15:45-16:00@America/New_York'], 'gate.bracketToleranceTicks': 1, 'gate.bracketSpanToleranceTicks': 2,
    'gate.factsMinChecked': 2, 'gate.factsMaxItems': 20, 'gate.lateEntryDriftShare': 0.25, 'gate.freshPriceTimeoutMs': 3000,
    'lifecycle.maxSize': 100, 'prompt.lessonMinPlans': 10,
    'account.snapshotMaxAgeMs': 600000, 'account.balanceToleranceUsd': 0.01, 'account.snapshotFutureToleranceMs': 60000,
    'clock.serverTimeToleranceMs': 300000, 'clock.wallStartMaxAgeMs': 86400000, 'clock.wallStartAheadMs': 5000,
    'cycle.maxConsecutiveErrors': 3, 'bars.staleAfterBars': 0.5, 'runner.closeSettleMs': 10000, 'runner.fillGraceMs': 30000, 'runner.minManagedRiskTicks': 4,
    'runner.killGraceMs': 10000, 'runner.exitKillGraceMs': 2000, 'session.gateSlackMs': 2000, 'runner.keptAlertBars': 3,
    'monteCarlo.max': 20000,
  },
  analysis: {},
});

/**
 * The built-in values: config/runner.json and config/analysis.json as shipped, deep-frozen, never looser (equal: held
 * by tests/lib/tunables.test.js). Read ONLY when that file is refused, so the modules the exits load (the gate hook,
 * the gateway, the runner) still load: exits, protective stops, close_position, partial_close_position, cancel_order
 * and the runner's reconcile and end-of-day flatten keep working, while every entry, run, replay, training run and
 * preflight is refused with the critical error (critical(), assertUsable()). training and replay have none: nothing
 * an exit needs reads them, so a refused one throws.
 */
const BUILT_IN = deepFreeze({
  runner: {
    version: 'v1',
    gate: {
      pendingOrderTtlMs: 30000, orderGraceMs: 120000, callTimeoutMs: 15000, laneTimeoutMs: 30000, lookupExtraMs: 5000, markerLookbackMs: 60000,
      planMaxAgeMin: 120, maxConsecutiveLosses: 2, lossCooldownMin: 30, maxDailyLosses: 3, maxEntriesPerDay: 6, mtfMaxAgeMin: 15,
      signalMaxAgeBars: 3, signalMaxAgeCeilingMin: 45, futureToleranceMin: 1, minConfluence: 1, maxCorrelatedPositions: 1,
      noEntryWindows: ['09:30-09:35@America/New_York', '15:45-16:00@America/New_York'], bracketToleranceTicks: 1, bracketSpanToleranceTicks: 2,
      factsMinChecked: 2, factsMaxItems: 20, lateEntryDriftShare: 0.25, freshPriceTimeoutMs: 3000,
    },
    lifecycle: { maxSize: 100 },
    account: { snapshotMaxAgeMs: 600000, balanceToleranceUsd: 0.01, snapshotFutureToleranceMs: 60000, verdictsKept: 500 },
    clock: { serverTimeToleranceMs: 300000, wallStartMaxAgeMs: 86400000, wallStartAheadMs: 5000 },
    cycle: { timeoutMinMinutes: 3, timeoutBars: 2, extraCyclesPerDay: 10, maxConsecutiveErrors: 3, slowFromMin: 3, coalesceHoldMs: 10000 },
    bars: {
      timeframe: 3, delaySeconds: 2, pollSeconds: 2, timeoutSeconds: 60, staleAfterBars: 0.5, maxPollMs: 10000, sleepMaxMs: 5000, sleepMinMs: 250,
      historyMinBars: 2000, historyDays: 3, historyDayHours: 23, premarketAt: '18:05@America/New_York',
    },
    runner: {
      idleMs: 5000, resyncsBeforeReroll: 3, lookupRetryMs: 30000, maxRetryMs: 60000, closeSettleMs: 10000, fillGraceMs: 30000, accountReadMs: 5000,
      closeRetryMs: 60000, closeTries: 5, premarketRetryMs: [60000, 120000, 300000, 600000], composedWatchMs: 5000, wakeEarlyMs: 5000,
      minManagedRiskTicks: 4, runnerCloseToleranceMs: 60000, calendarWarnDays: 30, killGraceMs: 10000, exitKillGraceMs: 2000, probeTimeoutMs: 600000,
      preflightSampleBars: 20, keptAlertBars: 3,
    },
    prompt: {
      recentDecisions: 10, historyPerLane: 10, slowerContext: 3, planChars: 400, reasonChars: 100, exitsKept: 50, unseenReads: 10,
      sessionStartLessons: 10, sessionStartLessonChars: 300, reportMaxText: 8000, phase1MaxAgeMs: 1800000, trackRecordMinSlice: 10, lessonMinPlans: 10,
      trackRecordLiveSlice: 5, instinctsMinSetupTrades: 3, instinctsRecentReviews: 30, valuesPerStrategy: 6, brokerFieldsKept: 3,
      brokerFieldsBytes: 600, brokerFieldChars: 250, cycleDataMaxBytes: 48000, situationalSkillBytes: 72000, maxPromptBytes: 126976,
    },
    session: {
      fillsTimeoutMs: 10000, retryTimeoutMs: 4000, retryMs: 60000, retryAlertAfter: 5, backoffMs: 1800000, recentSessions: 7, archiveDays: 90,
      archiveMaxDays: 3650, entryMatchMs: 300000, reconcileWindowMin: 10, gateSlackMs: 2000,
    },
    alerts: { throttleMinutes: 10, staleMinutes: 5, webhookTimeoutMs: 5000 },
    limits: {
      gateTailBytes: 4194304, rolesRanBytes: 52428800, skillsLoadedBytes: 52428800, skillLookupsBytes: 5242880, experienceLookupsBytes: 5242880,
      journalTailBytes: 8388608, lifecycleBytes: 67108864, skillUsageBytes: 67108864, barsFileBytes: 52428800, headPromptConfigBytes: 4194304, roleSteps: 40, repeatReminderAt: [3, 5, 8], repeatSameStepMs: 1000,
      historyChunkBars: 10000, entryOrdersKept: 200, pendingKept: 200, probeOutputBytes: 67108864,
    },
    broker: { cacheKeepDays: 30, siblingDays: 30 },
    monteCarlo: { paths: 2000, reps: 2000, max: 20000 },
    desk: { concurrency: 2, timeoutMinutes: 8, managedBudgetShare: 0.5 },
    entry: { timeoutMinutes: 6, phase2RestateRetries: 1 },
    reviews: { scratchR: 0.2 },
  },
  analysis: {
    version: 'v1',
    indicators: {
      atrPeriod: 14, stopAtrPeriod: 20, adxPeriod: 14, supertrendPeriod: 10, supertrendMult: 3, keltnerLen: 20, keltnerMult: 1.5, keltnerAtr: 20,
      swingK: 2, openingRangeMinutes: 15,
    },
    snapshot: { emaFast: 9, emaSlow: 20, adxSlopeBars: 5, stopAtrMult: 0.5, vpLookback: 360 },
    regime: {
      trendAdx: 20, rangeAdx: 18, slopeBars: 5, slopeAtr: 0.3, crossBars: 30, maxTrendCrosses: 3, rangeCrosses: 5, volLookback: 100, highVol: 1.4,
      lowVol: 0.7, minBars: 60, minBarsOverSlope: 30,
    },
    cisd: { minRun: 2, maxWait: 6, expiry: 12, voidTol: 0.05, bufferAtr: 0.1, minBody: 0.6, minRangeAtr: 1 },
    crt: { sweepBars: 10, shiftBars: 5, maxDepth: 0.5, minRangeAtr: 2, bufferAtr: 0.25, minRR: 2 },
    volumeProfile: { vpRows: 100, vpRowSize: 0, vpValueArea: 70, vpNodePct: 9, vpTroughPct: 7, vpThreshold: 1 },
    candles: {
      dojiBody: 0.1, wickBody: 2, wickRange: 0.6, otherWick: 0.15, dispBody: 0.7, dispAtr: 1.5, volLen: 20, volMin: 5, maxActive: 50, maxLevels: 4,
      timeframes: [3, 5, 15, 60, 240], rangeFrames: [60, 240],
    },
    reaction: { wickBody: 1, wickRange: 0.3333, breakoutBody: 0.7, conflict: { 15: 60 } },
    mtf: { fast: 20, slow: 50, rangeLen: 20, maxCandles: 300, historyHours: 504, historyMarginHours: 10, legacyHistoryHours: 240, ruleFrames: [240, 60, 15] },
    dayContext: { ibMinutes: 60, openMinutes: 30, adrDays: 10 },
    levelCloses: { maxCloses: 20 },
    structure: { sweepBars: 10, swingLevels: 3, m5Recent: 3 },
    momentum: { rangeAtr: 1, volRatio: 1 },
    composedReads: { volumeHigh: 1.5, absorptionProgressAtr: 0.5, roomIgnoreR: 0.25, roomIgnoreTicks: 8 },
    composeHints: { perStep: 3, maxTries: 2000 },
    fvg: { frames: [5, 15, 60], window: 60, max: 3 },
    compression: { frames: [3, 5, 15, 60], nr: [7], maxWidthAtr: 2, poleBars: 3, expandAtr: 1, minBeyondAtr: 0.1, recentBars: 3, maxRunAtr: 1, levelBandAtr: 0.25, maxLevels: 3 },
    briefing: { equalK: 2, cisdFrames: [3, 5, 15, 60] },
    tradeRead: { frames: [15], deepPullback: 0.618, minSigns: 2 },
    evaluator: { windowBars: 500 },
  },
});

/**
 * A file's spec: its shape and its tighten-only keys against PINS, every problem of both at once (a key the shape
 * already refused is said once).
 */
function spec(name, shape, tightenOnly) {
  const s = { name, tightenOnly: Object.freeze(tightenOnly) };
  s.validate = v => {
    const errs = shapeErrors(shape, v);
    const shaped = errs.map(e => e.split(/[:[ ]/)[0]);
    const within = k => shaped.some(p => p === k || k.startsWith(`${p}.`) || p.startsWith(`${k}.`));
    // 'runner: gate.x is ...' -> 'gate.x is ...'
    const loose = loosened(s, PINS[name], v).map(e => e.slice(name.length + 2)).filter(e => !within(e.split(' ')[0]));
    return [...errs, ...loose];
  };
  return Object.freeze(s);
}

const SPECS = Object.freeze({
  training: spec('training', TRAINING, {
    // The stage-1 exit test's bars only rise; its sample floors only rise.
    'exitTest.avgWinnerR': 'up', 'exitTest.expectancyR': 'up', 'exitTest.expectancyLoAbove': 'up', 'exitTest.correctReadRate': 'up', 'exitTest.processAdherence': 'up',
    'experienceIndex.minN': 'up', 'experienceIndex.minDays': 'up', 'experienceIndex.level': 'up',
    'experienceLookups.maxPerBar': 'down', 'riskRecord.minN': 'up',
    'keepRule.maxChallengerBlows': 'down', 'keepRule.level': 'up', 'keepRule.primary': 'exact', 'keepRule.minBlocks': 'up', 'keepRule.minOverlap': 'up',
    'decisionRule.alpha': 'down', 'decisionRule.minPairs': 'up', 'decisionRule.minDiscordant': 'up', 'decisionRule.minEffect': 'up', 'decisionRule.harmTolerance': 'down', 'decisionRule.maxExcluded': 'down',
    'screen.gainAlpha': 'down', 'screen.harmAlpha': 'up', 'screen.minDiscordant': 'up', 'screen.minPairs': 'up', 'screen.minEffect': 'up', 'exitScreen.epsR': 'up', 'exitScreen.runnerMfeR': 'down',
    'loop.limits.maxIterations.max': 'down', 'loop.limits.maxModelCalls.max': 'down', 'loop.limits.maxWallMinutes.max': 'down',
    'proposal.maxEdits': 'down', 'proposal.maxText': 'down', 'proposal.maxChanged': 'down',
    'looks.maxArms': 'down',
    'skillCaps.skillBytes': 'down', 'skillCaps.setupSkillBytes': 'down', 'skillCaps.perSkill.candle-reading': 'down',
    // The goal regression's tolerances below main's baseline: only fall (a looser one lets a worse strategy pass).
    'goalRegression.tolerance.passRate': 'down', 'goalRegression.tolerance.meanR': 'down', 'goalRegression.tolerance.rCaught': 'down',
    'goalRegression.tier2.tolerance.trades': 'down', 'goalRegression.tier2.tolerance.totalR': 'down', 'goalRegression.tier2.tolerance.fills': 'down', 'goalRegression.tier2.tolerance.moveShare': 'down', 'goalRegression.tier2.maxLossR': 'down',
    // The yardstick itself (the fixture's draw, the Monte Carlo, the days): pinned exactly, so a looser one can't be shopped for.
    'goalRegression.seed': 'exact', 'goalRegression.split': 'exact', 'goalRegression.blocksPerHalf': 'exact', 'goalRegression.blockSessions': 'exact', 'goalRegression.trendPerHalf': 'exact',
    'goalRegression.monteCarlo.paths': 'exact', 'goalRegression.monteCarlo.seed': 'exact', 'goalRegression.monteCarlo.meanBlock': 'exact', 'goalRegression.moveDays': 'exact',
    'goalRegression.tier2.seed': 'exact', 'goalRegression.tier2.trendDays': 'exact', 'goalRegression.tier2.otherDays': 'exact',
    'goalRegression.tier2.entryMinutes': 'exact', 'goalRegression.tier2.states': 'exact', 'goalRegression.real': 'exact', 'goalRegression.synth': 'exact',
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
    'gate.factsMinChecked': 'up', 'gate.factsMaxItems': 'down',
    // How far past a composed entry's limit, against it, the price may be when the order goes (a share of its stop
    // distance; trading/late-entry.js): only falls.
    'gate.lateEntryDriftShare': 'down',
    // How long the gateway waits for the broker's newest bar before a composed entry (account-gate.js freshEntryPrice):
    // a read that times out refuses the entry, so a shorter wait is stricter (it refuses sooner and holds an exit queued
    // behind it less): only falls.
    'gate.freshPriceTimeoutMs': 'down',
    'lifecycle.maxSize': 'down',
    // The plans a lesson's verdict needs (trading/lesson-advice.js): a higher floor judges later, so it only rises.
    'prompt.lessonMinPlans': 'up',
    'account.snapshotMaxAgeMs': 'down', 'account.balanceToleranceUsd': 'down', 'account.snapshotFutureToleranceMs': 'down',
    'clock.serverTimeToleranceMs': 'down', 'clock.wallStartMaxAgeMs': 'down', 'clock.wallStartAheadMs': 'down',
    'cycle.maxConsecutiveErrors': 'down',
    'bars.staleAfterBars': 'down',
    'runner.closeSettleMs': 'up', 'runner.fillGraceMs': 'exact', 'runner.minManagedRiskTicks': 'exact',
    // How long a stopped run gets before SIGKILL, and the slack matching gate records to a cycle: pinned (a shorter or
    // longer value is stricter for different users).
    'runner.killGraceMs': 'exact', 'runner.exitKillGraceMs': 'exact', 'session.gateSlackMs': 'exact',
    // The passes in a row a flat-reading root's stops are kept on uncertainty before the runner's escalating ALERT
    // (runner.js cleanupFlat): sooner is stricter, so it only falls.
    'runner.keptAlertBars': 'down',
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

/** What still runs while a config file is refused, and what doesn't: the note every critical error carries. */
const NOTE = 'Nothing that opens risk runs on a default: no run, replay, training run, preflight or new entry starts until it is fixed. '
  + 'Exits, protective stops ([protect]), close_position, partial_close_position, cancel_order and the runner\'s reconcile and '
  + 'end-of-day flatten keep working on the built-in values.';

const cache = new Map(); // name -> the loaded file, or (runner, analysis) the built-in stand-in for a refused one
const refused = new Map(); // name -> its CriticalConfigError
const said = new Set();

/** A refused file, recorded once per process and said on stderr (loudly, once: every caller then sees critical()). */
function refuse(name, err) {
  refused.set(name, err);
  if (said.has(name)) return;
  said.add(name);
  try { process.stderr.write(`[fth] ${CriticalConfigError.of([err], NOTE).message}\n`); } catch (_err) { /* stderr gone: critical() still says it */ }
}

/**
 * The committed file, once per process. A refused one is recorded (refuse) and then: runner and analysis stand in their
 * BUILT_IN values (the exits' modules keep loading; critical() refuses everything that opens risk), training and replay
 * throw the critical error naming every refused file, on every call. A refusal stays for the life of the process.
 */
function loaded(name) {
  if (cache.has(name)) return cache.get(name);
  const s = specOf(name);
  try {
    cache.set(name, loadConfigFile(s));
  } catch (err) {
    if (!(err instanceof CriticalConfigError)) throw err;
    refuse(name, err);
    if (!Object.prototype.hasOwnProperty.call(BUILT_IN, name)) throw critical();
    cache.set(name, Object.freeze({ name, file: err.refusals[0].file, value: BUILT_IN[name], hash: hashOf(BUILT_IN[name]), builtIn: true }));
  }
  return cache.get(name);
}

const training = () => loaded('training').value;
const replay = () => loaded('replay').value;
const runner = () => loaded('runner').value;
const analysis = () => loaded('analysis').value;

/**
 * The critical error for every refused config file (each tried once per process), or null when all load: the gate
 * refuses every new entry with it, the runner runs exits-only, and a run, replay, training run or preflight throws it.
 */
function critical() {
  for (const n of NAMES) {
    if (cache.has(n) || refused.has(n)) continue;
    try { loaded(n); } catch (err) { if (!(err instanceof CriticalConfigError)) throw err; }
  }
  const errs = NAMES.filter(n => refused.has(n)).map(n => refused.get(n));
  return errs.length ? CriticalConfigError.of(errs, NOTE) : null;
}

/** Throws the critical error when any config file is refused: what starts a run, replay, training run or preflight calls. */
function assertUsable() {
  const c = critical();
  if (c) throw c;
}

/** { name: { version, hash } } for every config file: recorded by every run and ledger entry (refused: the critical error). */
function fingerprints() {
  assertUsable();
  return Object.fromEntries(NAMES.map(n => {
    const f = fingerprintOf(loaded(n));
    return [n, { version: f.version, hash: f.hash }];
  }));
}

module.exports = { NAMES, SPECS, PINS, BUILT_IN, load, training, replay, runner, analysis, critical, assertUsable, fingerprints };

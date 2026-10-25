'use strict';

// The facts at a missed trend leg's start (scripts/lib/train/trend-facts.js) and what the proposer reads of them
// (trend-findings.js, findings.js): built on the scenario-1 bar briefing (tests/fixtures/trade-lifecycle-scenario.js),
// as the compose-hints tests build theirs. A leg is a finding only when a valid with-trend plan existed at one of its
// entry-able bars; the proposer's text names reads, never a date, time or price; nothing reaches a run home.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { scenario1 } = require('../fixtures/trade-lifecycle-scenario');
const { stopRuleOf } = require('../../scripts/lib/trading/trade-lifecycle');
const X = require('../../scripts/lib/train/trend-facts');
const TF = require('../../scripts/lib/train/trend-findings');
const F = require('../../scripts/lib/train/findings');
const P = require('../../scripts/lib/train/proposer');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const PLAN = { size: 1, tickValue: 0.5, minRR: 2, maxRiskUsd: 300, stopRule: stopRuleOf({ stop_buffer_ticks: 1, stop_floor_ticks: 8, stop_floor_atr: 0.25 }), suggestion: false };
const BAR = '2026-04-23T14:57:00.000Z';
const CLOSE = '2026-04-23T15:00:00.000Z';
const brief = (edit = () => {}) => { const b = scenario1(); b.sections.m3.data.windowEntries = 'allowed'; edit(b); return b; };
const facts = (over = {}) => X.barFacts({ briefing: brief(), side: 'long', tick: 0.25, plan: PLAN, ...over });
const cyc = (code, by, extra = {}) => ({ bar: CLOSE, code, by, step: null, reads: [], message: 'why', ...extra });
const legOf = (cycles, over = {}) => ({ id: `d|long|${BAR}`, day: 'd', side: 'long', start: BAR, captured: false, availableR: 2, blocker: { step: null, code: 'no-plan', by: 'head' }, cycles, ...over });
const ctxOf = (b, over = {}) => ({ briefingAt: t => (t === BAR ? b : null), tick: 0.25, plan: PLAN, minutes: 3, ...over });

test('trend facts: scrub leaves no date, clock time, price, number or id; keeps timeframes and R marks', () => {
  const t = X.scrub('no-trade - 3m rejected session POC 21530.13 at 09:35 ET (2026-04-23T14:57:00.000Z) R:R 1.33 under the min 2, 1.5R, target 2r, 15m and 1h, 0.75x volume, $142.50, record 440961915c28a35f, acct_100k floor');
  assert.strictEqual(t, 'no-trade - 3m rejected session POC at R:R under the min, target 2r, 15m and 1h, volume, record, the account floor');
  assert.doesNotMatch(t, /\d{2}:\d{2}|\d{4}-\d{2}|\d+\.\d+/);
});

test('trend facts: the step-claims of a reason, for the leg\'s side only; a runner\'s entry and a candle never a claim', () => {
  const c = X.statedClaims('no-trade - no short setup (no rejection at a key level, 15m bullish); the long has no confirming entry read', 'short');
  assert.deepStrictEqual(c.map(x => [x.step, x.test, x.word || x.read || '']), [['setup', 'setup', 'setup'], ['setup', 'setup', 'rejection'], ['bias', 'direction', '15m up']]);
  assert.deepStrictEqual(X.statedClaims('no-trade - the long has no confirming entry read', 'short'), [], 'about the other side');
  assert.deepStrictEqual(X.statedClaims('no-trade - no entry candle closed after the 15m rejection', 'short').map(x => x.step), ['entry'], 'the rejection granted: an entry claim only');
  assert.deepStrictEqual(X.statedClaims('no-trade - the runner\'s entry: no late entry', 'long'), [], 'the execution step\'s');
  assert.deepStrictEqual(X.statedClaims('no-trade - under the 15m bearish CISD and a 15m bearish-displacement', 'short'), [], 'a candle named by its timeframe is no direction claim');
  assert.deepStrictEqual(X.statedClaims('no-trade - price is not at a key level, the target: no level ahead; against the trend', 'long').map(x => x.step), ['location', 'target', 'bias']);
});

test('trend facts: a bar with a valid with-trend plan (the standard plan); the verified reads per step, names only', () => {
  const f = facts();
  assert.deepStrictEqual([f.known, f.valid, f.via, f.why], [true, true, 'standard', 'the standard plan passes']);
  assert.ok(f.verified.setup.includes('15m rejected prior vah up'), f.verified.setup.join());
  assert.ok(f.verified.bias.includes('trend long allowed'));
  // The scenario's briefing holds no 5m or 4h candle: their reads unknown, never counted either way.
  assert.deepStrictEqual(f.unknown, ['5m', '4h']);
});

test('trend facts: no valid plan when the window allows no entries, or the trend rule allows the side only as a reversal', () => {
  const closed = facts({ briefing: brief(b => { b.sections.m3.data.windowEntries = 'none'; }) });
  assert.deepStrictEqual([closed.known, closed.valid, closed.why], [true, false, 'the window allows no entries']);
  const against = facts({ side: 'short' });
  assert.deepStrictEqual([against.known, against.valid, against.why], [true, false, 'the trend rule allows the short only as a reversal']);
  const rule = facts({ briefing: brief(b => { b.sections.m3.data.trendRule = ''; }) });
  assert.deepStrictEqual([rule.valid, rule.why], [false, 'the trend rule for the side is unknown']);
});

test('trend facts: under a prop attempt a size must fit; unknown when it can\'t be worked out; the floor\'s refusal is no plan', () => {
  const asked = [];
  const none = facts({ sizeFits: t => { asked.push(t); return false; } });
  assert.deepStrictEqual([none.known, none.valid], [true, false]);
  assert.match(none.why, /no size fits/);
  assert.ok(Number.isInteger(asked[0]) && asked[0] > 0, 'asked with the plan\'s stop ticks');
  const unknown = facts({ sizeFits: () => undefined });
  assert.deepStrictEqual([unknown.known, unknown.valid], [false, false]);
  assert.strictEqual(facts({ sizeFits: () => true }).valid, true);
  // The model's own OK record the leg's way counts (it passed compose_check); the floor's own refusal does not.
  const b = brief(x => { x.sections.m3.data.trendRule = ''; });
  assert.strictEqual(facts({ briefing: b, cycle: cyc('head-pass', 'head') }).valid, true);
  assert.strictEqual(facts({ briefing: b, cycle: cyc('veto', 'phase2') }).why, 'your own plan passed compose_check');
  assert.strictEqual(facts({ briefing: b, cycle: cyc('min-contracts', 'phase2') }).valid, false);
  assert.strictEqual(facts({ briefing: b, cycle: cyc('min-contracts', 'gate') }).valid, false);
});

test('trend facts: unknown, never guessed: no briefing, a frame the rebuild lacks, a recorded check the rebuild disagrees with', () => {
  const none = X.barFacts({ briefing: null, side: 'long', tick: 0.25, plan: PLAN, said: 'x' });
  assert.deepStrictEqual([none.known, none.valid, none.why], [false, false, 'no briefing for the bar']);
  const no1h = facts({ briefing: brief(b => { delete b.sections.m3.data.candles['1h']; }) });
  assert.deepStrictEqual(no1h.unknown, ['5m', '1h', '4h']);
  assert.ok(Object.values(no1h.verified).flat().every(r => !/^(?:stop |target )?1h\b/.test(r)), 'no read on a candle of an unknown frame listed');
  const rec = (check, read = '15m rejected prior vah up') => [{ side: 'long', reads: [{ step: 'setup', skill: 'rejection', read, check }] }];
  assert.strictEqual(facts({ records: rec(true) }).known, true, 'the record and the rebuild agree');
  const off = facts({ records: rec(false) });
  assert.deepStrictEqual([off.known, off.valid], [false, false]);
  assert.match(off.why, /checks the run's compose record differently/);
  assert.strictEqual(facts({ records: rec(false, '5m momentum up') }).known, true, 'a read of an unknown frame is not compared');
});

test('trend facts: a stated claim the verified reads show false is a contradiction; a true one is not', () => {
  const f = facts({ said: 'CYCLE RESULT: no-trade - no long setup (no rejection at a key level); against the trend' });
  assert.deepStrictEqual(f.contradictions.map(c => [c.step, c.read]), [['setup', '15m rejected prior vah up'], ['setup', '15m rejected prior vah up'], ['bias', 'trend long allowed']]);
  assert.deepStrictEqual(facts({ side: 'short', said: 'no-trade - against the trend' }).contradictions, [], 'the trend rule does refuse the short');
  assert.deepStrictEqual(facts({ said: 'no-trade - waiting for a cleaner bar' }).contradictions, []);
  const tf = facts({ said: 'no-trade - 15m bearish' });
  assert.deepStrictEqual(tf.contradictions.map(c => [c.step, c.read]), [['bias', '"15m down" is false']]);
  // A claim the reason check finds false (reasons.js on the bar's facts): the opening drive allows entries.
  const open = brief(b => { b.sections.m3.data.windowUntil = '2026-04-23T15:30:00.000Z'; b.sections.m3.data.et = '11:00'; });
  assert.ok(facts({ briefing: open, said: 'no-trade - opening print window' }).contradictions.some(c => c.step === null && /allows entries/.test(c.read)), 'the reason check\'s false claim kept');
});

test('trend facts: a leg is learnable at any bar with a valid plan; a correct pass when every bar is known and none; else unknown', () => {
  const b = brief();
  const yes = X.legFacts(legOf([cyc('no-plan', 'head')]), ctxOf(b));
  assert.deepStrictEqual([yes.learnable, yes.why, yes.bars.length], [true, 'the standard plan passes', 1]);
  const short = X.legFacts(legOf([cyc('no-plan', 'head')], { side: 'short' }), ctxOf(b));
  assert.deepStrictEqual([short.learnable, short.why], [false, 'no valid plan at the time (a correct pass)']);
  const unknown = X.legFacts(legOf([cyc('no-plan', 'head')]), ctxOf(b, { briefingAt: () => null }));
  assert.deepStrictEqual([unknown.learnable, unknown.why], [null, 'facts unknown at a bar']);
  // Rule-blocked, outside-session and position-open bars are no entry bars.
  const none = X.legFacts(legOf([cyc('opening-print', 'rule'), cyc('outside-session', 'rule'), cyc('position-open', 'head')]), ctxOf(b));
  assert.deepStrictEqual([none.learnable, none.why, none.bars.length], [null, 'no entry-able bar', 0]);
  // The stated reason: the cycle's own CYCLE RESULT line when the run recorded it, else the capture's message.
  const said = X.legFacts(legOf([cyc('no-plan', 'head')]), ctxOf(b, { cycleAt: bar => (bar === CLOSE ? { result: 'CYCLE RESULT: no-trade - no long setup' } : null) }));
  assert.strictEqual(said.bars[0].said, 'CYCLE RESULT: no-trade - no long setup');
});

test('trend facts: a no-plan leg\'s owner is the first flow step its reason and the facts disagree at, and that read\'s skill', () => {
  const b = brief();
  const at = (result) => X.legFacts(legOf([cyc('no-plan', 'head')]), ctxOf(b, { cycleAt: () => ({ result }) }));
  assert.deepStrictEqual(at('no-trade - no entry trigger; no rejection at a key level').owner, { step: 'setup', skill: 'rejection' });
  assert.deepStrictEqual(at('no-trade - against the trend').owner.step, 'bias');
  assert.strictEqual(at('no-trade - nothing to do').owner, null);
  const leg = legOf([cyc('no-plan', 'head')]);
  leg.facts = at('no-trade - no rejection at a key level');
  assert.deepStrictEqual([TF.ownerOf(leg), TF.stepOfLeg(leg)], [{ skill: 'rejection' }, 'setup']);
  assert.deepStrictEqual(TF.ownerOf(leg, { exists: () => false }), {}, 'a skill the tree lacks owns nothing');
  leg.facts = at('no-trade - nothing');
  assert.deepStrictEqual([TF.ownerOf(leg), TF.stepOfLeg(leg)], [{}, null]);
});

/** A capture of missed legs with their facts on the scenario's bar: learnable, a correct pass, unknown, and rules. */
function capture() {
  const b = brief();
  const said = 'CYCLE RESULT: no-trade - no long setup at 10:45 ET (no rejection at 21530.13, 2026-04-23), price 21540.25';
  const withFacts = l => ({ ...l, facts: X.legFacts(l, ctxOf(b, { cycleAt: () => ({ result: said }) })) });
  return { legs: [
    withFacts(legOf([cyc('no-plan', 'head')], { id: 'a', availableR: 3 })),
    withFacts(legOf([cyc('no-plan', 'head')], { id: 'b', availableR: 1 })),
    withFacts(legOf([cyc('no-plan', 'head')], { id: 'c', side: 'short', availableR: 5 })),
    { ...legOf([cyc('no-plan', 'head')], { id: 'd', availableR: 4 }), facts: { learnable: null, why: 'facts unknown at a bar', bars: [], owner: null } },
    legOf([cyc('no-plan', 'head')], { id: 'e', availableR: 4 }),
    legOf([cyc('news', 'rule')], { id: 'f', blocker: { step: null, code: 'news', by: 'rule' } }),
    { ...legOf([], { id: 'g' }), captured: true, blocker: null },
  ] };
}

test('trend findings: learnable legs only; the others counted as a correct pass or unknown, never findings', () => {
  const doc = capture();
  assert.deepStrictEqual(TF.missedTally([doc]), { missed: 5, learnable: 2, noValidPlan: 1, unknown: 2 });
  const found = TF.trendFindings([doc]);
  assert.deepStrictEqual(found.map(f => [f.step, f.skill, f.count, f.cost, f.code, f.of]), [['setup', 'rejection', 2, 4, 'no-plan', 7]]);
  // Up to the configured examples, the costliest leg first; each names reads, what was said and the contradiction.
  const EX = require('../../scripts/lib/tunables').training().trendFindings;
  assert.strictEqual(found[0].examples.length, Math.min(2, EX.examples));
  assert.ok(found[0].examples.every(x => x.length <= EX.exampleChars));
  assert.match(found[0].examples[0], /^long: what you said: "no-trade - no long setup at \(no rejection at\), price"\. Contradiction: setup: you said "no long setup at", the facts: "15m rejected prior vah up" TRUE\. The facts code verified at its start \(5m, 4h reads unknown\): bias "15m up", "1h up", "15m bos up"; location /);
  assert.deepStrictEqual(TF.missedTally([]), { missed: 0, learnable: 0, noValidPlan: 0, unknown: 0 });
});

test('the proposer\'s prompt: a trend finding\'s example legs, no date, clock time or price from the legs', () => {
  const findings = F.mergeFindings(TF.trendFindings([capture()]), [], { max: 8 });
  const line = F.findingLine(findings[0]);
  assert.match(line, /^F1\. rejection: trend-blocker at setup: blocked 2 of 7 trend legs, each with a valid plan at the time\. Most often: no-plan \(2\)\n {3}- leg long: /);
  const prompt = P.probePrompt({ template: P.readProbeTemplate(ROOT), findings, lessons: null, files: ['skills/rejection/SKILL.md'], k: 2 });
  assert.ok(prompt.includes('the facts code verified at its start'), 'the template\'s words for the facts');
  assert.ok(prompt.includes('- leg long: what you said'));
  for (const bad of ['2026-04-23', '10:45', '14:57', '15:00', '21530', '21540', '21512', '21598']) assert.ok(!prompt.includes(bad), bad);
  assert.doesNotMatch(prompt.replace(/\{\{[A-Z]+\}\}/g, ''), /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b|\b\d{4,}(?:\.\d+)?\b/);
});

test('the probe template: its placeholders and the facts lines (the proposer reads it from the skill)', () => {
  const t = P.readProbeTemplate(ROOT);
  for (const k of ['{{FLOW}}', '{{FINDINGS}}', '{{LESSONS}}', '{{FILES}}', '{{CATEGORIES}}', '{{KINDS}}', '{{K}}']) assert.ok(t.includes(k), k);
  assert.match(t, /^- A trend leg lists the facts code verified at its start and what you said → fix the read or rule that hid them\.$/m);
  assert.match(t, /^- Never add a rule that takes a trade on a read the facts don't list\.$/m);
});

test('the iteration\'s status line counts the probe half\'s missed legs: learnable, no valid plan, unknown', () => {
  const IR = require('../../scripts/lib/train/iteration-report');
  const trend = { set: 'fp', batch: { index: 0, size: 4, trigger: 'start', why: '' }, probe: { days: ['d'], legs: ['a'] }, confirm: { days: ['e'], legs: ['b'] }, missed: { missed: 5, learnable: 2, noValidPlan: 1, unknown: 2 } };
  const rec = IR.build({ probeReport: { iteration: 1, trend, findings: [], edits: [], probes: [] } });
  assert.deepStrictEqual(rec.trend.missed, trend.missed);
  assert.match(IR.line(rec), /; probe missed legs 5: learnable 2, no valid plan 1 \(a correct pass\), unknown 2/);
  assert.doesNotMatch(IR.line(IR.build({ probeReport: { iteration: 1, trend: { ...trend, missed: undefined }, findings: [], edits: [], probes: [] } })), /probe missed legs/);
});

// --- the run home, read only -----------------------------------------------------------------------------------------

/** Every file under a folder with its bytes: a snapshot to compare after a read. */
function snapshot(dir) {
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
}

test('attachFacts: the run home\'s bars, cycles and records, read only; the capture in the run\'s folder never changed', () => {
  const { load } = require('../fixtures/trend-moves');
  const { bars, legs } = load();
  const home = tmpDir();
  const runDir = path.join(home, 'replay', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'bars'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bars', 'MNQ-3m.json'), JSON.stringify(bars.m3));
  fs.writeFileSync(path.join(home, 'bars', 'MNQ-1m.json'), JSON.stringify(bars.m1));
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), JSON.stringify({ timeframe: 3, symbols: ['MNQ'], sessions: ['09:30-12:00@America/New_York'] }));
  // A leg with a valid plan at a bar the set records (trend-moves legs.json), its cycle logged there.
  const leg = legs.legs.find(l => l.moments.some(m => m.validPlan));
  const m = leg.moments.find(x => x.validPlan);
  const close = new Date(Date.parse(m.bar) + 180000).toISOString();
  const day = path.join(home, 'logs', 'cycles', leg.day);
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, '000000-trade.json'), JSON.stringify({ action: 'trade', result: `CYCLE RESULT: no-trade - no ${leg.side} setup`, timing: { barClose: close } }));
  const doc = { legs: [{ id: leg.id, day: leg.day, side: leg.side, start: leg.start, captured: false, availableR: 1, blocker: { step: null, code: 'no-plan', by: 'head' }, cycles: [{ bar: close, code: 'no-plan', by: 'head', step: null, reads: [], message: 'x' }] }] };
  fs.writeFileSync(path.join(runDir, 'trend-capture.json'), JSON.stringify(doc));
  const before = snapshot(home);
  const got = X.attachFacts(doc, { runDir, home, tree: ROOT });
  assert.deepStrictEqual(snapshot(home), before, 'nothing in the run home written or changed');
  assert.strictEqual(doc.legs[0].facts, undefined, 'the given capture untouched');
  assert.deepStrictEqual([got.legs[0].facts.learnable, got.legs[0].facts.bars[0].said], [true, `CYCLE RESULT: no-trade - no ${leg.side} setup`]);
  assert.deepStrictEqual(got.legs[0].facts.bars[0].unknown, [], 'the 1m bars give the 5m facts');
  // No timeframe or symbol in the run's config: every missed leg's facts unknown, never guessed.
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), '{}');
  assert.deepStrictEqual(X.attachFacts(doc, { runDir, home, tree: ROOT }).legs[0].facts.learnable, null);
});

test('the trend facts reach no trading prompt: only the training loop requires them', () => {
  const users = [];
  const walk = d => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js') && /require\([^)]*trend-facts['"]\)/.test(fs.readFileSync(path.join(ROOT, p), 'utf8'))) users.push(p); } };
  walk('scripts');
  walk('hooks');
  assert.deepStrictEqual(users.sort(), ['scripts/lib/train/probe.js', 'scripts/lib/train/trend-findings.js']);
});

test('sizeWithin: budgetPlan\'s sizing at a budget and room given, as an attempt line recorded them', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { loadAccounts } = require('../../scripts/lib/trading/accounts');
  const { loadStrategies } = require('../../scripts/lib/trading/strategies');
  const policy = loadStrategies(ROOT, {}).strategies.find(s => s.valid && s.signal === 'policy' && s.sizing);
  const account = loadAccounts(ROOT, {}).accounts.find(a => a.name === policy.account);
  const big = prop.sizeWithin({ dollars: 600, room: 2000 }, account, policy, 'MNQ', 40);
  assert.ok(big.size >= 1 && !big.error, JSON.stringify(big));
  const small = prop.sizeWithin({ dollars: 5, room: 2000 }, account, policy, 'MNQ', 40);
  assert.strictEqual(small.size, 0, 'under the floor: none fits');
  assert.match(prop.sizeWithin({ dollars: 600, room: 2000 }, account, policy, 'MNQ', 0).error, /stopLossBracket\.ticks/);
});

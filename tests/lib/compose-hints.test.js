'use strict';

// compose_check's refusal hints (scripts/lib/trading/compose-hints.js): per failing flow step, the reads TRUE on the
// bar, and a whole combination that passes when one exists. Built from scripted facts (the scenario-1 briefing,
// tests/fixtures/trade-lifecycle-scenario.js); the hints never change a verdict and list only reads the checker
// verifies TRUE on the bar.

const test = require('node:test');
const assert = require('node:assert');
const { scenario1, SCENARIO_1 } = require('../fixtures/trade-lifecycle-scenario');
const { checkReads, checkRead, parseRead } = require('../../scripts/lib/trading/composed-reads');
const { planOf, stopRuleOf, buildRecord, renderRecord } = require('../../scripts/lib/trading/trade-lifecycle');
const H = require('../../scripts/lib/trading/compose-hints');

const RULE = stopRuleOf({ stop_buffer_ticks: 1, stop_floor_ticks: 8, stop_floor_atr: 0.25 });
const PLAN = { size: 1, tickValue: 0.5, minRR: 2, maxRiskUsd: 300, stopRule: RULE, suggestion: false };
const brief = (edit = () => {}) => { const b = scenario1(); b.sections.m3.data.windowEntries = 'allowed'; edit(b); return b; };
const swap = (step, read) => [...SCENARIO_1.filter(r => r.step !== step), { step, skill: 'candle-reading', read, why: 'x' }];
function hints(reads, { b = brief(), side = 'long', standard = null } = {}) {
  const checked = checkReads({ reads, side, briefing: b });
  const planned = checked.stop && checked.target ? planOf({ checked, briefing: b, side, tick: 0.25, ...PLAN }) : null;
  const before = JSON.stringify(checked);
  const lines = H.hintsFor({ checked, planned, briefing: b, side, tick: 0.25, plan: PLAN, standard });
  assert.strictEqual(JSON.stringify(checked), before, 'the hints never touch the check');
  return { checked, planned, lines, b, side };
}
const quoted = line => [...line.replace(/\(R:R [^)]*\)/, '').matchAll(/"([^"]+)"/g)].map(m => m[1]);
/** Every read a hint lists is TRUE on the bar (the checker's own check) and agrees with the side. */
function allTrue({ lines, b, side }) {
  for (const l of lines) {
    for (const read of quoted(l)) {
      const c = checkRead(parseRead(read), b, { tick: 0.25 });
      assert.strictEqual(c.check, true, `${read}: ${c.fact}`);
      assert.ok(!c.dir || c.dir === side, `${read} points ${c.dir}`);
    }
  }
}
/** The listed passing combination, composed again: OK on the same bar (the steps as the reads' own). */
function passes(line, b, side) {
  const steps = { bias: 'bias', location: 'location' };
  let setupSeen = false;
  const reads = quoted(line).map(read => {
    const p = parseRead(read);
    const step = p.kind === 'stop' || p.kind === 'target' ? p.kind
      : ['relation', 'cisd', 'ote', 'swept'].includes(p.kind) ? 'setup'
        : p.kind === 'pattern' ? (setupSeen ? 'entry' : 'setup')
          : ['close', 'momentum', 'volume', 'participation', 'absorption'].includes(p.kind) ? 'entry'
            : ['at', 'vwap', 'value'].includes(p.kind) ? steps.location : steps.bias;
    if (step === 'setup') setupSeen = true;
    return { step, skill: 'candle-reading', read };
  });
  const ch = checkReads({ reads, side, briefing: b });
  const pl = planOf({ checked: ch, briefing: b, side, tick: 0.25, ...PLAN });
  return ch.ok && Boolean(pl.plan) && !pl.problems.length;
}

test('compose hints: none on an OK combination', () => {
  const r = hints(SCENARIO_1);
  assert.strictEqual(r.checked.ok, true);
  assert.deepStrictEqual(r.lines, []);
});

test('compose hints: a directionless entry names the TRUE confirmations on a candle closed after the setup, and a passing whole', () => {
  const r = hints(swap('entry', '3m volume high'));
  assert.strictEqual(r.checked.ok, false, 'still refused');
  const entry = r.lines.find(l => l.startsWith('entry:'));
  assert.match(entry, /^entry: volume and participation point no side, so they never confirm alone; the confirmation your way on a candle closed after the setup's \(10:45 ET\), true here: "3m momentum up", "3m close top"/);
  const whole = r.lines.find(l => l.startsWith('these reads pass together'));
  assert.ok(whole && /"3m momentum up"/.test(whole), whole);
  assert.ok(passes(whole, r.b, 'long'), 'the listed combination passes compose_check on this bar');
  allTrue(r);
});

test('compose hints: a false target lists the named levels at the minimum R:R from the stop, with their R', () => {
  const r = hints(swap('target', 'target 1h swing 21600'));
  assert.strictEqual(r.checked.ok, false);
  assert.ok(r.lines.includes('target: named levels at 2R or more from the stop at 21512.75: "target 1h swing high 21598" (2.08R)'), r.lines.join('\n'));
  allTrue(r);
});

test('compose hints: a target under the minimum R:R with no named level reaching it says so, nearest first', () => {
  const r = hints(swap('target', 'target 15m swing 21560'), { b: brief(b => { b.sections.m3.data.swingTargets.above = [{ frame: '15m', price: 21560 }]; }) });
  assert.ok(r.planned.problems.some(p => /^R:R .* under the strategy's min 2/.test(p)));
  assert.match(r.lines.find(l => l.startsWith('target:')), /^target: no named level reaches 2R from the stop at 21512\.75 \(nearest: "target 15m swing high 21560" 0\.71R/);
  allTrue(r);
});

test('compose hints: no named level on the winning side: the hint names the 2R mark, and the whole passes with it', () => {
  const r = hints(swap('target', 'target 1h swing 21598'), { b: brief(b => { b.sections.m3.data.swingTargets.above = []; b.keyLevels = b.keyLevels.filter(x => x[1] < 21540); }) });
  assert.ok(r.lines.includes('target: no named level the trade\'s way: "target 2r", the 2R mark 21595.75 from the stop at 21512.75; past it the runner trails'), r.lines.join('\n'));
  const whole = r.lines.find(l => l.startsWith('these reads pass together'));
  assert.ok(whole && whole.includes('"target 2r"') && passes(whole, r.b, 'long'), whole);
});

test('compose hints: a setup on the base candle: no later candle can confirm it; the higher candles\' reactions that a later close confirms', () => {
  const r = hints(swap('setup', '3m broke prior vah up'));
  assert.ok(r.checked.problems.some(p => /closed after the setup's/.test(p)), 'the 2-bar rule refuses it, as before');
  assert.match(r.lines.find(l => l.startsWith('entry:')), /^entry: a 3m setup is this bar's own candle, so no later candle can confirm it; a reaction on a higher candle that a later close confirms, true here: "15m rejected prior vah up"/);
  allTrue(r);
});

test('compose hints: the confirmation not closed yet: wait for the next base close (no entry read listed on the setup\'s own candle)', () => {
  const b = brief(x => { x.sections.m3.data.candles['3m'].closedAt = '2026-04-23T14:45:00.000Z'; delete x.sections.m3.data.candles['1h']; });
  const r = hints(SCENARIO_1, { b });
  assert.strictEqual(r.checked.ok, false);
  assert.ok(r.lines.includes('entry: no candle closed after the setup\'s (10:45 ET) confirms the long yet: wait for the next 3m close, or pass'), r.lines.join('\n'));
});

test('compose hints: a setup with no read pointing the side lists the reactions the side\'s way with their candle\'s close', () => {
  const r = hints(swap('setup', '15m touched prior rth high'));
  assert.match(r.lines.find(l => l.startsWith('setup:')), /^setup: the reaction your way \(up\), true here: "15m rejected prior vah up" \(closed 10:45 ET\)/);
  allTrue(r);
});

test('compose hints: a false stop lists the TRUE stops on the losing side at the minimum distance or more, nearest first', () => {
  const r = hints(swap('stop', 'stop 15m low 21510'));
  assert.ok(r.lines.includes('stop: true on the losing side here: "stop 3m low 21529.75", "stop 15m low 21512.75", "stop swing low 21512.75" (the stop goes beyond it; a closer one than the minimum is refused)'), r.lines.join('\n'));
  // A stop under D13's floor is never listed: with a 60-tick floor the 3m low (43 ticks with the buffer) drops out.
  const far = hints(swap('stop', 'stop 15m low 21510'), { b: brief(b => { b.sections.m3.data.referenceStop.distance = 30; }) });
  assert.ok(!/stop 3m low/.test(far.lines.find(l => l.startsWith('stop:'))));
  allTrue(r);
});

test('compose hints: the side the trend rule refuses: no whole combination offered, the reversal tier named', () => {
  const r = hints(SCENARIO_1, { side: 'short' });
  assert.ok(!r.lines.some(l => l.startsWith('these reads pass together')));
  assert.ok(r.lines.includes('the trend rule allows the short only as a reversal (a verified CHoCH tier among the bias reads)'));
  assert.ok(r.lines.includes('setup: no candle reacted down on this bar: no setup for the short'));
  allTrue(r);
  // A long the check would pass whole once its entry is fixed, on a bar whose trend rule takes the long only as a
  // reversal: the step's reads are listed, the whole is not.
  const against = hints(swap('entry', '3m volume high'), { b: brief(b => { b.sections.m3.data.trendRule = 'Trend rule: SHORT allowed (prevailing 1h down); long only as a reversal (mtf: reversal).'; }) });
  assert.ok(against.lines.some(l => l.startsWith('entry: ')));
  assert.ok(!against.lines.some(l => l.startsWith('these reads pass together')), against.lines.join('\n'));
  assert.ok(against.lines.includes('the trend rule allows the long only as a reversal (a verified CHoCH tier among the bias reads)'));
});

test('compose hints: no whole combination outside an entry window; the standard plan named when it passes', () => {
  const closed = hints(swap('entry', '3m volume high'), { b: brief(b => { b.sections.m3.data.windowEntries = 'none'; }) });
  assert.ok(!closed.lines.some(l => l.startsWith('these reads pass together')));
  const std = { status: 'traded', reads: SCENARIO_1, plan: { rr: 2.08 } };
  const r = hints(swap('entry', '3m volume high'), { standard: std });
  assert.ok(r.lines.some(l => l.startsWith('the standard plan passes: compose_check with its reads: "1h bos up", ') && l.endsWith('(R:R 2.08)')));
  assert.ok(!r.lines.some(l => l.startsWith('these reads pass together')), 'one whole combination, the standard plan first');
});

test('compose hints: repairOf keeps the model\'s TRUE reads, fills only the failing step, and never returns what the check refuses', () => {
  const b = brief();
  const fixed = H.repairOf({ reads: swap('entry', '3m volume high'), side: 'long', briefing: b, tick: 0.25, plan: PLAN });
  assert.ok(fixed && fixed.checked.ok);
  assert.deepStrictEqual(fixed.reads.filter(r => r.step !== 'entry').map(r => r.read), swap('entry', '3m volume high').filter(r => r.step !== 'entry').map(r => r.read));
  assert.deepStrictEqual(fixed.reads.filter(r => r.step === 'entry').map(r => r.read), ['3m momentum up']);
  assert.strictEqual(H.repairOf({ reads: SCENARIO_1, side: 'long', briefing: b, tick: 0.25, plan: PLAN }), null, 'an OK combination needs no repair');
  assert.strictEqual(H.repairOf({ reads: SCENARIO_1, side: 'long', briefing: null, tick: 0.25, plan: PLAN }), null);
  // From no reads at all, the whole is the candidates' and still passes the real check and plan.
  const whole = H.repairOf({ reads: [], side: 'long', briefing: b, tick: 0.25, plan: PLAN });
  assert.ok(whole && whole.checked.ok && !whole.planned.problems.length);
});

test('compose hints: failingSteps names each step by the check\'s own problems and the plan\'s', () => {
  const b = brief();
  const checked = checkReads({ reads: swap('entry', '3m volume high'), side: 'long', briefing: b });
  assert.deepStrictEqual(H.failingSteps(checked, null), { entry: ['pointing'] });
  const missing = checkReads({ reads: SCENARIO_1.filter(r => r.step !== 'target'), side: 'long', briefing: b });
  assert.deepStrictEqual(H.failingSteps(missing, null), { target: ['missing'] });
  const rr = { problems: ['R:R 1.500 is under the strategy\'s min 2', 'the stop is 10 ticks, under the minimum 40 (max of 8 ticks and 0.25 x ATR(20)): refused, never widened; name a level further away, or pass'] };
  assert.deepStrictEqual(H.failingSteps(checkReads({ reads: SCENARIO_1, side: 'long', briefing: b }), rr), { target: ['rr'], stop: ['floor'] });
});

test('compose hints: the record\'s text shows the hints only when it is not OK', () => {
  const b = brief();
  const checked = checkReads({ reads: swap('entry', '3m volume high'), side: 'long', briefing: b });
  const rec = buildRecord({ at: '2026-04-23T15:00:05Z', root: 'MNQ', symbol: 'MNQ', side: 'long', briefing: b, checked, planned: null });
  const text = renderRecord(rec, checked, ['entry: x']);
  assert.match(text, /- HINT entry: x\nNOT OK: no entry on this record/);
  const ok = checkReads({ reads: SCENARIO_1, side: 'long', briefing: b });
  const okRec = buildRecord({ at: '2026-04-23T15:00:05Z', root: 'MNQ', symbol: 'MNQ', side: 'long', briefing: b, checked: ok, planned: planOf({ checked: ok, briefing: b, side: 'long', tick: 0.25, ...PLAN }) });
  assert.ok(!/HINT/.test(renderRecord(okRec, ok, ['entry: x'])));
});

test('compose hints: the skill\'s entry row lists only reads the check counts as pointing a side; its support-only reads point none', () => {
  const text = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'skills', 'trade-lifecycle', 'SKILL.md'), 'utf8');
  const row = text.split('\n').find(l => /^\s*\| entry \|/.test(l));
  assert.ok(row && !/volume high|participation high/.test(row), 'no directionless read in the entry row');
  assert.match(text, /Support only, never the setup or entry read: `at`, `touched`, `swept`,\s+`in ote`, `3m volume high`, `participation high`/);
  const b = brief(x => { const c = x.sections.m3.data.candles['3m']; c.patterns = ['hammer']; c.volRatio = 1.6; x.sections.m3.data.participation = { relVolLast3VsPrior20: 2 }; });
  const dir = read => checkRead(parseRead(read), b, { tick: 0.25 });
  for (const read of ['3m close top', '3m momentum up', '3m pattern hammer']) assert.strictEqual(dir(read).dir, 'long', read);
  assert.strictEqual(parseRead('3m absorption at prior vah up').kind, 'absorption');
  for (const read of ['3m volume high', 'participation high', 'at prior vah', '15m touched prior rth high']) {
    const c = dir(read);
    assert.strictEqual(c.check, true, `${read}: ${c.fact}`);
    assert.strictEqual(c.dir, null, `${read} points no side`);
  }
});

test('compose hints: the bias hint lists only reads pointing the side (a range regime is TRUE but no bias for it)', () => {
  // Scenario 1 with a range regime, read for the short: of the bias forms only "regime range" is TRUE, and it points no side.
  const b = brief(x => { x.sections.m3.data.regime = { ...(x.sections.m3.data.regime || {}), primary: 'range' }; });
  assert.deepStrictEqual(H.candidatesOf(b, 'short', { tick: 0.25 }).bias.map(x => [x.read, x.dir]), [['regime range', null]]);
  const checked = checkReads({ reads: [{ step: 'bias', skill: 'x', read: '15m down' }], side: 'short', briefing: b });
  const lines = H.hintsFor({ checked, planned: null, briefing: b, side: 'short', tick: 0.25, plan: PLAN });
  assert.ok(lines.includes('bias: no bias read for the short is true on this bar'), lines.join('\n'));
  assert.ok(!lines.some(l => l.includes('regime range')), lines.join('\n'));
  // The long's bias hint still lists its side's reads.
  const long = hints(swap('bias', '4h down'), { b });
  assert.match(long.lines[0], /^bias: true for the long here: "15m up", "1h up", "15m bos up"$/);
});

test('compose hints: no setup read yet: the entry hint says a confirmation counts only on a candle closed after the setup\'s', () => {
  const b = brief(x => {
    const d = x.sections.m3.data;
    for (const tf of Object.keys(d.candles)) Object.assign(d.candles[tf], { relations: [], fvgRelations: [], patterns: [] });
    d.cisd = {};
  });
  assert.deepStrictEqual(H.candidatesOf(b, 'long', { tick: 0.25 }).setup, []);
  const checked = checkReads({ reads: SCENARIO_1.filter(r => !['setup', 'entry'].includes(r.step)), side: 'long', briefing: b });
  const lines = H.hintsFor({ checked, planned: null, briefing: b, side: 'long', tick: 0.25, plan: PLAN });
  assert.ok(lines.includes('entry: no setup read for the long is true yet; a confirmation counts only on a candle closed after the setup\'s: the setup first'), lines.join('\n'));
  assert.ok(!lines.some(l => /^entry: .*true here/.test(l)), 'no confirmation listed before a setup');
});

// The policy's entry rule (entry-rule.js): a problem no read can satisfy (bias frames, regime against) means no repair and
// no reversal hint; a leg-turned problem a leg read satisfies keeps the repair.
const { entryRuleOf } = require('../../scripts/lib/trading/entry-rule');
const OFF3 = { bias_frames: 'off', bias_agree: 'off', regime_against: 'off', leg_turned: 'off' };
const hintsWith = (reads, rule, b, side = 'long') => {
  const checked = checkReads({ reads, side, briefing: b, entryRule: rule });
  const planned = checked.stop && checked.target ? planOf({ checked, briefing: b, side, tick: 0.25, ...PLAN }) : null;
  return { checked, lines: H.hintsFor({ checked, planned, briefing: b, side, tick: 0.25, plan: PLAN, entryRule: rule }) };
};

test('compose hints: bias frames trending against the side: no repair and no reversal hint (the entry rule refuses them too)', () => {
  const against = brief(b => { b.sections.h1.data.h1.trend = 'down'; b.sections.m3.data.trendRule = 'Trend rule: prevailing trend 1h down; trend strategies may not go long.'; });
  const reads = swap('entry', '3m volume high');
  const rule = entryRuleOf({ ...OFF3, bias_frames: ['4h', '1h'] });
  const on = hintsWith(reads, rule, against);
  assert.ok(on.checked.problems.some(p => /^entry rule: .*1h trend is down/.test(p)), on.checked.problems.join());
  assert.strictEqual(H.repairOf({ reads, side: 'long', briefing: against, tick: 0.25, plan: PLAN, entryRule: rule }), null);
  assert.ok(!on.lines.some(l => /these reads pass together|only as a reversal/.test(l)), on.lines.join('\n'));
  // Keys off: the reversal hint stays, as before.
  assert.ok(hintsWith(reads, null, against).lines.some(l => /only as a reversal/.test(l)));
});

test('compose hints: the regime against the side: no repair (no read changes the regime)', () => {
  const down = brief(b => { b.sections.m3.data.regime = { primary: 'trend-down', volatility: 'normal' }; });
  const reads = swap('entry', '3m volume high');
  const rule = entryRuleOf({ ...OFF3, regime_against: 'on' });
  const on = hintsWith(reads, rule, down);
  assert.ok(on.checked.problems.some(p => /^entry rule: the regime is trend-down/.test(p)));
  assert.strictEqual(H.repairOf({ reads, side: 'long', briefing: down, tick: 0.25, plan: PLAN, entryRule: rule }), null);
  assert.ok(!on.lines.some(l => /these reads pass together/.test(l)));
});

test('compose hints: a leg-turned problem keeps the repair: a leg read of the model\'s own completes a combination that passes', () => {
  const rule = entryRuleOf({ ...OFF3, leg_turned: 'on' });
  const reads = [...swap('entry', '3m volume high'), { step: 'bias', skill: 'candle-reading', read: '3m bos up', why: 'x' }];
  const b = brief();
  const fixed = H.repairOf({ reads, side: 'long', briefing: b, tick: 0.25, plan: PLAN, entryRule: rule });
  assert.ok(fixed && fixed.checked.ok, 'repaired');
  assert.ok(fixed.reads.some(r => r.read === '3m bos up'));
  assert.ok(hintsWith(reads, rule, b).lines.some(l => /these reads pass together/.test(l)));
  // Without the leg read the entry rule's leg problem stands, and every combination offered carries it or none is offered.
  const none = H.repairOf({ reads: swap('entry', '3m volume high'), side: 'long', briefing: b, tick: 0.25, plan: PLAN, entryRule: rule });
  assert.ok(none === null || none.checked.ok);
});

test('compose hints: no named level reaching 2R, the 4h and 1h both the side\'s way: the hint is the trail, and the whole passes with it (never a pass for want of a level)', () => {
  const aligned = b => { b.sections.m3.data.swingTargets.above = [{ frame: '15m', price: 21560 }]; b.sections.h1.data.h4 = { trend: 'up' }; };
  const r = hints(swap('target', 'target 15m swing 21560'), { b: brief(aligned) });
  assert.ok(r.planned.problems.some(p => /^R:R .* under the strategy's min 2/.test(p)));
  assert.strictEqual(r.lines.find(l => l.startsWith('target:')), 'target: HTF-aligned (4h and 1h your way): "target trail" (the 2R mark 21595.75 from the stop at 21512.75 arms it); a level ahead is context, never a requirement');
  const whole = r.lines.find(l => l.startsWith('these reads pass together'));
  assert.ok(whole && whole.includes('"target trail"') && passes(whole, r.b, 'long'), whole);
  // The targets a plan can take: aligned, the trail first, the named ones context after it; not aligned (scenario 1's
  // own 4h range): no trail.
  assert.deepStrictEqual(H.targetsOf(brief(aligned), 'long', 0.25).map(x => x.read), ['target trail', 'target 15m swing high 21560']);
  // Aligned with a named level at 2R or more: still the trail (the level is context, never the requirement).
  const far = hints(swap('target', 'target 1h swing 21600'), { b: brief(b => { b.sections.h1.data.h4 = { trend: 'up' }; }) });
  assert.match(far.lines.find(l => l.startsWith('target:')), /^target: HTF-aligned \(4h and 1h your way\): "target trail"/);
  assert.ok(!H.targetsOf(brief(), 'long', 0.25).some(x => x.trail));
});

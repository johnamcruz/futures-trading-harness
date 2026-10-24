'use strict';

/**
 * The trend-move set (tests/fixtures/trend-moves): twelve NY-session legs, the model's refused plans in their first
 * halves, run through the real compose_check (harness-tools/compose.js) on the rebuilt bar briefings. Offline, no
 * model. It proves:
 *
 *   - the check's verdicts are the recorded ones (strictness unchanged: the same problems, plan for plan);
 *   - every read a refusal's hints list is TRUE on its bar and agrees with the side;
 *   - the guided retry: where a hint lists a whole combination, composing exactly those reads on the same bar is OK;
 *   - per leg, whether a valid trend-following plan at the strategy's R:R existed in its first half (the window open,
 *     the trend rule allowing the side), and that every such leg is caught by a guided retry there;
 *   - nothing case-specific: no skill, agent, rule, strategy or the hints' code names a leg's date or price.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { load, briefingAt } = require('../fixtures/trend-moves');
const { composeCheck } = require('../../scripts/lib/harness-tools/compose');
const { writeBriefing } = require('../../scripts/lib/trading/briefing');
const { checkReads, checkRead, parseRead, STEP_KINDS } = require('../../scripts/lib/trading/composed-reads');
const { planOf, stopRuleOf } = require('../../scripts/lib/trading/trade-lifecycle');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { trendRuleOf } = require('../../scripts/lib/trading/reasons');
const H = require('../../scripts/lib/trading/compose-hints');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC = loadStrategies(ROOT, {}).strategies.find(s => s.name === 'trade_lifecycle');
const PLAN = { size: 1, tickValue: 0.5, minRR: DOC.risk.min_rr, maxRiskUsd: DOC.risk.max_risk_usd, stopRule: stopRuleOf(DOC.risk), suggestion: false };
const { legs } = load().legs;
const home = tmpDir();

/** The real compose_check on a bar of the set: its briefing written to a run home, the cycle bar set. */
function compose(bar, side, reads) {
  writeBriefing(home, briefingAt(bar));
  const env = { FTH_HOME: home, FTH_CYCLE_BARS: JSON.stringify({ MNQ: bar }) };
  return composeCheck({ symbol: 'MNQ', side, reads, size: 1 }, { env, now: () => new Date(Date.parse(bar) + 185000), replayAt: () => null }).text;
}
const quoted = line => [...line.replace(/\(R:R [^)]*\)$/, '').matchAll(/"([^"]+)"/g)].map(m => m[1]);
/** A hint line listing a whole passing combination (the standard plan's or the repaired one), or null. */
const wholeOf = text => text.split('\n').find(l => /^- HINT (these reads pass together|the standard plan passes)/.test(l)) || null;
/** The listed reads as compose_check reads: each in its step (a pattern is the setup's until a setup is stated). */
function asReads(line) {
  let setup = false;
  return quoted(line).map(read => {
    const p = parseRead(read);
    let step = p.kind === 'stop' || p.kind === 'target' ? p.kind : (STEP_KINDS[p.kind] || ['bias'])[0];
    if (p.kind === 'pattern') step = setup ? 'entry' : 'setup';
    if (step === 'setup') setup = true;
    return { step, skill: 'candle-reading', read };
  });
}
const firstHalfPlans = () => legs.flatMap(l => l.plans.map(p => ({ ...p, leg: l.id })));

test('trend-move set: every recorded refused plan is refused for the same problems (the check as strict as before)', () => {
  const plans = firstHalfPlans();
  assert.ok(plans.length >= 50, `${plans.length} plans`);
  for (const p of plans) {
    const b = briefingAt(p.bar);
    const checked = checkReads({ reads: p.reads, side: p.side, briefing: b, tick: 0.25 });
    const planned = checked.stop && checked.target ? planOf({ checked, briefing: b, side: p.side, tick: 0.25, ...PLAN, size: 1, suggestion: true }) : null;
    const problems = [...checked.problems, ...(planned ? planned.problems : [])];
    assert.deepStrictEqual(problems, p.problems, `${p.leg} ${p.bar}`);
    assert.ok(!(checked.ok && planned && !planned.problems.length), `${p.leg} ${p.bar} stays refused`);
  }
});

test('trend-move set: the refusals\' hints list only TRUE reads; each listed whole passes compose_check on its bar', () => {
  let wholes = 0;
  for (const p of firstHalfPlans()) {
    const text = compose(p.bar, p.side, p.reads);
    assert.match(text, /\nNOT OK: no entry on this record/, `${p.leg} ${p.bar}`);
    const b = briefingAt(p.bar);
    for (const l of text.split('\n').filter(x => x.startsWith('- HINT '))) {
      // The 2R mark is TRUE by the combination's own stop (the room rule's R): judged with its whole below.
      for (const read of quoted(l).filter(x => x !== 'target 2r')) {
        const c = checkRead(parseRead(read), b, { tick: 0.25 });
        assert.strictEqual(c.check, true, `${p.leg} ${p.bar} ${read}: ${c.fact}`);
        assert.ok(!c.dir || c.dir === p.side, `${read} points ${c.dir}`);
      }
    }
    const whole = wholeOf(text);
    if (!whole) continue;
    wholes += 1;
    assert.match(compose(p.bar, p.side, asReads(whole)), /\nOK: every read verified and the plan stands/, `${p.leg} ${p.bar}: ${whole}`);
  }
  // The guided retries that pass (pinned: a change that loses one is a regression, one that adds one says why). 40
  // before the room band's tick cap (2026-10-24): 6 passed only through the uncapped 0.25R band, a level more than
  // 8 ticks ahead skipped by a wide stop; such a level is in the way now, whatever the stop.
  assert.strictEqual(wholes, 34);
});

test('trend-move set: per leg, a valid trend-following plan in its first half where the set says, and every such leg caught by a guided retry', () => {
  const caught = [];
  for (const l of legs) {
    let first = null;
    for (const m of l.moments) {
      const b = briefingAt(m.bar);
      const d = b.sections.m3.data;
      const allowed = d.windowEntries === 'allowed' && trendRuleOf(d.trendRule)[l.side] === true;
      const valid = allowed && Boolean(H.repairOf({ reads: [], side: l.side, briefing: b, tick: 0.25, plan: PLAN }));
      assert.strictEqual(valid, m.validPlan, `${l.id} ${m.bar}`);
      if (valid && !first) first = m;
    }
    if (!first) continue;
    // The guided retry: the model's latest refused reads in the leg before that bar (none: its bias alone), composed
    // there; the refusal lists a whole; composing it is OK.
    const prior = l.plans.filter(p => p.bar <= first.bar).pop();
    const reads = prior ? prior.reads : [{ step: 'bias', skill: 'multi-timeframe-analysis', read: `trend ${l.side} allowed` }];
    const whole = wholeOf(compose(first.bar, l.side, reads));
    assert.ok(whole, `${l.id} ${first.bar}: a whole combination listed`);
    assert.match(compose(first.bar, l.side, asReads(whole)), /\nOK: every read verified/, `${l.id}`);
    caught.push(l.id);
  }
  // Eight legs had a valid plan in their first half; the other four started in the opening print or against the
  // trend rule (both kept). Every one of the eight is caught.
  assert.deepStrictEqual(caught, legs.filter(l => l.moments.some(m => m.validPlan)).map(l => l.id));
  assert.strictEqual(caught.length, 8);
});

test('trend-move set: nothing case-specific in the instructions or the hints\' code (no leg date or price)', () => {
  const prices = new Set();
  for (const l of legs) {
    for (const x of [l.from, l.to]) prices.add(String(x));
    for (const p of l.plans) for (const r of p.reads) for (const n of String(r.read).match(/\d{5}(\.\d+)?/g) || []) prices.add(n);
  }
  const days = [...new Set(legs.map(l => l.day))];
  const files = [];
  const walk = dir => { for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(md|js|json)$/.test(e.name)) files.push(p); } };
  for (const d of ['skills', 'agents', 'rules', 'strategies', 'commands']) walk(d);
  files.push('scripts/lib/trading/compose-hints.js', 'scripts/lib/trading/composed-reads.js', 'scripts/lib/harness-tools/compose.js', 'scripts/lib/replay/trend-capture.js');
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const d of days) assert.ok(!text.includes(d), `${f} names ${d}`);
    for (const p of prices) assert.ok(!new RegExp(`(^|[^\\d.])${p.replace('.', '\\.')}(?![\\d])`).test(text), `${f} names ${p}`);
  }
});

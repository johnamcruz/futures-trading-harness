'use strict';

// Stated reasons checked against a live bar's facts (scripts/lib/trading/reasons.js): the facts built from a bar
// briefing, the attempts and the verdicts, and the June misreads coming back FALSE against them.

const test = require('node:test');
const assert = require('node:assert');
const { factsFromBriefing, reasonCheck, renderCheck, trendRuleOf, checkReasons } = require('../../scripts/lib/trading/reasons');
const scorecard = require('../../scripts/lib/replay/scorecard');

const RULE_UP = 'Trend rule: prevailing trend 4h up; trend strategies may not go short; reversal strategies (mtf: reversal) may go short too.';
const RULE_NONE = 'Trend rule: no trend on 4h, 1h, or 15m; both sides open to every strategy.';

/** A bar briefing as the runner writes it (only the fields the check reads). */
function briefing({ window = 'opening drive', until = '2026-06-10T15:00:00.000Z', entries = 'allowed', et = '09:57', candidates = [], rule = RULE_NONE, alignment = { long: 'aligned', short: 'counter' } } = {}) {
  return {
    symbol: 'MNQ', minutes: 3, asOf: '2026-06-10T13:54:00.000Z', closedAt: '2026-06-10T13:57:00.000Z',
    sections: {
      m3: { version: 'm3@x', validUntil: '2026-06-10T14:00:00.000Z', data: { et, window, windowUntil: until, windowEntries: entries, candidates, trendRule: rule } },
      m15: { version: 'm15@x', validUntil: '2026-06-10T14:00:00.000Z', data: { alignment } },
    },
  };
}
const ORB = { name: 'orb', direction: 'long', stopPoints: 10, needR: 2, inTheWay: { name: 'IB high', R: 3.1 }, trendRule: 'allows', alignment: 'aligned', confluence: { with: [], against: [] }, vwapSide: 'above' };
const KELTNER = { name: 'keltner', direction: 'short', stopPoints: 8, needR: 1.5, inTheWay: { name: 'VWAP (rth)', R: 0.4 }, trendRule: 'allows', alignment: 'mixed', confluence: { with: [], against: [] }, vwapSide: 'below' };
const ACTIVE = [{ account: 'topstep_50k', started: true, status: 'active', entryBlock: null }];
const VERDICT = { strategy: 'prop_portfolio', component: 'orb', direction: 'long', action: 'full', maxSize: 3, contract: 'MNQ', stopTicks: 40, bar: '2026-06-10T13:54:00.000Z' };
const claim = (r, kind) => r.claims.find(c => c.kind === kind);

test('trendRuleOf: the briefing\'s Trend rule line per side', () => {
  assert.deepStrictEqual(trendRuleOf(RULE_UP), { prevailing: '4h up', long: true, short: false });
  assert.deepStrictEqual(trendRuleOf('Trend rule: prevailing trend 1h down; trend strategies may not go long; reversal strategies (mtf: reversal) may go long too.'), { prevailing: '1h down', long: false, short: true });
  assert.deepStrictEqual(trendRuleOf('Trend rule: no trend on 4h, 1h, or 15m; both sides open to every strategy.'), { prevailing: null, long: true, short: true });
  assert.deepStrictEqual(trendRuleOf('Trend rule: too few 15m candles; trend strategies can\'t enter yet, reversal strategies can.'), { prevailing: null, long: false, short: false });
  assert.deepStrictEqual(trendRuleOf(undefined), { prevailing: null, long: null, short: null });
});

test('factsFromBriefing: the window, the trend rule, the setups with room and read, a verdict on its component, the attempt', () => {
  const f = factsFromBriefing(briefing({ candidates: [ORB] }), { attempts: ACTIVE, verdicts: [VERDICT] });
  assert.deepStrictEqual(f.window, { name: 'opening drive', until: '11:00', et: '09:57', entriesAllowed: true });
  assert.deepStrictEqual(f.trendRule, { prevailing: null, long: true, short: true });
  assert.strictEqual(f.scanned, true);
  assert.deepStrictEqual(f.setups.map(s => [s.name, s.direction, s.policy, s.candidate, s.style, s.trendAllows]), [['orb', 'long', false, true, 'trend', true], ['prop_portfolio', 'long', true, true, 'trend', true]]);
  assert.deepStrictEqual(f.setups[1].room, { inTheWay: { name: 'IB high', R: 3.1 }, needR: 2 }, 'the verdict takes its component\'s facts');
  assert.deepStrictEqual([f.setups[1].component, f.setups[1].verdict.maxSize], ['orb', 3]);
  assert.deepStrictEqual(f.attempt, { account: 'topstep_50k', status: 'active', entryBlock: null });
  // No attempt started: none; the attempts unknown: null (a claim about it is unchecked).
  assert.deepStrictEqual(factsFromBriefing(briefing(), { attempts: [{ account: 'topstep_50k', started: false }] }).attempt, { account: null, status: 'none', entryBlock: null });
  assert.strictEqual(factsFromBriefing(briefing()).attempt, null);
  // The scan failed (candidates null): not scanned; a window without its entries: unknown.
  assert.strictEqual(factsFromBriefing(briefing({ candidates: null })).scanned, false);
  assert.strictEqual(factsFromBriefing(briefing({ entries: null })).window, null);
  assert.deepStrictEqual(factsFromBriefing(briefing({ window: 'opening print', until: '2026-06-10T13:35:00.000Z', entries: 'none', et: '09:31' })).window, { name: 'opening print', until: '09:35', et: '09:31', entriesAllowed: false });
});

test('reasonCheck: the June misreads come back FALSE, each with the fact', () => {
  const f = factsFromBriefing(briefing({ candidates: [ORB, KELTNER] }), { attempts: ACTIVE, verdicts: [VERDICT] });
  const attempt = reasonCheck('CYCLE RESULT: no-trade - no prop attempt running', f);
  assert.strictEqual(claim(attempt, 'no-attempt').check, false);
  assert.match(claim(attempt, 'no-attempt').why, /the topstep_50k attempt is active/);
  const trend = reasonCheck('CYCLE RESULT: no-trade - keltner short blocked by the 15m down trend rule', f);
  assert.strictEqual(claim(trend, 'trend-blocks').check, false);
  assert.match(claim(trend, 'trend-blocks').why, /the trend rule \(no prevailing trend\) allows short/);
  const up = factsFromBriefing(briefing({ rule: RULE_UP, candidates: [{ ...KELTNER, trendRule: 'against' }] }));
  assert.strictEqual(claim(reasonCheck('no-trade - keltner short blocked by the 4h up trend rule', up), 'trend-blocks').check, true);
  const none = reasonCheck('CYCLE RESULT: no-trade - no candidate strategies', f);
  assert.strictEqual(claim(none, 'nothing-fired').check, false);
  assert.match(claim(none, 'nothing-fired').why, /prop_portfolio long \(verdict full 3\)/);
  const window = reasonCheck('CYCLE RESULT: no-trade - opening print window until 10:00 ET', f);
  assert.strictEqual(claim(window, 'no-entry-window').check, false);
  assert.match(claim(window, 'no-entry-window').why, /the opening drive window allows entries \(09:57 ET\)/);
  for (const r of [attempt, trend, none, window]) {
    assert.strictEqual(r.status, 'false');
    assert.strictEqual(r.falseCount, 1);
    assert.match(renderCheck(r), /- FALSE [^\n]*\n[^]*1 reason FALSE: name it, drop it, and make the decision again from the facts\.\n$/);
  }
  // A verdict alone is a candidate too ("no candidates" with a verdict and nothing else fired).
  const verdictOnly = factsFromBriefing(briefing({ candidates: [] }), { attempts: ACTIVE, verdicts: [VERDICT] });
  assert.strictEqual(claim(reasonCheck('no-trade - no candidates', verdictOnly), 'nothing-fired').check, false);
  assert.strictEqual(claim(reasonCheck('no-trade - no active policy verdict', verdictOnly), 'no-verdict').check, false);
});

test('reasonCheck: true reasons come back TRUE; judgment and unparsed clauses are named, never confirmed', () => {
  const opening = factsFromBriefing(briefing({ window: 'opening print', until: '2026-06-10T13:35:00.000Z', entries: 'none', et: '09:31', candidates: [] }), { attempts: [] });
  const r = reasonCheck('CYCLE RESULT: no-trade - opening print window (no entries allowed until 09:35 ET); no candidates; no prop attempt running', opening);
  assert.deepStrictEqual(r.claims.map(c => [c.kind, c.check]), [['no-entry-window', true], ['nothing-fired', true], ['no-attempt', true]]);
  assert.strictEqual(r.status, 'confirmed');
  assert.match(renderCheck(r), /No reason is false by these facts/);
  const f = factsFromBriefing(briefing({ candidates: [ORB, KELTNER] }), { attempts: ACTIVE });
  const room = reasonCheck('VERDICT: VETO - keltner short: VWAP at 0.4R vs 1.5R needed; ADX falling; the moon is full', f);
  assert.strictEqual(room.stated, 'veto');
  assert.deepStrictEqual(room.claims.map(c => [c.kind, c.check, c.about]), [['no-room', true, 'keltner']]);
  assert.deepStrictEqual(room.judgment, ['ADX falling']);
  assert.deepStrictEqual(room.unparsed, ['the moon is full']);
  assert.strictEqual(room.status, 'unchecked', 'an unparsed clause leaves it unchecked, never confirmed');
  const text = renderCheck(room);
  assert.match(text, /- TRUE no-room: "keltner short: VWAP at 0\.4R vs 1\.5R needed" - keltner: VWAP \(rth\) at 0\.4R, it needs 1\.5R/);
  assert.match(text, /- JUDGMENT "ADX falling": yours to weigh/);
  assert.match(text, /- UNPARSED "the moon is full": no fact recognized; check it yourself/);
  // The attempt unknown (no attempts read): the claim is unchecked.
  assert.strictEqual(claim(reasonCheck('no prop attempt running', factsFromBriefing(briefing())), 'no-attempt').check, 'unchecked');
  // The scan failed: a nothing-fired claim is unchecked.
  assert.strictEqual(claim(reasonCheck('no candidates', factsFromBriefing(briefing({ candidates: null }))), 'nothing-fired').check, 'unchecked');
});

test('reasonCheck: each setup\'s priority-order steps, one by one', () => {
  const f = factsFromBriefing(briefing({ candidates: [ORB, KELTNER] }), { attempts: ACTIVE });
  const r = reasonCheck('no-trade - stood aside', f);
  assert.deepStrictEqual(r.steps.map(s => [s.setup, s.direction, s.steps.map(x => x.result)]), [
    ['orb', 'long', ['pass', 'pass', 'pass', 'pass', 'judgment', 'no-trade', 'pass']],
    ['keltner', 'short', ['pass', 'pass', 'no-trade', 'half', 'judgment', 'no-trade', 'pass']],
  ]);
  assert.match(renderCheck(r), /- keltner short: 1 hard stops pass \(no hard stop\); 2 trend rule pass \(the trend rule allows a short\); 3 room no-trade \(VWAP \(rth\) at 0\.4R before the 1\.5R it needs\); 4 multi-timeframe read half/);
  assert.match(renderCheck(reasonCheck('x', factsFromBriefing(briefing()))), /The priority order: no setup on this bar/);
});

test('the scorecard and the tool share one checker', () => {
  assert.strictEqual(scorecard.checkReasons, checkReasons);
  assert.strictEqual(scorecard.STEPS, require('../../scripts/lib/trading/reasons').STEPS);
});

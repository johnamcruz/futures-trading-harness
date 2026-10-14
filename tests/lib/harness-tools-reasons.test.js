'use strict';

// The reason_check harness tool (scripts/lib/harness-tools/reasons.js): the stated reasons checked against this
// cycle's bar briefing, the verdicts on that bar and the started attempts; the same through the MCP tool and the CLI.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpDir } = require('../helpers');
const B = require('../../scripts/lib/trading/briefing');
const prop = require('../../scripts/lib/trading/prop-state');
const { accountNamed } = require('../../scripts/lib/trading/accounts');
const { check, parseArgv } = require('../../scripts/lib/harness-tools/reasons');
const { callTool } = require('../../scripts/lib/harness-tools/protocol');

const ROOT = path.resolve(__dirname, '..', '..');
const AS_OF = '2026-06-10T13:54:00.000Z';
const CLOSED = '2026-06-10T13:57:00.000Z';
const RULE_DOWN = 'Trend rule: prevailing trend 1h down; trend strategies may not go long; reversal strategies (mtf: reversal) may go long too.';
const KELTNER = { name: 'keltner', direction: 'short', stopPoints: 8, needR: 1.5, inTheWay: { name: 'VWAP (rth)', R: 0.4 }, trendRule: 'allows', alignment: 'mixed', confluence: { with: [], against: [] } };

/** A home with this bar's briefing (the opening drive, entries allowed), and, optionally, an attempt and a verdict. */
function home({ attempt = false, verdict = false } = {}) {
  const h = tmpDir();
  B.writeBriefing(h, {
    symbol: 'MNQ', minutes: 3, asOf: AS_OF, closedAt: CLOSED,
    sections: {
      m3: { version: 'm3@x', validUntil: '2026-06-10T14:00:00.000Z', data: { et: '09:57', window: 'opening drive', windowUntil: '2026-06-10T15:00:00.000Z', windowEntries: 'allowed', candidates: [KELTNER], trendRule: RULE_DOWN } },
      m15: { version: 'm15@x', validUntil: '2026-06-10T14:00:00.000Z', data: { alignment: { long: 'aligned', short: 'mixed' } } },
    },
  });
  if (attempt) prop.startAttempt(h, accountNamed(ROOT, 'topstep_50k', {}), new Date('2026-06-10T12:00:00Z'));
  if (verdict) {
    prop.appendVerdict(h, { strategy: 'prop_portfolio', component: 'keltner', direction: 'short', action: 'full', maxSize: 2, contract: 'MNQ', stopTicks: 40, bar: AS_OF, at: CLOSED, expiresAt: '2026-06-10T14:00:00.000Z' });
    // Another bar's verdict, and another family's, are not this bar's.
    prop.appendVerdict(h, { strategy: 'old_policy', component: 'bos', direction: 'short', action: 'full', maxSize: 1, contract: 'MNQ', stopTicks: 40, bar: '2026-06-10T13:51:00.000Z', at: CLOSED, expiresAt: '2026-06-10T14:00:00.000Z' });
    prop.appendVerdict(h, { strategy: 'mes_policy', component: 'bos', direction: 'short', action: 'full', maxSize: 1, contract: 'MES', stopTicks: 40, bar: AS_OF, at: CLOSED, expiresAt: '2026-06-10T14:00:00.000Z' });
  }
  return h;
}
const env = (h, extra = {}) => ({ FTH_HOME: h, NODE_ENV: 'test', FTH_TEST_NOW: '2026-06-10T13:57:30.000Z', FTH_CYCLE_BARS: JSON.stringify({ MNQ: AS_OF }), ...extra });
const ctx = (h, extra) => ({ root: ROOT, env: env(h, extra) });

test('reason_check: the June misreads are FALSE against this bar\'s facts', () => {
  const h = home({ attempt: true, verdict: true });
  const run = reasons => check({ symbol: 'MNQ', reasons }, ctx(h)).text;
  assert.match(run('CYCLE RESULT: no-trade - no prop attempt running'), /- FALSE no-attempt: "no prop attempt running" - the topstep_50k attempt is active\n/);
  assert.match(run('CYCLE RESULT: no-trade - keltner short blocked by the 15m down trend rule'), /- FALSE trend-blocks: "keltner short blocked by the 15m down trend rule" - the trend rule \(1h down\) allows short\n/);
  assert.match(run('CYCLE RESULT: no-trade - no candidate strategies'), /- FALSE nothing-fired: "no candidate strategies" - fired: prop_portfolio short \(verdict full 2\)\n/);
  const window = run('CYCLE RESULT: no-trade - opening print window until 10:00 ET');
  assert.match(window, /- FALSE no-entry-window: "opening print window until 10:00 ET" - the opening drive window allows entries \(09:57 ET\)\n/);
  assert.match(window, /1 reason FALSE: name it, drop it, and make the decision again from the facts\.\n$/);
  // Only this bar's verdict, of this family.
  const json = JSON.parse(check({ symbol: 'MNQ', reasons: 'no-trade - no candidates', json: true }, ctx(h)).text);
  assert.deepStrictEqual(json.steps.map(s => `${s.setup} ${s.direction}`), ['keltner short', 'prop_portfolio short']);
  assert.strictEqual(json.falseCount, 1);
});

test('reason_check: the same policy\'s verdict on another family (recorded later) never hides this family\'s', () => {
  const h = home();
  const v = { strategy: 'prop_portfolio', component: 'keltner', direction: 'short', action: 'full', maxSize: 2, stopTicks: 40, bar: AS_OF, at: CLOSED, expiresAt: '2026-06-10T14:00:00.000Z' };
  prop.appendVerdict(h, { ...v, contract: 'MNQ' });
  prop.appendVerdict(h, { ...v, contract: 'MES', action: 'skip', maxSize: 0 });
  const t = check({ symbol: 'MNQ', reasons: 'CYCLE RESULT: no-trade - no active policy verdict' }, ctx(h)).text;
  assert.match(t, /- FALSE no-verdict: "no active policy verdict" - verdict: prop_portfolio short full\n/);
  // The latest per strategy within the family, as the gate keys it: a later MNQ skip on the bar replaces the full.
  prop.appendVerdict(h, { ...v, contract: 'MNQ', action: 'skip', maxSize: 0, reason: 'budget below one contract' });
  assert.match(check({ symbol: 'MNQ', reasons: 'no-trade - prop_portfolio verdict is skip' }, ctx(h)).text, /- TRUE verdict-skip: "prop_portfolio verdict is skip" - verdict: prop_portfolio short skip \(budget below one contract\)\n/);
});

test('reason_check: true reasons TRUE, the unparsed unchecked; no attempt started is "none"', () => {
  const h = home();
  const t = check({ symbol: 'MNQ', reasons: 'VERDICT: VETO - keltner short: VWAP at 0.4R vs 1.5R needed; no prop attempt running; the moon is full' }, ctx(h)).text;
  assert.match(t, /- TRUE no-room: [^\n]*keltner: VWAP \(rth\) at 0\.4R, it needs 1\.5R\n/);
  assert.match(t, /- TRUE no-attempt: "no prop attempt running" - the attempt is none\n/);
  assert.match(t, /- UNPARSED "the moon is full"/);
  assert.match(t, /No reason is false by these facts; an UNCHECKED or UNPARSED one is still yours to check\.\n$/);
});

test('reason_check: no current briefing (another bar\'s, none) checks nothing and says so; bad arguments refused', () => {
  const h = home();
  assert.match(check({ symbol: 'MNQ', reasons: 'no candidates' }, ctx(h, { FTH_CYCLE_BARS: JSON.stringify({ MNQ: '2026-06-10T13:57:00.000Z' }) })).text, /^No current bar briefing for MNQ: no facts here to check the reasons against/);
  assert.match(check({ symbol: 'MES', reasons: 'no candidates' }, ctx(h)).text, /^No current bar briefing for MES/);
  // Outside a cycle: the briefing is current until its m3 expires.
  assert.match(check({ symbol: 'MNQ', reasons: 'no candidates' }, ctx(h, { FTH_CYCLE_BARS: '' })).text, /- FALSE nothing-fired/);
  assert.match(check({ symbol: 'MNQ', reasons: 'no candidates' }, ctx(h, { FTH_CYCLE_BARS: '', FTH_TEST_NOW: '2026-06-10T14:05:00.000Z' })).text, /^No current bar briefing/);
  assert.throws(() => check({ symbol: 'mnq', reasons: 'x' }, ctx(h)), /--symbol: a contract root/);
  assert.throws(() => check({ symbol: 'MNQ', reasons: '  ' }, ctx(h)), /--reasons: the decision and reasons you stated/);
  assert.throws(() => check({ symbol: 'MNQ', reasons: 'x'.repeat(2001) }, ctx(h)), /at most 2000 characters/);
  assert.deepStrictEqual(parseArgv(['--symbol=MNQ', '--reasons', 'no candidates', '--json']), { symbol: 'MNQ', reasons: 'no candidates', json: true });
  assert.throws(() => parseArgv(['--now', 'x']), /unknown argument: --now/);
});

test('reason_check: the MCP tool and the CLI give the operation\'s text', async () => {
  const h = home({ attempt: true });
  const reasons = 'CYCLE RESULT: no-trade - no prop attempt running';
  const want = check({ symbol: 'MNQ', reasons }, ctx(h)).text;
  const viaTool = await callTool('reason_check', { symbol: 'MNQ', reasons }, { env: env(h), root: ROOT });
  assert.strictEqual(viaTool.isError, undefined);
  assert.strictEqual(viaTool.content[0].text, want);
  const refused = await callTool('reason_check', { symbol: 'MNQ' }, { env: env(h), root: ROOT });
  assert.strictEqual(refused.isError, true);
  const cli = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'reason-check.js'), '--symbol', 'MNQ', '--reasons', reasons], { env: { ...process.env, ...env(h) }, encoding: 'utf8' });
  assert.strictEqual(cli, want);
});

test('reason_check: the runner\'s bar-less skip (no attempt) is the verdict the model was shown: kept, its component traded through it', () => {
  const h = home();
  // prop/live-runner.js screen with no attempt: no bar, expiresAt = at, contract null.
  const skip = at => ({ at, strategy: 'prop_portfolio', component: 'keltner', symbol: 'MNQ', contractId: 'MNQ:2026-06', direction: 'short', action: 'skip', maxSize: 0, contract: null, reason: 'no topstep_100k attempt', expiresAt: at });
  prop.appendVerdict(h, skip('2026-06-10T13:57:04.000Z'));
  const t = check({ symbol: 'MNQ', reasons: 'CYCLE RESULT: no-trade - prop_portfolio verdict is skip (no topstep_100k attempt); keltner short skipped by the policy' }, ctx(h)).text;
  assert.match(t, /- TRUE verdict-skip: "prop_portfolio verdict is skip" - verdict: prop_portfolio short skip \(no topstep_100k attempt\)\n/);
  assert.match(t, /- TRUE no-attempt: "no topstep_100k attempt" - no topstep_100k attempt is running\n/);
  assert.doesNotMatch(t, /- (?:FALSE|UNPARSED|UNCHECKED) /, "the skipped component clause is the same true claim, counted once");
  assert.match(t, /- keltner short: 1 hard stops no-trade \(traded through prop_portfolio \(its verdict decides\)\)/);
  assert.match(t, /- prop_portfolio short: 1 hard stops no-trade \(the verdict is skip \(no topstep_100k attempt\)\)/);
  // One written in another bar's close window is not this bar's.
  const h2 = home();
  prop.appendVerdict(h2, skip('2026-06-10T13:54:04.000Z'));
  const t2 = check({ symbol: 'MNQ', reasons: 'no-trade - prop_portfolio verdict is skip' }, ctx(h2)).text;
  assert.match(t2, /- UNCHECKED verdict-skip: "prop_portfolio verdict is skip" - no verdict on the bar in these facts\n/, 'none found: unchecked, never false');
  assert.match(t2, /- keltner short: 1 hard stops pass/);
  // A named account that is running: false; another account named while one runs: checked against the started ones.
  const h3 = home({ attempt: true });
  assert.match(check({ symbol: 'MNQ', reasons: 'no-trade - no topstep_50k attempt' }, ctx(h3)).text, /- FALSE no-attempt: "no topstep_50k attempt" - the topstep_50k attempt is active\n/);
  assert.match(check({ symbol: 'MNQ', reasons: 'no-trade - no topstep_100k attempt' }, ctx(h3)).text, /- TRUE no-attempt: "no topstep_100k attempt" - no topstep_100k attempt is running\n/);
});

test('reason_check: a FACTS line (risk-manager phase 2) is checked as the order gate checks it; the free-text reasons apart', () => {
  const h = home();
  const t = check({ symbol: 'MNQ', reasons: 'VERDICT: APPROVE - size 1, keltner short\nFACTS: window opening drive; entries allowed; trend long allowed; read short mixed; room short enough; moon full' }, ctx(h)).text;
  assert.match(t, /^Reasons checked against this bar's facts:\n/);
  assert.doesNotMatch(t.split('FACTS checked')[0], /trend long allowed/, 'the FACTS line is not read as free text');
  assert.match(t, /FACTS checked against the bar briefing:\n- TRUE window: "window opening drive" - the window is opening drive\n- TRUE entries: "entries allowed"/);
  assert.match(t, /- FALSE trend: "trend long allowed" - Trend rule: prevailing trend 1h down; trend strategies may not go long/);
  assert.match(t, /- TRUE read: "read short mixed"/);
  assert.match(t, /- FALSE room: "room short enough" - keltner: VWAP \(rth\) at 0\.4R, it needs 1\.5R\n/);
  assert.match(t, /- UNCHECKED unknown: "moon full"/);
  assert.match(t, /2 FACTS FALSE: name each, drop them and decide again from the briefing; the order gate refuses an entry approved on a false fact\.\n$/);
  const json = JSON.parse(check({ symbol: 'MNQ', reasons: 'VERDICT: APPROVE - size 1\nFACTS: entries allowed', json: true }, ctx(h)).text);
  assert.deepStrictEqual([json.factsLine.status, json.factsLine.claims.length], ['confirmed', 1]);
  // No FACTS line: the output is as before; no briefing: the facts can't be checked, and it says what the gate does.
  assert.doesNotMatch(check({ symbol: 'MNQ', reasons: 'VERDICT: APPROVE - size 1' }, ctx(h)).text, /FACTS/);
  assert.match(check({ symbol: 'MES', reasons: 'VERDICT: APPROVE\nFACTS: entries allowed' }, ctx(h)).text, /^No current bar briefing for MES[^]*- UNCHECKED entries: "entries allowed" - no current bar briefing for MES\nThese facts can't be checked: the order gate refuses/);
});

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
  assert.match(run('CYCLE RESULT: no-trade - no candidate strategies'), /- FALSE nothing-fired: "no candidate strategies" - fired: keltner short, prop_portfolio short \(verdict full 2\)\n/);
  const window = run('CYCLE RESULT: no-trade - opening print window until 10:00 ET');
  assert.match(window, /- FALSE no-entry-window: "opening print window until 10:00 ET" - the opening drive window allows entries \(09:57 ET\)\n/);
  assert.match(window, /1 reason FALSE: name it, drop it, and make the decision again from the facts\.\n$/);
  // Only this bar's verdict, of this family.
  const json = JSON.parse(check({ symbol: 'MNQ', reasons: 'no-trade - no candidates', json: true }, ctx(h)).text);
  assert.deepStrictEqual(json.steps.map(s => `${s.setup} ${s.direction}`), ['keltner short', 'prop_portfolio short']);
  assert.strictEqual(json.falseCount, 1);
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

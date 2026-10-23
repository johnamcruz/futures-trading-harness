'use strict';

// Golden regression: the runner's desk as each role's run receives it (runner-wiring.js deskFor, the role runner
// injected): every desk role's request text, and what the desk's acceptance checks say of a run that read nothing and
// of one that read data, for a one-symbol fixture cycle with and without this bar's briefing, on both harnesses that run
// a role on their own. Captured from main before the desk's machine-local delivery keys (cycleDataInPrompt for the desk,
// deskBriefReports) existed: with them absent, every one of these stays byte for byte what it was.
// Goldens: tests/fixtures/golden/ (tests/golden.js says how to update them on purpose).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertGolden } = require('../golden');
const { deskFor } = require('../../scripts/lib/runner-wiring');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { CHECKS } = require('../../scripts/lib/orchestrate/checks');
const B = require('../../scripts/lib/trading/briefing');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { defaultRoundSteps } = require('../../scripts/lib/trading/round-numbers');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const BARS = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'));
const ROLES = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'];

/** Neutral text: no machine path. */
function neutral(text, home) {
  const real = fs.realpathSync(home);
  return String(text).split(real).join('<home>').split(home).join('<home>').split(ROOT).join('<root>').split(os.homedir()).join('<user-home>');
}

/** One desk run: each role's request as its run receives it (the first attempt), and the checks' word on two runs. */
async function desk(label, over, { briefing }) {
  const home = tmpDir();
  const b = briefing ? B.buildBriefing({ symbol: 'NQ', bars: BARS.slice(0, 1300), minutes: 3, roundSteps: defaultRoundSteps() }) : null;
  if (b) B.writeBriefing(home, b);
  const now = b ? new Date(b.closedAt) : new Date('2026-10-07T14:30:05Z');
  const bar = b ? b.asOf : '2026-10-07T14:27:00.000Z';
  const cfg = validateConfig({ harness: 'claude', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'], ...over });
  const seen = new Map();
  const runRole = async (role, request) => {
    if (!seen.has(role)) seen.set(role, request);
    return { ok: true, text: role === 'risk-manager' ? '## Risk state: account 7' : 'Data: bar_briefing m3@x\nBias: long', tools: [] };
  };
  const bars = path.join(home, 'bars', 'MNQ-3m.json');
  const context = { action: 'trade', manageOnly: false, cachedRoles: [], symbols: [{ symbol: 'MNQ', bar: { t: bar, contractId: 'MNQ', file: bars } }] };
  const env = { FTH_HOME: home, HOME: home };
  await deskFor({ home, cfg, root: ROOT, runRole, env }).run({ symbols: [{ symbol: 'MNQ', bar, contractId: 'MNQ' }], roles: ROLES, now, at: now.toISOString(), bars, context });
  const out = [`=== ${label} (${briefing ? 'this bar\'s briefing' : 'no briefing'}) ===`];
  for (const role of ROLES) {
    const req = neutral(seen.get(role), home);
    out.push(`--- ${role} request (sha256 ${crypto.createHash('sha256').update(req).digest('hex')}, ${req.length} chars, of its neutral text):`, req);
  }
  for (const role of ROLES) {
    const none = CHECKS['read-data'](role, { text: 'x', tools: [] }, {});
    const read = CHECKS['read-data'](role, { text: 'x', tools: role === 'risk-manager' ? ['broker_get_account_snapshot'] : ['harness_bar_briefing'] }, {});
    out.push(`read-data ${role}: no tools -> ${JSON.stringify(none)}; its read -> ${JSON.stringify(read)}`);
  }
  return out.join('\n');
}

test('the desk\'s requests and its read-data check, as each role\'s run receives them, are pinned (the desk delivery keys absent)', async () => {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('FTH_')));
  for (const k of Object.keys(saved)) delete process.env[k];
  const parts = [];
  try {
    for (const [label, over] of [['claude', {}], ['opencode', { harness: 'opencode' }]]) {
      for (const briefing of [false, true]) parts.push(await desk(label, over, { briefing }));
    }
  } finally {
    Object.assign(process.env, saved);
  }
  const text = parts.join('\n');
  assert.ok(!text.includes(os.homedir()), 'no machine path');
  assertGolden('desk-requests.txt', text);
});

'use strict';

// Golden regression: every role run the runner makes on its own (cycle-run.js runRole: the desk's analysts and
// risk-manager phase 1, risk-manager phase 2 and the trade-executor of the entry), as its harness run receives it: the
// request (the workflow's, orchestrate/requests.js), the argv and the environment, on every harness that runs a role on
// its own (Claude Code and opencode). Captured from the base before the machine-local roleSkillsInPrompt key existed:
// with that key absent, every one of these stays byte for byte what it was.
// Goldens: tests/fixtures/golden/ (tests/golden.js says how to update them on purpose).

const test = require('node:test');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertGolden } = require('../golden');
const { runRole } = require('../../scripts/lib/cycle-run');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { REQUESTS } = require('../../scripts/lib/orchestrate/requests');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const BAR = '2026-10-07T14:27:00.000Z';
const AT = '2026-10-07T14:30:05.000Z';
const CTX = { symbol: 'MNQ', contractId: 'MNQ', at: AT, timeframe: 3, bars: '/bars/MNQ-3m.json', lookups: {} };
const CYCLE = { action: 'trade', symbols: [{ symbol: 'MNQ', bar: { t: BAR, contractId: 'MNQ', file: '/bars/MNQ-3m.json' } }], cachedRoles: [], cycleAt: AT };
const ENTRY = { ...CYCLE, entry: false, rolesFile: '/roles/r.json', cycleId: '0123456789abcdef', runnerRoles: ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'] };
const ARGS = { accountId: 7, contractId: 'MNQ', side: 0, size: 1, type: 1, limitPrice: 27420.25, rationale: 'setup:trade_lifecycle long' };

/** Each run the runner makes: its role, request and context (runner-wiring.js deskFor, runner-entry.js runEntry). */
const RUNS = [
  ...['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'].map(role => [`desk ${role}`, role, REQUESTS.desk(role, CTX), CYCLE]),
  ['entry risk-manager phase 2', 'risk-manager', REQUESTS.review('risk-manager', { ...CTX, strategy: 'trade_lifecycle', side: 'long', accountId: 7, record: 'record r1: long 27420.25', reports: [{ role: 'risk-manager', text: 'Phase 1: flat' }] }), ENTRY],
  ['entry trade-executor', 'trade-executor', REQUESTS.execute('trade-executor', { ...CTX, args: ARGS, verdict: 'VERDICT: APPROVE' }), ENTRY],
];

const HARNESSES = [['claude', { harness: 'claude' }], ['opencode', { harness: 'opencode' }]];

/** Neutral text: no machine path, no random file name. */
function neutral(text, home) {
  const real = fs.realpathSync(home);
  return String(text).split(real).join('<home>').split(home).join('<home>').split(ROOT).join('<root>').split(require('url').pathToFileURL(ROOT).pathname).join('<root>').split(os.homedir()).join('<user-home>')
    .replace(/cycle-transcript-\d+-[0-9a-f]{12}\.jsonl/g, 'cycle-transcript-<pid>-<rand>.jsonl');
}
/** A long value (opencode's config, Claude Code's tool lists) as its neutral text's size and hash. */
const shown = (v, home) => {
  const t = neutral(v, home);
  return t.length > 400 ? `<${t.length} chars, sha256 ${crypto.createHash('sha256').update(t).digest('hex')}>` : t;
};

async function roleRun(label, over, [name, role, request, context]) {
  const home = tmpDir();
  const cfg = validateConfig({ premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'], dataDir: path.join(home, 'bars'), ...over });
  // Every FTH_* variable of this machine out while the run is built (the prompt and the role-skills mode read them).
  const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('FTH_')));
  for (const k of Object.keys(saved)) delete process.env[k];
  process.env.FTH_HOME = home;
  try {
    const seen = [];
    const run = async (argv, o) => { seen.push({ argv, env: o.env }); return { ok: true, timedOut: false, code: 0, output: '', stdout: '' }; };
    await runRole(cfg, role, request, { timeoutMs: 600000, context }, { root: ROOT, home, env: { FTH_HOME: home, HOME: home }, run });
    const { argv, env } = seen[0];
    return [
      `=== ${label}: ${name} ===`,
      `request: ${neutral(request, home)}`,
      `argv: ${JSON.stringify(argv.map(a => (a === request ? '<request>' : shown(a, home))))}`,
      'env:', ...Object.keys(env).sort().map(k => `  ${k}=${shown(env[k], home)}`),
      `home files: ${JSON.stringify(fs.readdirSync(home).sort())}`,
    ].join('\n');
  } finally {
    delete process.env.FTH_HOME;
    Object.assign(process.env, saved);
  }
}

test('every role run the runner makes, as its harness run receives it, is pinned for each harness (roleSkillsInPrompt absent)', async () => {
  const parts = [];
  for (const [label, over] of HARNESSES) for (const r of RUNS) parts.push(await roleRun(label, over, r));
  assertGolden('role-runs.txt', `${parts.join('\n')}\n`);
});

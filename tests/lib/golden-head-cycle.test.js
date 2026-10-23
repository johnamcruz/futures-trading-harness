'use strict';

// Golden regression: the head trader's cycle as the harness run receives it, through the runner's cycle glue
// (cycle-run.js runCycle, the harness run injected): the prompt, the argv, the environment, the cycle log's prompt and
// context, and the Claude head prompt file's hash, for a trade, a managed, an entry and a multi-lane cycle, on every
// harness, with Claude Code's head trader in both of its modes. Captured from main before the machine-local cycle data
// key (cycleDataInPrompt) existed: with that key absent, every one of these stays byte for byte what it was.
// Goldens: tests/fixtures/golden/ (tests/golden.js says how to update them on purpose).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertGolden } = require('../golden');
const { runCycle } = require('../../scripts/lib/cycle-run');
const { validateConfig, prompts } = require('../../scripts/lib/autotrader');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const NOW = new Date('2026-10-07T14:30:05Z');
const BAR = '2026-10-07T14:27:00.000Z';
const BAR1 = '2026-10-07T14:29:00.000Z';

const item = (over = {}) => ({
  symbol: 'MNQ', scan: [], verdicts: [], notEntries: [],
  bar: { t: BAR, c: 27420.25, file: '/bars/MNQ-3m.json', contractId: 'MNQ', trend: '4h range, 1h up, 15m up: longs with the trend.', day: 'Today: open 27412.5', recent: [] },
  ...over,
});
const ACCOUNT = { id: '7', at: NOW.toISOString(), balance: 50000, positions: [], orders: [], workingOrders: 0 };
const CACHED = {
  roles: ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'],
  reports: [
    { role: 'market-structure-analyst', text: 'Data: bar_briefing m3@x\nBias: long', at: NOW.toISOString(), until: null, source: 'desk' },
    { role: 'trend-momentum-analyst', text: 'Data: bar_briefing m3@x\nBias: long', at: NOW.toISOString(), until: null, source: 'desk' },
    { role: 'volume-liquidity-analyst', text: 'Data: bar_briefing m3@x\nBias: neutral', at: NOW.toISOString(), until: null, source: 'desk' },
    { role: 'risk-manager', text: 'Phase 1: flat, budget 2 trades', at: NOW.toISOString(), until: null, source: 'desk' },
  ],
};

/** The four cycles: the prompt options and the context the runner hands the run (runner.js). */
const CASES = [
  ['trade', { items: [item()], opts: { state: ACCOUNT }, context: { action: 'trade', symbols: [{ symbol: 'MNQ', bar: { t: BAR, contractId: 'MNQ', file: '/bars/MNQ-3m.json' } }], cachedRoles: [] } }],
  ['managed', {
    items: [item()],
    opts: { state: { ...ACCOUNT, positions: [{ contractId: 'MNQ', type: 1, size: 1, averagePrice: 27410 }], workingOrders: 1 }, managedDesk: true, managedCycle: true, cached: CACHED },
    context: { action: 'trade', manage: true, symbols: [{ symbol: 'MNQ', bar: { t: BAR, contractId: 'MNQ', file: '/bars/MNQ-3m.json' } }], cachedRoles: [], runnerRoles: CACHED.roles, rolesFile: '/roles/r.json' },
  }],
  ['entry', {
    items: [item()], opts: { state: ACCOUNT, entry: true, cached: CACHED },
    context: { action: 'trade', entry: true, symbols: [{ symbol: 'MNQ', bar: { t: BAR, contractId: 'MNQ', file: '/bars/MNQ-3m.json' } }], cachedRoles: [], runnerRoles: CACHED.roles, rolesFile: '/roles/r.json' },
  }],
  ['multi-lane', {
    items: [item({ minutes: 3, repeat: false }), item({ minutes: 1, repeat: true, bar: { t: BAR1, c: 27421, file: '/bars/MNQ-1m.json', contractId: 'MNQ', recent: [] } })],
    opts: { state: ACCOUNT, lanes: ' Lanes closed this cycle: 3m (every bar), 1m (every bar); one cycle covers them all (decide once for every lane\'s setups).' },
    context: { action: 'trade', lanes: ['3m', '1m'], cycleBars: { MNQ: BAR }, symbols: [{ symbol: 'MNQ', lane: '3m', bar: { t: BAR, contractId: 'MNQ', file: '/bars/MNQ-3m.json' } }, { symbol: 'MNQ', lane: '1m', bar: { t: BAR1, contractId: 'MNQ', file: '/bars/MNQ-1m.json' } }], cachedRoles: [] },
  }],
];

const HARNESSES = [
  ['claude', {}], ['claude headSkillsInPrompt', { harness: 'claude', headSkillsInPrompt: true }],
  ['opencode', { harness: 'opencode' }], ['codex', { harness: 'codex' }], ['qwen', { harness: 'qwen' }],
];

/** Neutral text: no machine path, no random file name, no per-run cycle id. */
function neutral(text, home) {
  const real = fs.realpathSync(home);
  return String(text).split(real).join('<home>').split(home).join('<home>').split(ROOT).join('<root>').split(require('url').pathToFileURL(ROOT).pathname).join('<root>').split(os.homedir()).join('<user-home>')
    .replace(/cycle-transcript-\d+-[0-9a-f]{12}\.jsonl/g, 'cycle-transcript-<pid>-<rand>.jsonl')
    .replace(/"cycle":"[0-9a-f]{16}"/g, '"cycle":"<cycle>"');
}

/** One cycle through runCycle, the harness run recorded: its argv and env, the cycle log's line, the head file. */
async function cycle(label, over, kase) {
  const home = tmpDir();
  const cfg = validateConfig({ harness: 'claude', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'], dataDir: path.join(home, 'bars'), ...over });
  // The prompt reads the harness home and this machine's harness settings from the process (stableHead, the role-skills
  // mode): every FTH_* variable but the run's own home is taken out while the cycle is built, so none of this machine's
  // settings reaches the golden.
  const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('FTH_')));
  for (const k of Object.keys(saved)) delete process.env[k];
  process.env.FTH_HOME = home;
  try {
    const prompt = prompts(cfg, NOW, ROOT).trade(kase.items, kase.opts);
    const seen = [];
    const run = async (argv, o) => { seen.push({ argv, env: o.env }); return { ok: true, timedOut: false, code: 0, output: 'CYCLE RESULT: no-trade - golden\n', stdout: 'CYCLE RESULT: no-trade - golden\n' }; };
    const deps = { root: ROOT, home, env: { FTH_HOME: home, HOME: home }, run, out: () => {}, err: () => {}, now: () => NOW, wallNow: () => NOW.getTime(), guard: () => true };
    await runCycle(cfg, 'trade', prompt, {}, { timeoutMs: 600000, context: kase.context }, deps);
    const { argv, env } = seen[0];
    const summary = JSON.parse(fs.readFileSync(path.join(home, 'logs', 'cycles-2026-10-07.jsonl'), 'utf8').trim());
    const line = JSON.parse(fs.readFileSync(summary.file, 'utf8'));
    const at = argv.indexOf('--append-system-prompt-file');
    const headSha = at > 0 ? crypto.createHash('sha256').update(fs.readFileSync(argv[at + 1])).digest('hex') : 'none';
    const envText = Object.keys(env).sort().map(k => `  ${k}=${env[k]}`).join('\n');
    const out = [
      `=== ${label}: ${kase.label} ===`,
      // The hash and size of the prompt as shown below (every machine path masked), never of the raw text: the
      // checkout's and the home's paths differ by machine, the prompt otherwise byte for byte.
      `prompt (sha256 ${crypto.createHash('sha256').update(neutral(prompt, home)).digest('hex')}, ${neutral(prompt, home).length} chars, of its neutral text):`,
      `  ${prompt.split('. ').join('.\n  ')}`,
      `the run's prompt is the runner's: ${argv.includes(prompt)}`,
      `the cycle log's prompt is the runner's: ${line.prompt === prompt}`,
      `argv: ${JSON.stringify(argv.map(a => (a === prompt ? '<prompt>' : a)))}`,
      `head file sha256: ${headSha}`,
      'env:', envText,
      `the cycle log's argv is the run's: ${JSON.stringify(line.argv) === JSON.stringify(argv.map(a => (a === prompt ? '<prompt>' : a)))}`,
      `cycle log: promptChars ${summary.promptChars === prompt.length}; context ${JSON.stringify(line.context)}`,
    ];
    return neutral(out.join('\n'), home);
  } finally {
    delete process.env.FTH_HOME;
    Object.assign(process.env, saved);
  }
}

test('the head trader\'s cycle, as its harness run receives it, is pinned for every harness and kind of cycle (the cycle data key absent)', async () => {
  const parts = [];
  for (const [label, over] of HARNESSES) {
    for (const [name, kase] of CASES) parts.push(await cycle(label, over, { ...kase, label: name }));
  }
  const text = parts.join('\n');
  assert.doesNotMatch(text, /cycle-transcript-\d+-[0-9a-f]{12}/, 'no random name');
  assertGolden('head-cycle.txt', text);
});

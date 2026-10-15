'use strict';

// Setup-focused practice end to end on the parity fixture bars: the live runner as a replay runs it (runner-wiring.js
// wireRunner, one fresh pass per decision point under FTH_REPLAY_NOW, the state saved between passes) over a full
// RTH session, once as live (every bar) and once setup-focused. The practice run runs far fewer cycles; every bar is
// still polled, briefed, scanned and recorded, so what the order gate reads at each bar (the signal record, the
// multi-timeframe record, the bar briefing) is the same in both; a held position is managed every bar; and the risk
// work on a flat contract (a leftover stop cancelled) happens on a bar that ran no cycle.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../fixtures/golden-bars');
const { FAKE_BROKERS, tmpDir, FX_GOLDEN } = require('../helpers');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { decisionPoints } = require('../../scripts/lib/replay/schedule');
const { wireRunner, closedBarsOnly } = require('../../scripts/lib/runner-wiring');
const { readBriefing } = require('../../scripts/lib/trading/briefing');
const { readSignals } = require('../../scripts/lib/trading/signal-state');
const { readRecord } = require('../../scripts/lib/trading/mtf-state');

const MNQ = G.served(G.load(G.SERIES[0]));
// The fixture's whole RTH session of Friday 2026-04-24 (09:30-15:50 ET).
const START = Date.parse('2026-04-24T13:30:00Z');
const END = Date.parse('2026-04-24T19:50:00Z');
const OPEN = [Date.parse('2026-04-24T15:00:00Z'), Date.parse('2026-04-24T15:31:00Z')]; // a long held 11:00-11:31 ET
const LEFTOVER = Date.parse('2026-04-24T17:20:00Z'); // a stop left behind on a flat contract

async function session({ practice = null } = {}) {
  const home = tmpDir();
  const savedHome = process.env.FTH_HOME;
  process.env.FTH_HOME = home;
  // The run's learning decision (learning/run-gate.js writes it into the run home): a practice-train run.
  fs.writeFileSync(path.join(home, 'learning-run.json'), JSON.stringify({ learning: true, role: 'practice-train', look: null, hideOutcomes: false, ...(practice ? { practice } : {}) }));
  const clockRef = { t: START };
  const now = () => new Date(clockRef.t);
  const env = {
    HOME: home, FTH_HOME: home, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_JOURNAL: path.join(home, 'journal.jsonl'),
    FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'), FTH_ACCOUNTS_DIRS: path.join(home, 'no-accounts'), FTH_STRATEGIES_DIRS: FX_GOLDEN,
  };
  const cfg = validateConfig({ harness: 'opencode', cycle: 'full', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'], dataDir: path.join(home, 'bars'), bars: 700, sessions: ['09:30-15:50@America/New_York'], ...(practice ? { practice } : {}) });
  const cancelled = [];
  const broker = {
    async activeContract(symbol) { return { id: symbol, name: `${symbol}M6`, tickSize: 0.25, tickValue: 0.5 }; },
    async closedBars(contractId, { limit }) { return JSON.parse(JSON.stringify(MNQ.filter(b => Date.parse(b.t) < clockRef.t).slice(-limit))); },
    async accountState() {
      const open = clockRef.t >= OPEN[0] && clockRef.t < OPEN[1];
      const leftover = clockRef.t >= LEFTOVER && !cancelled.length;
      return { positions: open ? [{ contractId: 'MNQ', type: 1, size: 1, averagePrice: 27000 }] : [], orders: [...(open ? [{ id: 7, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice: 26900 }] : []), ...(leftover ? [{ id: 99, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice: 26800 }] : [])] };
    },
    async accountBalance() { return 50000; },
    async netPosition() { return 0; },
    async workingOrders() { return 0; },
    async cancelOrder(_acct, id) { cancelled.push({ id, t: clockRef.t }); },
  };
  const cycles = [];
  const events = [];
  const reads = new Map();
  const runCycle = async (action, _prompt, limits = {}) => {
    const ctx = limits.context || {};
    cycles.push({ at: clockRef.t, action, bar: (ctx.symbols || []).map(x => x.bar.t)[0] || null });
    return { ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - practice e2e', transcript: '' };
  };
  let saved = null;
  try {
    for (const p of decisionPoints(cfg, { start: new Date(START), end: new Date(END) }).filter(x => x.kind === 'trade')) {
      clockRef.t = p.t.getTime();
      const pass = wireRunner({
        cfg, root: G.ROOT, home, env: { ...env, FTH_REPLAY_NOW: p.t.toISOString() }, client: closedBarsOnly(broker, now), dataDir: cfg.dataDir, now, runCycle,
        loadState: () => (saved ? JSON.parse(JSON.stringify(saved)) : null), saveState: x => { saved = JSON.parse(JSON.stringify(x)); },
        killSwitchFile: path.join(home, 'STOP'), log: () => {}, event: e => events.push(e),
      });
      await pass.step();
      // What the order gate reads at this bar.
      const b = readBriefing(home, 'MNQ');
      reads.set(p.t.toISOString(), JSON.stringify({ signals: readSignals(home, 'MNQ', '3m'), mtf: readRecord(home, 'MNQ'), briefing: b && b.sections.m3.data }));
    }
  } finally {
    if (savedHome === undefined) delete process.env.FTH_HOME;
    else process.env.FTH_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
  return { cycles, events, reads, cancelled };
}

test('setup-focused practice on the fixture session: far fewer cycles, the same gate reads every bar, management every bar, risk work between cycles', async () => {
  const full = await session();
  const practice = { mode: 'setup-focus', setupTf: 15, quietSample: 0.15, seed: 1, levels: 'key', reactions: ['rejected'] };
  const focused = await session({ practice });
  const trades = r => r.cycles.filter(c => c.action === 'trade' || c.action === 'manage');
  // Full: one cycle per bar of the session (09:33 .. 15:48 closes).
  assert.ok(trades(full).length >= 120, `full cycles: ${trades(full).length}`);
  assert.ok(trades(focused).length <= trades(full).length * 0.7, `practice cycles ${trades(focused).length} of ${trades(full).length}`);
  // Every bar was judged and said why (the replay report counts these).
  const kinds = focused.events.filter(e => /^practice_/.test(e.kind));
  assert.strictEqual(kinds.length, full.reads.size, 'one practice choice per bar');
  const by = k => kinds.filter(e => e.kind === `practice_${k}`).length;
  assert.ok(by('moment') > 0 && by('quiet') > 0 && by('none') > 0 && by('manage') > 0, JSON.stringify({ moment: by('moment'), quiet: by('quiet'), none: by('none'), manage: by('manage') }));
  assert.strictEqual(trades(focused).length, kinds.filter(e => e.run).length, 'a cycle exactly on each selected bar');
  assert.ok(!full.events.some(e => /^practice_/.test(e.kind)), 'a full-day run judges nothing');
  // The same gate inputs at every bar, cycle or not.
  assert.deepStrictEqual([...focused.reads.keys()], [...full.reads.keys()]);
  for (const [t, r] of full.reads) assert.strictEqual(focused.reads.get(t), r, `gate reads at ${t}`);
  // The held position: every bar while it was open ran its cycle.
  const openBars = [...full.reads.keys()].filter(t => Date.parse(t) >= OPEN[0] && Date.parse(t) < OPEN[1]);
  assert.ok(openBars.length >= 9);
  for (const t of openBars) assert.ok(trades(focused).some(c => c.at === Date.parse(t)), `managed at ${t}`);
  // The leftover stop on the flat contract: cancelled in both runs at the same bar, a bar the practice run skipped.
  assert.deepStrictEqual(focused.cancelled, full.cancelled);
  assert.strictEqual(focused.cancelled.length, 1);
  assert.ok(!trades(focused).some(c => c.at === focused.cancelled[0].t), 'cancelled on a bar that ran no cycle');
});

'use strict';

/**
 * End to end, on real data: the runner polls a fake broker serving the
 * parity NQ bars as they close, writes the bars file and the gate's records
 * (multi-timeframe and signals) with the production functions, scans with the
 * real strategies, and builds the real prompt. A stand-in for the LLM follows
 * the trade-session skill's steps: it reads what fired from the prompt, plans
 * in the journal, sizes the stop from the scan, and sends the order through
 * the real order gate (checkOrder: the hook's and the gateway's check). Then
 * it tries what the gate must refuse: a relabelled setup, a counter-trend
 * trade, and an entry after the signal expired.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createRunner } = require('../../scripts/lib/runner');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { loadStrategies, scan } = require('../../scripts/lib/trading/strategies');
const { writeMtfRecord } = require('../../scripts/lib/trading/mtf-state');
const { buildSignals, writeSignals, readSignals } = require('../../scripts/lib/trading/signal-state');
const { scanRecord, appendJsonl } = require('../../scripts/lib/trading/scan-log');
const { checkOrder } = require('../../scripts/lib/trading/check-order');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { tmpDir, writeJournal } = require('../helpers');
const { digest, recentTrades, formSummary } = require('../../scripts/lib/trading/instincts');
const { readJournal } = require('../../scripts/lib/trading/journal');

const ROOT = path.resolve(__dirname, '..', '..');
const BARS = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv')).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
const STEP = 180000;
const CONTRACT = 'CON.F.US.MNQ.M26';

test('trading e2e: closed bar -> records and prompt -> LLM steps -> the real gate allows the trigger and refuses the rest', async () => {
  const home = tmpDir();
  const dataDir = path.join(home, 'bars');
  const journal = writeJournal(home, []);
  const env = {
    FTH_HOME: home, PROJECTX_JOURNAL_PATH: journal, NODE_ENV: 'test', FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '',
    FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'), FTH_KILL_SWITCH_FILE: path.join(home, 'STOP'), FTH_GATE_LOG: path.join(home, 'gate.jsonl'),
  };
  const strategies3m = loadStrategies(ROOT, {}).strategies.filter(s => s.timeframe === '3m');
  const clockRef = { t: Date.parse('2026-04-28T03:58:30Z') };
  const cycles = [];
  const client = {
    async activeContract() { return { id: CONTRACT, tickSize: 0.25, tickValue: 0.5 }; },
    async closedBars(_id, { limit }) { return BARS.filter(b => Date.parse(b.t) + STEP <= clockRef.t).slice(-limit); },
    async netPosition() { return 0; },
    async workingOrders() { return 0; },
  };

  // The stand-in LLM: the trade-session steps, through the production scripts' functions.
  async function llm(action, prompt) {
    const now = new Date(clockRef.t);
    const file = /are in (\S+) \(get_bars format/.exec(prompt)[1];
    const bars = readBarsArg(file);
    const fired = /MNQ fired on this bar \([^)]*\): ([^.]*)\./.exec(prompt);
    const record = { at: now.toISOString(), prompt, decisions: [] };
    cycles.push(record);
    if (!fired) return { ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - nothing fired' };
    const [name, side] = fired[1].split(' | ')[0].split(' ');
    const r = scan(strategies3m, bars, { symbol: 'MNQ', now }).find(x => x.name === name);
    const last = bars[bars.length - 1];
    const sign = side === 'long' ? 1 : -1;
    const ticks = Math.ceil(r.stopDistance / 0.25);
    const stop = last.c - sign * ticks * 0.25;
    fs.appendFileSync(journal, `${JSON.stringify({ ts: now.toISOString(), kind: 'plan', contractId: CONTRACT, tags: [`setup:${name}`, 'MNQ'], text: `${name} ${side}` })}\n`);
    const order = (setup, s, extra = {}) => ({
      accountId: 1, contractId: CONTRACT, side: s === 'long' ? 'buy' : 'sell', type: 'market', size: 1,
      stopLossBracket: { ticks, type: 'stop' }, rationale: `setup:${setup} ${s} trigger on the closed bar, stop ${(last.c - (s === 'long' ? 1 : -1) * ticks * 0.25).toFixed(2)}`, ...extra,
    });
    const gate = (o, at = now) => checkOrder(o, { env, pluginRoot: ROOT, now: at });
    record.decisions.push({ what: 'the trigger', name, side, stop, ...gate(order(name, side)) });
    record.decisions.push({ what: 'relabelled as a reversal', ...gate(order('cisd_ote', side)) });
    record.decisions.push({ what: 'counter-trend', ...gate(order(name, side === 'long' ? 'short' : 'long')) });
    record.decisions.push({ what: 'after the signal expired', ...gate(order(name, side), new Date(clockRef.t + 15 * 60000)) });
    // The trade closes at a loss and the reviewer writes it up (trade-review skill tags).
    fs.appendFileSync(journal, `${JSON.stringify({ ts: now.toISOString(), kind: 'review', contractId: CONTRACT, text: `${name} ${side} stopped out, R = -1.05`, tags: ['result:loss', `setup:${name}`, 'MNQ', 'regime:trend-up', 'r:-1.05', 'mistake:chased'] })}\n`);
    return { ok: true, timedOut: false, result: `CYCLE RESULT: executed - ${name} ${side}` };
  }

  const runner = createRunner({
    cfg: validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', symbols: ['MNQ'], timeframe: 3, barDelaySeconds: 0 }),
    root: ROOT, client, clock: { now: () => new Date(clockRef.t) },
    runCycle: async (action, prompt) => { const r = await llm(action, prompt); clockRef.t += 20000; return r; },
    isKillSwitchOn: () => false, createKillSwitch: () => {}, loadState: () => null, saveState: () => {},
    writeBars: (sym, bars) => {
      const file = path.join(dataDir, `${sym.symbol}-3m.json`);
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ contractId: sym.contractId, bars }));
      return file;
    },
    recordMtf: (sym, bars) => writeMtfRecord(home, sym.symbol, bars).line,
    recordSignals: (item, results) => writeSignals(home, buildSignals(results, { symbol: item.symbol, bar: item.bar, stepMs: STEP })),
    scanFor: (symbol, bars) => scan(strategies3m, { bars }, { symbol, now: new Date(clockRef.t) }),
    scanLog: rec => appendJsonl(path.join(home, 'logs', 'scans.jsonl'), scanRecord(rec)),
    // As scripts/autotrader.js wires them: one journal read per prompt, each fact once.
    journalEntries: () => readJournal(journal),
    lessons: ({ entries }) => digest(entries, 5, { kinds: ['mistake', 'lesson'], form: false }),
    recentTrades: ({ entries }) => recentTrades(entries, 10),
    tradesSummary: ({ entries }) => formSummary(entries, 10),
  });
  for (let guard = 0; clockRef.t < Date.parse('2026-04-28T04:15:30Z') && guard < 5000; guard += 1) {
    const ms = await runner.step();
    clockRef.t += Math.max(ms, 1000);
  }

  // Every closed bar got a cycle with the full context.
  assert.ok(cycles.length >= 5, `cycles: ${cycles.length}`);
  for (const c of cycles) {
    assert.match(c.prompt, /MNQ last 10 closed 3m bars \(ET open time, oldest first\)/);
    assert.match(c.prompt, /MNQ Trend rule: prevailing trend/);
    assert.match(c.prompt, /Load the skills trade-session, multi-timeframe-analysis, and strategy-library/);
  }
  assert.ok(cycles.some(c => /Your last \d cycle\(s\)/.test(c.prompt)), 'later cycles see the earlier results');
  // The 04:09 bar fired bos and ema_cross long (with each other): the trade, and the refusals.
  const traded = cycles.find(c => c.decisions.length);
  assert.ok(traded, 'a strategy fired on one of the bars');
  assert.match(traded.prompt, /MNQ fired on this bar .*bos long with ema_cross/);
  const d = Object.fromEntries(traded.decisions.map(x => [x.what, x]));
  assert.strictEqual(d['the trigger'].allowed, true, d['the trigger'].message);
  assert.deepStrictEqual(d['relabelled as a reversal'].violations.map(v => v.check), ['trigger-fired']);
  assert.ok(d['counter-trend'].violations.some(v => v.check === 'mtf-trend'), JSON.stringify(d['counter-trend'].violations));
  assert.ok(d['after the signal expired'].violations.some(v => v.check === 'trigger-fired' && /expired/.test(v.message)));
  // The loop closes: the review of that trade is in every later prompt, with the form of the last trades.
  const after = cycles.filter(c => Date.parse(c.at) > Date.parse(traded.at));
  assert.ok(after.length >= 1, 'a cycle after the trade');
  for (const c of after) {
    assert.match(c.prompt, /Your last 1 reviewed trade\(s\) \(0W\/1L, E -1\.05R\), oldest first: bos long loss -1\.05R in trend-up \[mistake:chased\]/);
    assert.match(c.prompt, /Your recurring mistakes and lessons \(confidence; notes from your own past, not rules\): \(0\.\d\) mistake:chased in 1 of the last 1 reviewed trades/);
    assert.doesNotMatch(c.prompt, /\(form\)/, 'the record is on the reviewed-trades line, not repeated');
  }
  // The records and logs the gate and the reviews read.
  assert.ok(fs.existsSync(path.join(home, 'mtf', 'MNQ.json')));
  assert.ok(Array.isArray(readSignals(home, 'MNQ', '3m').candidates), 'the signal record of the last closed bar');
  const scans = fs.readFileSync(path.join(home, 'logs', 'scans.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(scans.some(s => s.candidates.includes('bos') && s.results.find(r => r.name === 'bos').confluence.with.includes('ema_cross')));
});

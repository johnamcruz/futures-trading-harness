'use strict';

// The gamma line (trading/gamma-line.js): the one line the code computes from the user's local gamma dir, printed in the
// cycle prompt next to the news line, and the only thing the gex-regime skill reads. Synthetic files only. Pinned here:
// the word (and its cutoff, a tunable), every case that prints NO line, the exact line text (it ends with the pointer to
// the skill), the contract root and the tick, the cycle date (the replay clock's in a replay), the staleness bound, the
// situational skill the gate requires only when the briefing carries the flag (a boolean, never the word), the flag and
// the flag and the line agreeing (two reads of one file), and that no gate, risk, sizing, entry or exit code reads the source or the flag.
// Each wiring test below was proved against a mutant of the code it covers (the fix round's report lists them).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir, FX_GOLDEN, entryOrder, plan } = require('../helpers');
const G = require('../../scripts/lib/trading/gamma-line');
const T = require('../../scripts/lib/tunables');
const B = require('../../scripts/lib/trading/briefing');
const { validateConfig, prompts } = require('../../scripts/lib/autotrader');
const { SITUATIONAL, situationalSkills, parseTrigger, fires } = require('../../scripts/lib/trading/skills-loaded');
const { wireRunner } = require('../../scripts/lib/runner-wiring');
const { evaluateOrder } = require('../../scripts/lib/trading/order-gate');
const { loadConfig } = require('../../scripts/lib/trading/config');

const ROOT = path.resolve(__dirname, '..', '..');
const NOW = new Date('2026-03-04T15:03:00Z'); // 10:03 ET, Wednesday 2026-03-04 (EST)
const INST = { net: -3100, gross: 10000, flip: 21650.1, callWall: 21900, putWall: 21200 };
const doc = (over = {}) => ({ day: '2026-03-04', asOf: '2026-03-03', instruments: { NQ: INST, ES: { net: 500, gross: 10000, flip: 6000, callWall: 6100, putWall: 5900 } }, ...over });
function dirWith(d, name = '2026-03-04') {
  const dir = tmpDir();
  if (d !== undefined) fs.writeFileSync(path.join(dir, `${name}.json`), typeof d === 'string' ? d : JSON.stringify(d));
  return dir;
}
const lineOf = (d, symbol = 'MNQ', now = NOW) => G.gammaFor({ dir: dirWith(d), symbol, now });
const HAS = /Gamma \(code/;

test('gamma line: the exact line, as the gex-regime skill reads it (levels to the tick, net/gross to 2 decimals, the pointer last)', () => {
  const r = lineOf(doc());
  assert.strictEqual(r.word, 'negative');
  assert.strictEqual(r.line, 'Gamma (code, as of prior close 2026-03-03): negative (soft); net/gross 0.31; flip 21650; call wall 21900; put wall 21200. Read gex-regime before an entry.');
  assert.ok(!r.line.includes('\n'));
  assert.ok(r.line.endsWith(G.POINTER));
});

test('gamma line: the word comes from the sign and the cutoff (config/analysis.json gammaLine.unclearBelow)', () => {
  const cut = T.analysis().gammaLine.unclearBelow;
  assert.strictEqual(cut, 0.125);
  assert.deepStrictEqual(G.wordFor({ ...INST, net: -1250 }, cut), { word: 'negative', ratio: 0.125 }, 'at the cutoff: a sign');
  assert.strictEqual(G.wordFor({ ...INST, net: 1250 }, cut).word, 'positive');
  assert.strictEqual(G.wordFor({ ...INST, net: -1249 }, cut).word, 'unclear');
  assert.strictEqual(G.wordFor({ ...INST, net: 1249 }, cut).word, 'unclear');
  assert.strictEqual(G.wordFor({ ...INST, net: 0 }, cut).word, 'unclear');
  assert.strictEqual(G.wordFor({ ...INST, net: -1249 }, 0.1).word, 'negative', 'the cutoff is the argument, not a literal');
  assert.strictEqual(G.wordFor({ ...INST, net: -1249 }).word, 'unclear', 'from the committed config when none is given');
  assert.match(lineOf(doc({ instruments: { NQ: { ...INST, net: 300 } } })).line, /: unclear; net\/gross 0\.03;/);
  assert.match(lineOf(doc({ instruments: { NQ: { ...INST, net: 4000 } } })).line, /: positive \(soft\); net\/gross 0\.40;/);
});

test('gamma line: anything missing or off prints NO line (never "unknown")', () => {
  const bad = x => ({ instruments: { NQ: { ...INST, ...x } } });
  const cases = {
    'a null call wall': bad({ callWall: null }),
    'a missing put wall': bad({ putWall: undefined }),
    'a non-finite net': bad({ net: Infinity }),
    'a NaN net': bad({ net: NaN }),
    'a string number': bad({ gross: '10000' }),
    'a zero gross': bad({ gross: 0 }),
    'a negative gross': bad({ gross: -5 }),
    '|net| above gross (negative)': bad({ net: -10001 }),
    '|net| above gross (positive)': bad({ net: 10001 }),
    'a zero call wall': bad({ callWall: 0 }),
    'a negative put wall': bad({ putWall: -1 }),
    'a zero flip': bad({ flip: 0 }),
    'a negative flip': bad({ flip: -3 }),
    'a string flip': bad({ flip: '21650' }),
    'no instrument': { instruments: {} },
    'instruments not an object': { instruments: [] },
    'another day\'s file content': { day: '2026-03-03' },
    'no day': { day: undefined },
    'asOf the same day (look-ahead)': { asOf: '2026-03-04' },
    'asOf after the day (look-ahead)': { asOf: '2026-03-05' },
    'asOf missing': { asOf: undefined },
    'asOf not a date': { asOf: '2026-02-30' },
    'asOf a timestamp': { asOf: '2026-03-03T21:00:00Z' },
    'asOf stale (6 days)': { asOf: '2026-02-26' },
  };
  for (const [why, over] of Object.entries(cases)) assert.strictEqual(lineOf(doc(over)), null, why);
  assert.ok(lineOf(doc({ instruments: { NQ: { ...INST, net: 10000 } } })), '|net| equal to gross is valid');
  assert.strictEqual(G.wordFor({ ...INST, flip: Infinity }), null, 'a non-finite flip (not representable in JSON, so at the function)');
  assert.strictEqual(lineOf('{ not json'), null, 'malformed');
  assert.strictEqual(lineOf('[]'), null, 'an array');
  assert.strictEqual(lineOf('null'), null, 'null');
  assert.strictEqual(lineOf(undefined), null, 'no file for the day');
  assert.strictEqual(G.gammaFor({ dir: path.join(tmpDir(), 'missing'), symbol: 'MNQ', now: NOW }), null, 'a missing dir');
  assert.strictEqual(G.gammaFor({ dir: undefined, symbol: 'MNQ', now: NOW }), null, 'an unset dir');
  assert.strictEqual(G.gammaFor({ dir: '  ', symbol: 'MNQ', now: NOW }), null, 'a blank dir');
  assert.strictEqual(G.gammaFor({ dir: dirWith(doc()), symbol: 'MNQ', now: new Date('x') }), null, 'a bad clock');
  assert.strictEqual(lineOf(doc(), 'MYM'), null, 'a root the file does not list');
  assert.strictEqual(lineOf(doc(), '__proto__'), null);
  const d = dirWith(doc({ day: '2026-03-03' }), '2026-03-04');
  assert.strictEqual(G.gammaFor({ dir: d, symbol: 'MNQ', now: NOW }), null, 'a file named for the day whose content is another day\'s (the name is not trusted)');
});

test('gamma line: a ticker root with no contract spec prints no line, though the file lists it', () => {
  const d = doc({ instruments: { ...doc().instruments, XYZ: { net: -3100, gross: 10000, flip: 10, callWall: 12, putWall: 8 } } });
  assert.strictEqual(lineOf(d, 'XYZ'), null);
  assert.ok(lineOf(d, 'MNQ'), 'a root with a spec still does');
});

test('gamma line: flip is optional (the line says "flip none"); every other level stays required', () => {
  for (const flip of [undefined, null]) {
    const inst = { ...INST, flip };
    if (flip === undefined) delete inst.flip;
    const r = lineOf(doc({ instruments: { NQ: inst } }));
    assert.strictEqual(r.line, 'Gamma (code, as of prior close 2026-03-03): negative (soft); net/gross 0.31; flip none; call wall 21900; put wall 21200. Read gex-regime before an entry.');
  }
  const noCall = { ...INST }; delete noCall.callWall;
  assert.strictEqual(lineOf(doc({ instruments: { NQ: noCall } })), null);
});

test('gamma line: the staleness bound (gammaLine.maxAsOfGapDays): the gap is in days; a long weekend fits; the bound is the tunable', () => {
  const max = T.analysis().gammaLine.maxAsOfGapDays;
  assert.strictEqual(max, 5);
  const at = (day, asOf, extra) => G.gammaFor({ dir: dirWith(doc({ day, asOf }), day), symbol: 'MNQ', now: new Date(`${day}T15:03:00Z`), ...extra });
  assert.ok(at('2026-03-09', '2026-03-06'), 'Monday after a Friday');
  assert.ok(at('2026-03-09', '2026-03-04'), 'exactly the bound (5 days)');
  assert.strictEqual(at('2026-03-09', '2026-03-03'), null, 'one day past it');
  assert.ok(at('2026-03-09', '2026-03-03', { maxGap: 6 }), 'the bound is the argument, not a literal');
  assert.strictEqual(at('2026-03-04', '2026-03-03', { maxGap: 0 }), null, 'a bound of 0 allows no prior day at all');
});

test('gamma line: the cycle symbol\'s mini root (MNQ -> NQ, MES -> ES, a contract name too), the tick, one line per symbol', () => {
  assert.match(lineOf(doc(), 'MES').line, /: unclear; net\/gross 0\.05;/);
  assert.match(lineOf(doc(), 'NQ').line, /flip 21650;/, 'the mini itself');
  assert.match(lineOf(doc(), 'MNQ:2026-03').line, /flip 21650;/);
  assert.match(lineOf(doc({ instruments: { NQ: { ...INST, flip: 21650.13, callWall: 21900.37 } } })).line, /flip 21650\.25; call wall 21900\.25;/, 'to the tick');
  const dir = dirWith(doc());
  assert.strictEqual(G.gammaLines({ dir, symbols: ['MNQ'], now: NOW }), G.gammaFor({ dir, symbol: 'MNQ', now: NOW }).line, 'one symbol: the bare line');
  const both = G.gammaLines({ dir, symbols: ['MNQ', 'MES'], now: NOW });
  assert.match(both, /^MNQ: Gamma \(code[^\n]*put wall 21200\. Read gex-regime before an entry\. MES: Gamma \(code[^\n]*put wall 5900\. Read gex-regime before an entry\.$/);
  assert.match(G.gammaLines({ dir, symbols: ['MNQ', 'MYM'], now: NOW }), /^MNQ: Gamma/, 'a symbol with no source adds nothing');
  assert.strictEqual(G.gammaLines({ dir, symbols: ['MYM'], now: NOW }), null);
});

test('gamma line: the cycle\'s New York date picks the file (a late-evening UTC time is still that ET day)', () => {
  assert.strictEqual(G.etDate(new Date('2026-03-05T03:30:00Z')), '2026-03-04');
  assert.ok(G.gammaFor({ dir: dirWith(doc()), symbol: 'MNQ', now: new Date('2026-03-05T03:30:00Z') }), '22:30 ET on the 4th still reads the 4th');
  assert.strictEqual(G.gammaFor({ dir: dirWith(doc()), symbol: 'MNQ', now: new Date('2026-03-05T15:03:00Z') }), null, 'the next day has no file');
});

test('gamma line: the tunables (config/analysis.json): mistyped ones are refused, a missing one is refused, BUILT_IN carries them', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(T.BUILT_IN.analysis.gammaLine)), { unclearBelow: 0.125, maxAsOfGapDays: 5 });
  const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'analysis.json'), 'utf8'));
  const f = path.join(tmpDir(), 'analysis.json');
  const load = row => { fs.writeFileSync(f, JSON.stringify({ ...committed, gammaLine: row })); return () => T.load('analysis', f); };
  for (const bad of [-0.1, 1.5, 'x', null]) assert.throws(load({ unclearBelow: bad, maxAsOfGapDays: 5 }), /gammaLine\.unclearBelow: a number/);
  for (const bad of [0, -1, 2.5, 'x', null]) assert.throws(load({ unclearBelow: 0.125, maxAsOfGapDays: bad }), /gammaLine\.maxAsOfGapDays: a whole number/);
  assert.throws(load({ maxAsOfGapDays: 5 }), /gammaLine\.unclearBelow: missing/);
  assert.throws(load({ unclearBelow: 0.125 }), /gammaLine\.maxAsOfGapDays: missing/);
});

test('gamma line: the gate requires gex-regime of the head trader only when the briefing carries the flag (true, never the word)', () => {
  assert.deepStrictEqual(SITUATIONAL.find(e => e.skill === 'gex-regime'), { when: 'gamma', skill: 'gex-regime', head: true, headOnly: true, factsOnly: true });
  assert.deepStrictEqual(situationalSkills({ gamma: true }), ['gex-regime']);
  for (const none of [{}, null, undefined, { gamma: null }, { gamma: false }, { gamma: {} }, { gamma: { word: 'negative' } }, { gamma: 'negative' }, { gamma: 1 }]) {
    assert.deepStrictEqual(situationalSkills(none), [], JSON.stringify(none));
  }
  assert.throws(() => parseTrigger('gamma=negative'), /takes no value/);
  assert.strictEqual(fires(parseTrigger('gamma'), { gamma: true }), true);
  // Not in the head prompt's list (the line carries the pointer), so the head prompt is what it was.
  assert.deepStrictEqual(require('../../scripts/lib/head-prompt').headRequired().filter(x => x.skill === 'gex-regime'), []);
});

const bars100 = () => { const G2 = require('../fixtures/golden-bars'); return G2.load(G2.SERIES[0]).slice(1200, 1300); };

test('gamma line: the briefing carries a boolean flag only when the code printed a line, on the runner\'s own briefing only, and the detail never shows it', () => {
  const bars = bars100();
  const now = new Date(Date.parse(bars[bars.length - 1].t) + 180000);
  const build = extra => B.buildBriefing({ symbol: 'MNQ', bars, minutes: 3, now, ...extra });
  const without = build({});
  const withG = build({ gamma: true });
  assert.ok(!('gamma' in without.sections.m3.data), 'no line, no key: the briefing is as before');
  assert.strictEqual(withG.sections.m3.data.gamma, true);
  for (const notTrue of ['negative', 1, {}, { word: 'negative' }, false, null]) assert.ok(!('gamma' in build({ gamma: notTrue }).sections.m3.data), `${JSON.stringify(notTrue)}: only the boolean true is a flag`);
  const rest = { ...withG.sections.m3.data }; delete rest.gamma;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rest)), JSON.parse(JSON.stringify(without.sections.m3.data)), 'nothing else in the briefing differs');
  // A frame's own briefing (own: true) is another timeframe's: never the flag.
  assert.ok(!('gamma' in build({ gamma: true, own: true }).sections.m3.data), 'own: no flag');
  // The detail the roles read leaves it out.
  const text = b => B.renderBriefing(b, { now });
  assert.doesNotMatch(text(withG), /gamma/i);
  assert.strictEqual(text(withG), text(without), 'the rendered briefing is the same with or without the flag');
});

test('gamma line: the prompt differs by exactly the one line, next to the news line, and nothing else', () => {
  const cfg = validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3 });
  const items = [{ symbol: 'MNQ', bar: { t: '2026-03-04T15:00:00.000Z', c: 21700, file: '/b/MNQ.json', contractId: 'MNQ', recent: [] } }];
  const news = 'No news blackout recorded for the rest of today.';
  const line = lineOf(doc()).line;
  const base = prompts(cfg, NOW, ROOT).trade(items, { news });
  const withG = prompts(cfg, NOW, ROOT).trade(items, { news, gamma: line });
  assert.ok(withG.includes(`${news} ${line}`), 'right after the news line');
  assert.strictEqual(withG.replace(` ${line}`, ''), base);
  assert.strictEqual(prompts(cfg, NOW, ROOT).trade(items, { news, gamma: null }), base);
});

/**
 * One runner step on a closed bar, through the real wiring. `symbols`: the config's; `staleSymbols`: those whose bars are
 * old (no bar closed for them this cycle). Returns the cycle's calls ({ action, prompt, limits }) and the home.
 */
async function capture({ env, now, symbols = ['MNQ'], staleSymbols = [] }) {
  const home = tmpDir();
  const step = 180000;
  const t0 = now.getTime();
  const client = {
    async activeContract(symbol) { return { id: symbol, tickSize: 0.25 }; },
    async closedBars(id) {
      const back = staleSymbols.includes(id) ? 6 * 3600000 : 0;
      return [0, 1, 2].map(k => ({ t: new Date(t0 - back - 180000 - (2 - k) * step).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 1 }));
    },
  };
  const seen = [];
  const cfg = validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols, timeframe: 3, premarketAt: '', eodAt: '15:50@America/New_York', trigger: 'bar' });
  const runner = wireRunner({ cfg, root: ROOT, home, env: { FTH_HOME: home, FTH_STRATEGIES_DIRS: FX_GOLDEN, ...env }, client, dataDir: path.join(home, 'bars'), now: () => now,
    runCycle: async (action, prompt, limits) => { seen.push({ action, prompt: prompt.replace(/fth-test-\w+/g, 'fth-test'), limits }); return { ok: true }; },
    loadState: () => null, saveState: () => {}, killSwitchFile: path.join(home, 'STOP'), log: () => {}, event: () => {} });
  await runner.step();
  return { seen: seen.filter(x => x.action === 'trade'), home };
}
const flagOf = (home, symbol = 'MNQ') => { const b = B.readBriefing(home, symbol); return b ? b.sections.m3.data.gamma : undefined; };

test('gamma line: wired into the runner - the dir from FTH_GAMMA_DIR, the cycle\'s date; no dir or a failing source leaves the prompt as before', async () => {
  const dir = dirWith(doc());
  const off = await capture({ env: {}, now: NOW });
  const on = await capture({ env: { FTH_GAMMA_DIR: dir }, now: NOW });
  assert.strictEqual(off.seen.length, 1);
  assert.strictEqual(on.seen.length, 1);
  const line = lineOf(doc()).line;
  assert.ok(on.seen[0].prompt.includes(line));
  assert.strictEqual(on.seen[0].prompt.replace(` ${line}`, ''), off.seen[0].prompt, 'one line more, nothing else');
  assert.ok(!HAS.test(off.seen[0].prompt));
  const other = await capture({ env: { FTH_GAMMA_DIR: dir }, now: new Date('2026-03-05T15:03:00Z') });
  assert.ok(!HAS.test(other.seen[0].prompt), 'another day: no file, no line');
  const ahead = await capture({ env: { FTH_GAMMA_DIR: dirWith(doc({ asOf: '2026-03-04' })) }, now: NOW });
  assert.ok(!HAS.test(ahead.seen[0].prompt), 'a look-ahead file');
  const notDir = await capture({ env: { FTH_GAMMA_DIR: path.join(dir, '2026-03-04.json') }, now: NOW });
  assert.strictEqual(notDir.seen[0].prompt, off.seen[0].prompt);
});

test('gamma line: the cycle log\'s context carries the line when one printed, and no key otherwise', async () => {
  const dir = dirWith(doc());
  const on = await capture({ env: { FTH_GAMMA_DIR: dir }, now: NOW });
  assert.strictEqual(on.seen[0].limits.context.gamma, lineOf(doc()).line);
  const off = await capture({ env: {}, now: NOW });
  assert.ok(!('gamma' in off.seen[0].limits.context));
});

test('gamma line: the line is made for the cycle\'s own symbols (the bars that closed), not the config\'s', async () => {
  const dir = dirWith(doc());
  const r = await capture({ env: { FTH_GAMMA_DIR: dir }, now: NOW, symbols: ['MNQ', 'MES'], staleSymbols: ['MES'] });
  assert.strictEqual(r.seen.length, 1, 'one cycle');
  assert.ok(/MNQ: a 3-minute bar just closed/.test(r.seen[0].prompt) && !/MES: a 3-minute bar just closed/.test(r.seen[0].prompt), 'only MNQ closed a bar');
  assert.ok(r.seen[0].prompt.includes(lineOf(doc(), 'MNQ').line), 'MNQ\'s bare line');
  assert.ok(!r.seen[0].prompt.includes('MNQ: Gamma') && !r.seen[0].prompt.includes('MES: Gamma'), 'no symbol-prefixed lines for a one-symbol cycle');
  assert.strictEqual(r.seen[0].limits.context.gamma, lineOf(doc(), 'MNQ').line);
  // Both closed: each symbol's own line, prefixed.
  const both = await capture({ env: { FTH_GAMMA_DIR: dir }, now: NOW, symbols: ['MNQ', 'MES'] });
  assert.ok(both.seen[0].prompt.includes(G.gammaLines({ dir, symbols: ['MNQ', 'MES'], now: NOW })));
});

test('gamma line: the runner\'s written briefing carries the flag (true) exactly when the prompt carries the line - one source, both outputs', async () => {
  const cases = {
    'a valid file': [doc(), true],
    'a look-ahead file': [doc({ asOf: '2026-03-04' }), false],
    'no instrument': [doc({ instruments: {} }), false],
    'a stale file': [doc({ asOf: '2026-02-20' }), false],
    'an invalid level': [doc({ instruments: { NQ: { ...INST, putWall: 0 } } }), false],
    'malformed': ['{ nope', false],
  };
  for (const [why, [d, printed]] of Object.entries(cases)) {
    const r = await capture({ env: { FTH_GAMMA_DIR: dirWith(d) }, now: NOW });
    assert.strictEqual(HAS.test(r.seen[0].prompt), printed, `${why}: the line`);
    assert.strictEqual(flagOf(r.home) === true, printed, `${why}: the flag`);
    assert.ok(flagOf(r.home) === undefined || flagOf(r.home) === true, `${why}: a boolean true or no key`);
  }
  const none = await capture({ env: {}, now: NOW });
  assert.strictEqual(flagOf(none.home), undefined, 'no dir: no flag');
  assert.ok(!HAS.test(none.seen[0].prompt));
});

test('gamma line: through the real wiring the written briefing makes the gate require the lookup; with no line it does not', async () => {
  const ev = (tool, input) => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool, state: { status: 'completed', input, output: 'VERDICT: APPROVE - size 1' } } });
  const loaded = ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan'].map(name => ev('skill', { name }));
  const file = path.join(tmpDir(), 'session.jsonl');
  const gateOn = (home, lines) => {
    fs.writeFileSync(file, lines.join('\n'));
    const config = { ...loadConfig({ FTH_HOME: home }), killSwitchFile: path.join(home, 'STOP'), mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9, home, autonomous: true, cycle: null, cycleLaneBars: {} };
    return evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config, transcriptPath: file }).violations.filter(v => v.check === 'skills-loaded').map(v => v.message);
  };
  const on = await capture({ env: { FTH_GAMMA_DIR: dirWith(doc()) }, now: NOW });
  assert.ok(gateOn(on.home, loaded).some(m => /gex-regime/.test(m)), 'a line printed, no lookup: refused, naming it');
  assert.ok(!gateOn(on.home, [...loaded, ev('skill', { name: 'gex-regime' })]).some(m => /gex-regime/.test(m)), 'read: allowed');
  const off = await capture({ env: {}, now: NOW });
  assert.ok(!gateOn(off.home, loaded).some(m => /gex-regime/.test(m)), 'no line: nothing more is required');
});

test('gamma line: a replayed morning reads only that day\'s file (the replay clock is the cycle\'s date; the dir is the user\'s, never pinned)', async () => {
  const { PINNED, STRIPPED } = require('../../scripts/lib/replay/config');
  assert.ok(!Object.keys(PINNED).includes('FTH_GAMMA_DIR') && !STRIPPED.includes('FTH_GAMMA_DIR'), 'the replay driver neither pins nor strips it');
  const dir = dirWith(doc());
  const day = await capture({ env: { FTH_GAMMA_DIR: dir, FTH_REPLAY_NOW: '2026-03-04T15:03:00.000Z' }, now: new Date('2026-03-04T15:03:00Z') });
  assert.match(day.seen[0].prompt, /Gamma \(code, as of prior close 2026-03-03\): negative \(soft\)/);
  const next = await capture({ env: { FTH_GAMMA_DIR: dir, FTH_REPLAY_NOW: '2026-03-09T15:03:00.000Z' }, now: new Date('2026-03-09T15:03:00Z') });
  assert.ok(!HAS.test(next.seen[0].prompt), 'another replayed day: no file, no line');
});

// What the scan checks (and nothing more): where the gamma SOURCE is named, where the flag is read as a property
// (`.gamma`, `['gamma']`), and where `gamma` is destructured. Reading it any other way (an alias, a dynamic key) is not
// caught: the allowed files below are the whole of what may touch the flag.
const FLAG_READERS = ['scripts/lib/trading/briefing.js', 'scripts/lib/trading/skills-loaded.js']; // the writer and the trigger
const OPTION_PLUMBING = ['scripts/lib/autotrader.js', 'scripts/lib/runner.js', 'scripts/lib/trading/briefing.js']; // `gamma = default` options
const PROP = /\.gamma\b|\[\s*['"]gamma['"]\s*\]/;
const DESTRUCT = /\{[^{}]*\bgamma\b[^{}]*\}\s*(?:=(?!=)|\)\s*(?:=>|\{))/;
const DESTRUCT_NO_DEFAULT = /\{[^{}]*\bgamma\b(?!\s*=[^=>])[^{}]*\}\s*(?:=(?!=)|\)\s*(?:=>|\{))/;
const flagViolations = (file, text) => [
  ...(PROP.test(text) && !FLAG_READERS.includes(file) ? ['a .gamma read'] : []),
  ...(DESTRUCT.test(text) && !OPTION_PLUMBING.includes(file) ? ['a gamma destructuring'] : []),
  ...(DESTRUCT_NO_DEFAULT.test(text) ? ['a gamma destructuring without a default (a read)'] : []),
];

test('gamma line: no gate, risk, sizing, entry or exit code reads the gamma source or its flag (exact files; hooks included)', () => {
  const walk = d => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
  const files = [...walk(path.join(ROOT, 'scripts')), ...walk(path.join(ROOT, 'hooks'))].filter(f => f.endsWith('.js'));
  const rel = f => path.relative(ROOT, f);
  const text = f => fs.readFileSync(f, 'utf8');
  // The source: only the wiring and the module.
  assert.deepStrictEqual(files.filter(f => /FTH_GAMMA_DIR|require\([^)]*gamma-line/.test(text(f))).map(rel).sort(), ['scripts/lib/runner-wiring.js', 'scripts/lib/trading/gamma-line.js']);
  // The flag: no file outside the allowed ones reads or destructures it, and none destructures it without a default.
  const bad = files.map(f => [rel(f), flagViolations(rel(f), text(f))]).filter(([, v]) => v.length);
  assert.deepStrictEqual(bad, []);
  // The writer and the trigger are really there (the allowed lists are not slack).
  for (const f of FLAG_READERS) assert.ok(PROP.test(text(path.join(ROOT, f))), `${f} reads it`);
});

test('gamma line: the scan fails on a planted reader in the gate, the runner and the risk code (each pattern, each kind)', () => {
  const plants = {
    'a property read in the gate': ['scripts/lib/trading/order-gate.js', 'if (m3.gamma) size = 0;'],
    'a property read in verdict.js': ['scripts/lib/prop/verdict.js', 'const g = x.gamma;'],
    'an optional-chained read': ['scripts/lib/runner.js', 'const g = x?.gamma;'],
    'a bracket read': ['scripts/lib/runner.js', "const g = x['gamma'];"],
    'a read off a literal': ['scripts/lib/prop/verdict.js', 'const g = ({}).gamma;'],
    'a shorthand destructuring in runner.js': ['scripts/lib/runner.js', 'const { gamma } = state;'],
    'a destructuring with a default in the gate': ['scripts/lib/trading/order-gate.js', 'const { gamma = 0 } = m3;'],
    'a renamed destructuring in runner.js': ['scripts/lib/runner.js', 'const { gamma: g } = state;'],
    'a destructured parameter in verdict.js': ['scripts/lib/prop/verdict.js', 'const f = ({ size, gamma }) => size;'],
  };
  for (const [why, [file, code]] of Object.entries(plants)) assert.ok(flagViolations(file, `const a = 1;\n${code}\n`).length > 0, why);
  // The legitimate plumbing is not flagged: an option with a default and an object key.
  assert.deepStrictEqual(flagViolations('scripts/lib/runner.js', 'function f({ news = null, gamma = () => null }) { return { gamma: x }; }'), []);
  assert.deepStrictEqual(flagViolations('scripts/lib/runner-wiring.js', "const o = { gamma: (at, s) => gammaLines({ dir: env.FTH_GAMMA_DIR, symbols: s, now: at }) };"), []);
});

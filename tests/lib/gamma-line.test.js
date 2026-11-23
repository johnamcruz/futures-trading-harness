'use strict';

// The gamma line (trading/gamma-line.js): the one line the code computes from the user's local gamma dir, printed in the
// cycle prompt next to the news line, and the only thing the gex-regime skill reads. Synthetic files only. Pinned here:
// the word (and its cutoff, a tunable), every case that prints NO line, the exact line text, the contract root and the
// tick, the cycle date (the replay clock's in a replay), the situational skill the gate requires only when the briefing
// carries the line, and that no gate, risk, sizing, entry or exit code reads the source.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir, FX_GOLDEN } = require('../helpers');
const G = require('../../scripts/lib/trading/gamma-line');
const T = require('../../scripts/lib/tunables');
const { validateConfig, prompts } = require('../../scripts/lib/autotrader');
const { SITUATIONAL, situationalSkills, parseTrigger, fires } = require('../../scripts/lib/trading/skills-loaded');
const { wireRunner } = require('../../scripts/lib/runner-wiring');

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

test('gamma line: the exact line, as the gex-regime skill reads it (levels to the tick, net/gross to 2 decimals)', () => {
  const r = lineOf(doc());
  assert.strictEqual(r.word, 'negative');
  assert.strictEqual(r.line, 'Gamma (code, as of prior close 2026-03-03): negative (soft); net/gross 0.31; flip 21650; call wall 21900; put wall 21200.');
  assert.ok(!r.line.includes('\n'));
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
  // From the committed config when none is given.
  assert.strictEqual(G.wordFor({ ...INST, net: -1249 }).word, 'unclear');
  assert.strictEqual(lineOf(doc({ instruments: { NQ: { ...INST, net: 300 } } })).line.split(': ')[1].split(';')[0], 'unclear');
  assert.match(lineOf(doc({ instruments: { NQ: { ...INST, net: 4000 } } })).line, /: positive \(soft\); net\/gross 0\.40;/);
});

test('gamma line: anything missing or off prints NO line (never "unknown")', () => {
  const bad = x => ({ instruments: { NQ: { ...INST, ...x } } });
  const cases = {
    'a missing field': bad({ flip: undefined }),
    'a null level': bad({ callWall: null }),
    'a non-finite net': bad({ net: Infinity }),
    'a string number': bad({ gross: '10000' }),
    'a zero gross': bad({ gross: 0 }),
    'a negative gross': bad({ gross: -5 }),
    'no instrument': { instruments: {} },
    'instruments not an object': { instruments: [] },
    'another day\'s file content': { day: '2026-03-03' },
    'no day': { day: undefined },
    'asOf the same day (look-ahead)': { asOf: '2026-03-04' },
    'asOf after the day (look-ahead)': { asOf: '2026-03-05' },
    'asOf missing': { asOf: undefined },
    'asOf not a date': { asOf: '2026-02-30' },
    'asOf a timestamp': { asOf: '2026-03-03T21:00:00Z' },
  };
  for (const [why, over] of Object.entries(cases)) assert.strictEqual(lineOf(doc(over)), null, why);
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
  // A file named for the day whose content is for another day: refused (the name is not trusted).
  const d = dirWith(doc({ day: '2026-03-03' }), '2026-03-04');
  assert.strictEqual(G.gammaFor({ dir: d, symbol: 'MNQ', now: NOW }), null);
});

test('gamma line: the cycle symbol\'s mini root (MNQ -> NQ, MES -> ES, a contract name too), the tick, one line per symbol', () => {
  assert.match(lineOf(doc(), 'MES').line, /: positive \(soft\); net\/gross 0\.05;|: unclear; net\/gross 0\.05;/);
  assert.match(lineOf(doc(), 'NQ').line, /flip 21650;/, 'the mini itself');
  assert.match(lineOf(doc(), 'MNQ:2026-03').line, /flip 21650;/);
  assert.match(lineOf(doc({ instruments: { NQ: { ...INST, flip: 21650.13, callWall: 21900.37 } } })).line, /flip 21650\.25; call wall 21900\.25;/, 'to the tick');
  const dir = dirWith(doc());
  assert.strictEqual(G.gammaLines({ dir, symbols: ['MNQ'], now: NOW }), G.gammaFor({ dir, symbol: 'MNQ', now: NOW }).line, 'one symbol: the bare line');
  const both = G.gammaLines({ dir, symbols: ['MNQ', 'MES'], now: NOW });
  assert.match(both, /^MNQ: Gamma \(code[^\n]*put wall 21200\. MES: Gamma \(code[^\n]*put wall 5900\.$/);
  assert.match(G.gammaLines({ dir, symbols: ['MNQ', 'MYM'], now: NOW }), /^MNQ: Gamma/, 'a symbol with no source adds nothing');
  assert.strictEqual(G.gammaLines({ dir, symbols: ['MYM'], now: NOW }), null);
});

test('gamma line: the cycle\'s New York date picks the file (a late-evening UTC time is still that ET day)', () => {
  assert.strictEqual(G.etDate(new Date('2026-03-05T03:30:00Z')), '2026-03-04');
  assert.ok(G.gammaFor({ dir: dirWith(doc()), symbol: 'MNQ', now: new Date('2026-03-05T03:30:00Z') }), '22:30 ET on the 4th still reads the 4th');
  assert.strictEqual(G.gammaFor({ dir: dirWith(doc()), symbol: 'MNQ', now: new Date('2026-03-05T15:03:00Z') }), null, 'the next day has no file');
});

test('gamma line: the cutoff is a tunable (config/analysis.json), a mistyped one is refused and BUILT_IN carries it', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(T.BUILT_IN.analysis.gammaLine)), { unclearBelow: 0.125 });
  const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'analysis.json'), 'utf8'));
  const f = path.join(tmpDir(), 'analysis.json');
  for (const bad of [-0.1, 1.5, 'x', null]) {
    fs.writeFileSync(f, JSON.stringify({ ...committed, gammaLine: { unclearBelow: bad } }));
    assert.throws(() => T.load('analysis', f), /gammaLine\.unclearBelow: a number/);
  }
  fs.writeFileSync(f, JSON.stringify({ ...committed, gammaLine: {} }));
  assert.throws(() => T.load('analysis', f), /gammaLine\.unclearBelow: missing/);
});

test('gamma line: the gate requires gex-regime of the head trader only when the briefing carries the line', () => {
  const entry = SITUATIONAL.find(e => e.skill === 'gex-regime');
  assert.deepStrictEqual(entry, { when: 'gamma', skill: 'gex-regime', head: true, headOnly: true, factsOnly: true });
  assert.deepStrictEqual(situationalSkills({ gamma: { word: 'negative' } }), ['gex-regime']);
  assert.deepStrictEqual(situationalSkills({ gamma: { word: 'unclear' } }), ['gex-regime']);
  for (const none of [{}, null, undefined, { gamma: null }, { gamma: {} }, { gamma: { word: '' } }, { gamma: true }]) {
    assert.deepStrictEqual(situationalSkills(none), [], JSON.stringify(none));
  }
  assert.throws(() => parseTrigger('gamma=negative'), /takes no value/);
  assert.strictEqual(fires(parseTrigger('gamma'), { gamma: { word: 'positive' } }), true);
});

test('gamma line: the briefing carries only the word (m3.gamma), and only when the code printed a line', () => {
  const { buildBriefing } = require('../../scripts/lib/trading/briefing');
  const G2 = require('../fixtures/golden-bars');
  const bars = G2.load(G2.SERIES[0]).slice(1200, 1300);
  const now = new Date(Date.parse(bars[bars.length - 1].t) + 180000);
  const without = buildBriefing({ symbol: 'MNQ', bars, minutes: 3, now });
  const withG = buildBriefing({ symbol: 'MNQ', bars, minutes: 3, now, gamma: 'negative' });
  assert.ok(!('gamma' in without.sections.m3.data), 'no line, no key: the briefing is as before');
  assert.deepStrictEqual(withG.sections.m3.data.gamma, { word: 'negative' });
  const rest = { ...withG.sections.m3.data }; delete rest.gamma;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rest)), JSON.parse(JSON.stringify(without.sections.m3.data)), 'nothing else in the briefing differs');
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

function capture({ env, now }) {
  const home = tmpDir();
  const step = 180000;
  const t0 = now.getTime();
  const client = {
    async activeContract(symbol) { return { id: symbol, tickSize: 0.25 }; },
    async closedBars() { return [0, 1, 2].map(k => ({ t: new Date(t0 - 180000 - (2 - k) * step).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 1 })); },
  };
  const seen = [];
  const cfg = validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3, premarketAt: '', eodAt: '15:50@America/New_York', trigger: 'bar' });
  const runner = wireRunner({ cfg, root: ROOT, home, env: { FTH_HOME: home, FTH_STRATEGIES_DIRS: FX_GOLDEN, ...env }, client, dataDir: path.join(home, 'bars'), now: () => now, runCycle: async (action, prompt) => { seen.push({ action, prompt }); return { ok: true }; }, loadState: () => null, saveState: () => {}, killSwitchFile: path.join(home, 'STOP'), log: () => {}, event: () => {} });
  // The bars file sits in the run's own temp dir: its random name is not the prompt's content.
  return runner.step().then(() => ({ seen: seen.map(x => ({ ...x, prompt: x.prompt.replace(/fth-test-\w+/g, 'fth-test') })), home }));
}

test('gamma line: wired into the runner - the dir from FTH_GAMMA_DIR, the cycle\'s date; no dir or a failing source leaves the prompt as before', async () => {
  const dir = dirWith(doc());
  const off = await capture({ env: {}, now: NOW });
  const on = await capture({ env: { FTH_GAMMA_DIR: dir }, now: NOW });
  const trades = r => r.seen.filter(x => x.action === 'trade');
  assert.strictEqual(trades(off).length, 1, JSON.stringify(off.seen.map(x => x.action)));
  assert.strictEqual(trades(on).length, 1);
  const line = lineOf(doc()).line;
  assert.ok(trades(on)[0].prompt.includes(line));
  assert.strictEqual(trades(on)[0].prompt.replace(` ${line}`, ''), trades(off)[0].prompt, 'one line more, nothing else');
  assert.ok(!/Gamma \(code/.test(trades(off)[0].prompt));
  // Another day's replay clock reads only that day's file: no file for it, no line.
  const other = await capture({ env: { FTH_GAMMA_DIR: dir }, now: new Date('2026-03-05T15:03:00Z') });
  assert.ok(!/Gamma \(code/.test(trades(other)[0].prompt));
  // A look-ahead file (asOf on the day) prints nothing; a dir that is not a directory prints nothing and breaks nothing.
  const ahead = await capture({ env: { FTH_GAMMA_DIR: dirWith(doc({ asOf: '2026-03-04' })) }, now: NOW });
  assert.ok(!/Gamma \(code/.test(trades(ahead)[0].prompt));
  const notDir = await capture({ env: { FTH_GAMMA_DIR: path.join(dir, '2026-03-04.json') }, now: NOW });
  assert.strictEqual(trades(notDir)[0].prompt, trades(off)[0].prompt);
});

test('gamma line: a replayed morning reads only that day\'s file (the replay clock is the cycle\'s date; the dir is the user\'s, never pinned)', async () => {
  const { PINNED, STRIPPED } = require('../../scripts/lib/replay/config');
  assert.ok(!Object.keys(PINNED).includes('FTH_GAMMA_DIR') && !STRIPPED.includes('FTH_GAMMA_DIR'), 'the replay driver neither pins nor strips it');
  const dir = dirWith(doc());
  const day = await capture({ env: { FTH_GAMMA_DIR: dir, FTH_REPLAY_NOW: '2026-03-04T15:03:00.000Z' }, now: new Date('2026-03-04T15:03:00Z') });
  assert.match(day.seen.find(x => x.action === 'trade').prompt, /Gamma \(code, as of prior close 2026-03-03\): negative \(soft\)/);
  const next = await capture({ env: { FTH_GAMMA_DIR: dir, FTH_REPLAY_NOW: '2026-03-09T15:03:00.000Z' }, now: new Date('2026-03-09T15:03:00Z') });
  assert.ok(!/Gamma \(code/.test(next.seen.find(x => x.action === 'trade').prompt), 'another replayed day: no file, no line');
});

test('gamma line: no gate, risk, sizing, entry or exit code reads the gamma source (only the prompt\'s wiring)', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const readers = walk(path.join(ROOT, 'scripts')).filter(f => f.endsWith('.js'))
    .filter(f => /FTH_GAMMA_DIR|require\([^)]*gamma-line/.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(ROOT, f)).sort();
  assert.deepStrictEqual(readers, ['scripts/lib/runner-wiring.js', 'scripts/lib/trading/gamma-line.js']);
});

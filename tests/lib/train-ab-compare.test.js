'use strict';

// The A/B comparison of two finished replay runs (scripts/lib/train/ab-compare.js, scripts/ab-compare.js): the setup
// record and its refusals, the pairing, the paired verdicts, and the looks of held-back runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');
const { resolveReplay } = require('../../scripts/lib/replay/config');
const X = require('../../scripts/lib/learning/experience-index');
const AB = require('../../scripts/lib/train/ab-compare');

const REPO = path.resolve(__dirname, '..', '..');

/** A tiny harness tree: its skills and scripts digested, so a change is one file. */
function fakeRoot(dir, { skill = 'v1', code = 'v1' } = {}) {
  const root = path.join(dir, `root-${skill}-${code}`);
  fs.mkdirSync(path.join(root, 'skills', 'a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'a', 'SKILL.md'), `skill ${skill}\n`);
  fs.writeFileSync(path.join(root, 'scripts', 'x.js'), `// ${code}\n`);
  return root;
}

/** A user home with a replay broker "sim" (its data setting SIM_DATA, and a credential it must never record). */
function world() {
  const dir = tmpDir();
  const live = path.join(dir, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ brokers: { sim: { command: ['node', '/opt/sim/server.js'], replay: true, journalEnv: 'SIM_JOURNAL', env: ['SIM_DATA', 'SIM_API_KEY'] } } }));
  const env = { PATH: process.env.PATH, FTH_HOME: live, FTH_BROKERS_FILE: path.join(live, 'brokers.json'), SIM_DATA: '/data/a', SIM_API_KEY: 'hunter2-secret' };
  return { dir, env, roots: { base: fakeRoot(dir), skill: fakeRoot(dir, { skill: 'v2' }), code: fakeRoot(dir, { code: 'v2' }) } };
}

const config = (w, runId, over = {}) => ({
  runId, workDir: path.join(w.dir, 'replays'), broker: 'sim', start: '2023-03-06T14:00:00Z', end: '2023-03-06T20:00:00Z', premarket: false, latency: false,
  practice: { seed: 3 },
  autotrader: { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, sessions: ['09:30-15:50@America/New_York'], eodAt: '15:50@America/New_York' },
  ...over,
});

/** The run resolved, its home seeded with the user's brokers (as replay.js run seeds it before recording the setup). */
function resolve(w, runId, { over = {}, root = w.roots.base, env = w.env } = {}) {
  const run = resolveReplay(config(w, runId, over), { env, home: w.dir, root });
  fs.mkdirSync(run.paths.runDir, { recursive: true });
  fs.copyFileSync(env.FTH_BROKERS_FILE, path.join(run.paths.runHome, 'brokers.json'));
  return run;
}

const BARS = Array.from({ length: 30 }, (_, i) => new Date(Date.parse('2023-03-06T14:30:00Z') + i * 180000).toISOString());
const decision = (bar, { entered = true, R = 1, reads = ['true', 'true'], hidden = false } = {}) => ({
  v: 1, id: `${bar}`, root: 'MNQ', bar, day: bar.slice(0, 10), decision: entered ? 'entered' : 'passed',
  reads: reads.map((check, i) => ({ step: `s${i}`, skill: 'a', read: `read ${i}`, check })), outcome: hidden ? null : { R: entered ? R : null }, ...(hidden ? { hidden: true } : {}),
});
const card = (bar, category) => ({ t: bar, symbol: 'MNQZ3', category });

/** A finished run: its setup recorded as replay.js run records it, its experience log, scorecard and learning decision. */
function makeRun(w, runId, { over, root, env, decisions = [], scorecard = null, gate = { learning: true, role: 'practice-train', look: null, hideOutcomes: false }, finished = true, setup = true } = {}) {
  const run = resolve(w, runId, { over, root, env });
  fs.mkdirSync(run.paths.runDir, { recursive: true });
  fs.writeFileSync(run.paths.manifest, JSON.stringify({ v: 1, runId, start: run.start.toISOString(), end: run.end.toISOString(), finished }));
  if (setup) AB.recordSetup(run, { env: env || w.env });
  const exp = path.join(run.paths.runHome, 'experience');
  fs.mkdirSync(exp, { recursive: true });
  fs.writeFileSync(path.join(exp, 'decisions.jsonl'), decisions.map(d => `${JSON.stringify({ ...d, runId })}\n`).join(''));
  if (scorecard) fs.writeFileSync(path.join(run.paths.runDir, 'scorecard.jsonl'), scorecard.map(r => `${JSON.stringify(r)}\n`).join(''));
  if (gate) fs.writeFileSync(path.join(run.paths.runDir, 'learning-run.json'), JSON.stringify(gate));
  return run;
}

const recordOf = run => JSON.parse(fs.readFileSync(path.join(run.paths.runDir, AB.SETUP_FILE), 'utf8'));
const compare = (a, b, opts = {}) => AB.compareRuns(a.paths.runHome, b.paths.runHome, { env: {}, deps: { skillUsage: null, mc: null }, ...opts });

test('the setup record: written once at a run\'s start, its pinned parts, and never a credential', () => {
  const w = world();
  const run = resolve(w, 'a');
  const rec = AB.recordSetup(run, { env: w.env });
  assert.deepStrictEqual(Object.keys(rec.pinned), [...AB.PINNED]);
  assert.strictEqual(rec.pinned.seed, 3);
  assert.match(rec.pinned.list, /^window 2023-03-06T14:00:00.000Z\.\.2023-03-06T20:00:00.000Z$/);
  assert.strictEqual(rec.pinned.index, 'without');
  assert.ok(rec.config['cfg.account'] && !('practice.seed' in rec.config) && !('cfg.dataDir' in rec.config), 'the seed is pinned, the run\'s own folders are no part of it');
  assert.ok(!JSON.stringify(rec).includes('hunter2'), 'a credential never reaches the record');
  // Another data setting is other data; the credential's value is no part of the setup.
  assert.notStrictEqual(AB.setupRecord(run, { env: { ...w.env, SIM_DATA: '/data/b' } }).pinned.data, rec.pinned.data);
  assert.strictEqual(AB.setupRecord(run, { env: { ...w.env, SIM_API_KEY: 'other' } }).pinned.data, rec.pinned.data);
  // A resume keeps the record its run started with.
  fs.writeFileSync(path.join(run.paths.runDir, AB.SETUP_FILE), JSON.stringify({ ...rec, runId: 'kept' }));
  assert.strictEqual(AB.recordSetup(run, { env: w.env }).runId, 'kept');
});

test('setups: refused unless they share stage, list or window, seed, market, data, index and code, and differ in one thing', () => {
  const w = world();
  const rec = (runId, o = {}) => AB.setupRecord(resolve(w, runId, o), { env: o.env || w.env });
  const base = rec('a');
  const idx = X.writeIndex(path.join(w.dir, 'idx'), X.buildIndex([], { reps: 20 }));
  const refused = (b, re, opts) => { const r = AB.compareSetups(base, b, opts); assert.strictEqual(r.ok, false); assert.match(r.refusals.join('\n'), re); return r; };
  refused(rec('b'), /the setups are identical/);
  refused(rec('b', { over: { practice: { seed: 4 } }, root: w.roots.skill }), /seed differs \(3 vs 4\)/);
  refused(rec('b', { over: { end: '2023-03-06T19:00:00Z' }, root: w.roots.skill }), /list differs \(window/);
  refused(rec('b', { over: { autotrader: { ...config(w, 'b').autotrader, symbols: ['MES'] } }, root: w.roots.skill }), /market differs/);
  refused(rec('b', { env: { ...w.env, SIM_DATA: '/data/b' }, root: w.roots.skill }), /data differs/);
  refused(rec('b', { over: { experienceIndex: idx }, root: w.roots.skill }), /index differs \(without vs with:[0-9a-f]{16}\)/);
  refused({ ...rec('b', { root: w.roots.skill }), pinned: { ...base.pinned, stage: 2 } }, /stage differs \(none vs 2\)/);
  refused(rec('b', { root: w.roots.code }), /the code \(scripts\/\) differs too/);
  // The documents alone: compared.
  const docs = AB.compareSetups(base, rec('b', { root: w.roots.skill }));
  assert.deepStrictEqual(docs.refusals, []);
  assert.match(docs.differs.join('; '), /harness digest [0-9a-f]{12} vs [0-9a-f]{12}; skills digest/);
  refused(rec('b', { root: w.roots.skill }), /the declared field cfg.model does not differ \(the harness and skills digests do\)/, { field: 'cfg.model' });
  // One config field: only declared, and only that one.
  const model = rec('b', { over: { autotrader: { ...config(w, 'b').autotrader, model: 'other' } } });
  refused(model, /config field cfg.model differs: declare it \(--field cfg.model\)/);
  refused(model, /the declared field cfg.harness is not the one that differs \(cfg.model\)/, { field: 'cfg.harness' });
  assert.deepStrictEqual(AB.compareSetups(base, model, { field: 'cfg.model' }).refusals, []);
  assert.match(AB.compareSetups(base, model, { field: 'cfg.model' }).differs.join(''), /cfg.model: "" vs "other"/);
  refused(rec('b', { over: { autotrader: { ...config(w, 'b').autotrader, model: 'other', bars: 300 } } }), /2 config fields differ \(cfg.bars, cfg.model\)/, { field: 'cfg.model' });
  refused(rec('b', { over: { autotrader: { ...config(w, 'b').autotrader, model: 'other' } }, root: w.roots.skill }), /the documents \(harness, skills\) and config \(cfg.model\) both differ/, { field: 'cfg.model' });
  // looks.js's library-display pair (the same setupBase): the display is its one dimension, no declaration needed.
  const shown = { ...base, setup: 'f'.repeat(64), config: { ...base.config, libraryDisplay: 'true' } };
  assert.deepStrictEqual(AB.compareSetups(base, shown).refusals, []);
  refused({ ...shown, base: 'e'.repeat(64) }, /config field libraryDisplay differs: declare it/);
  // A credential-like setting's value is never printed.
  assert.match(AB.compareSetups({ ...base, config: { ...base.config, 'gate.FTH_X_TOKEN': '"a"' } }, base, { field: 'gate.FTH_X_TOKEN' }).differs.join(''), /gate.FTH_X_TOKEN: \(redacted\) vs \(redacted\)/);
});

test('pairing: one decision per (root, bar); an entry\'s legs averaged, a pass 0; another bar is not a pair', () => {
  const m = AB.decisionsByKey([decision(BARS[0], { R: 2 }), decision(BARS[0], { R: 1 }), decision(BARS[1], { entered: false }), { ...decision(BARS[2]), root: 'MES' }, decision(BARS[3], { R: null })]);
  assert.deepStrictEqual([...m.keys()], [`MNQ|${BARS[0]}`, `MNQ|${BARS[1]}`, `MES|${BARS[2]}`, `MNQ|${BARS[3]}`]);
  assert.strictEqual(m.get(`MNQ|${BARS[0]}`).R, 1.5);
  assert.strictEqual(m.get(`MNQ|${BARS[1]}`).R, 0);
  assert.strictEqual(m.get(`MNQ|${BARS[3]}`).R, null, 'an entry without a settled outcome has no R');
  const w = world();
  const a = makeRun(w, 'a', { decisions: [decision(BARS[0], { R: -1 }), decision(BARS[1], { R: -1 })] });
  const b = makeRun(w, 'b', { root: w.roots.skill, decisions: [decision(BARS[0], { R: 2 }), decision(BARS[2], { R: 2 })] });
  const r = compare(a, b, { metrics: ['r-trade'] });
  assert.strictEqual(r.refused, false, (r.refusals || []).join('\n'));
  assert.strictEqual(r.rows[0].n, 1, 'only the bar both runs decided');
  assert.strictEqual(r.rows[0].diff, 3);
});

function scripted(w, { better }) {
  const decA = BARS.map((bar, i) => decision(bar, { R: i % 3 ? -1 : 1, reads: i < 12 ? ['true', 'false'] : ['true', 'true'] }));
  const decB = better ? BARS.map((bar, i) => decision(bar, { R: i % 3 ? 1.5 : 2, reads: ['true', 'true'] })) : decA;
  const cardA = BARS.map((bar, i) => card(bar, i < 10 ? 'excessive abstention' : 'right'));
  const cardB = better ? BARS.map(bar => card(bar, 'right')) : cardA;
  return [makeRun(w, 'a', { decisions: decA, scorecard: cardA }), makeRun(w, 'b', { root: w.roots.skill, decisions: decB, scorecard: cardB })];
}

test('a scripted pair where B is clearly better is "B better"; the same decisions are "no significant difference"; reversed is "B worse"', () => {
  const w = world();
  const [a, b] = scripted(w, { better: true });
  const r = compare(a, b);
  assert.strictEqual(r.refused, false, (r.refusals || []).join('\n'));
  const by = name => r.rows.find(x => x.measure.startsWith(name));
  assert.strictEqual(by('R per decision').verdict, AB.BETTER);
  assert.ok(by('R per decision').lo > 0 && by('R per decision').n === 30);
  assert.strictEqual(by('R per trade').verdict, AB.BETTER);
  assert.strictEqual(by('correct-read rate').verdict, AB.BETTER);
  assert.match(by('correct-read rate').test, /^judge: fixed 12, broke 0 of 30/);
  assert.strictEqual(by('process adherence').verdict, AB.BETTER);
  assert.match(by('entry rate').verdict, /descriptive/);
  assert.strictEqual(r.result, AB.BETTER);
  assert.match(AB.reportText(r), /\| R per decision \(realized; a pass 0\) \| 30 \|[^\n]*B better[\s\S]*Result: B better\n$/);
  // Swapped: B is A's worse.
  const back = AB.compareRuns(b.paths.runHome, a.paths.runHome, { env: {}, deps: { skillUsage: null, mc: null } });
  assert.strictEqual(back.result, AB.WORSE);
  assert.strictEqual(back.rows.find(x => x.measure.startsWith('process adherence')).verdict, AB.WORSE);
  // No change in what was decided: nothing significant.
  const w2 = world();
  const [c, d] = scripted(w2, { better: false });
  const same = compare(c, d);
  assert.strictEqual(same.result, AB.NONE);
  assert.ok(same.rows.every(x => ![AB.BETTER, AB.WORSE].includes(x.verdict)), JSON.stringify(same.rows));
  assert.strictEqual(same.rows.find(x => x.measure.startsWith('R per decision')).diff, 0);
});

test('one measure worse outweighs another better: the result is "B worse"', () => {
  const w = world();
  const a = makeRun(w, 'a', { decisions: BARS.map(bar => decision(bar, { R: -1 })), scorecard: BARS.map(bar => card(bar, 'right')) });
  const b = makeRun(w, 'b', { root: w.roots.skill, decisions: BARS.map(bar => decision(bar, { R: 2 })), scorecard: BARS.map((bar, i) => card(bar, i < 10 ? 'wrong-side entry' : 'right')) });
  const r = compare(a, b, { metrics: ['r-decision', 'process'] });
  assert.deepStrictEqual(r.rows.filter(x => !x.measure.startsWith(' ')).map(x => x.verdict), [AB.BETTER, AB.WORSE]);
  assert.strictEqual(r.result, AB.WORSE);
});

test('a small sample is never significant: an interval verdict needs the rule\'s minimum pairs', () => {
  const w = world();
  const a = makeRun(w, 'a', { decisions: BARS.slice(0, 5).map(bar => decision(bar, { R: -1 })) });
  const b = makeRun(w, 'b', { root: w.roots.skill, decisions: BARS.slice(0, 5).map(bar => decision(bar, { R: 3 })) });
  const r = compare(a, b, { metrics: ['r-decision'] });
  assert.match(r.rows[0].verdict, /^no significant difference \(5 pairs, under 20\)$/);
  assert.strictEqual(r.result, AB.NONE);
});

test('refused runs: unfinished, no setup record, or setups that differ in more than one thing; what differs is printed', () => {
  const w = world();
  const a = makeRun(w, 'a', { decisions: [] });
  const r1 = compare(a, makeRun(w, 'b', { root: w.roots.skill, finished: false }));
  assert.match(r1.refusals.join('\n'), /run b is not finished/);
  const r2 = compare(a, makeRun(w, 'c', { root: w.roots.skill, setup: false }));
  assert.match(r2.refusals.join('\n'), /run c has no setup record/);
  const r3 = compare(a, makeRun(w, 'd', { root: w.roots.code }));
  assert.ok(r3.refused && !r3.rows);
  assert.match(AB.reportText(r3), /differs: code digest [0-9a-f]{12} vs [0-9a-f]{12}\nrefused:\n- the code \(scripts\/\) differs too/);
  assert.throws(() => compare(a, a, { metrics: ['nope'] }), /--metric: one of/);
});

test('held-back windows: read only through the runs\' recorded looks; a reasoning-fix look hides the outcomes', () => {
  const w = world();
  const ledger = path.join(w.dir, 'looks.jsonl');
  const over = { start: '2025-03-03T14:00:00Z', end: '2025-03-03T20:00:00Z' };
  const bars = BARS.map(b => b.replace('2023-03-06', '2025-03-03'));
  const decs = R => bars.map(bar => decision(bar, { R }));
  const gate = (evaluation, purpose = 'judging') => ({ learning: true, role: 'test', look: { evaluation, candidate: 'c', purpose }, hideOutcomes: purpose === 'reasoning-fix', ledger });
  const lookLine = (run, evaluation, purpose = 'judging', cfg) => fs.appendFileSync(ledger, `${JSON.stringify({ kind: 'look', evaluation, candidate: 'c', purpose, runId: run.runId, arm: 'without', config: cfg === undefined ? recordOf(run).setup : cfg, from: '2025-03-03', to: '2025-03-04', role: 'test', at: '2026-10-14T00:00:00Z' })}\n`);
  // No learning decision on a test day: refused.
  const bare = makeRun(w, 'bare', { over, decisions: decs(1), gate: null });
  const other = makeRun(w, 'other', { over, root: w.roots.skill, decisions: decs(1), gate: gate('e2') });
  assert.match(compare(bare, other).refusals.join('\n'), /run bare holds held-back days \(practice-validate, test or final\) and no learning decision/);
  // A look the ledger doesn't hold (none at all, then another run's): refused, nothing read.
  const a = makeRun(w, 'a', { over, decisions: decs(-1), gate: gate('e1') });
  assert.match(compare(a, other).refusals.join('\n'), /its look's ledger can't be read/);
  lookLine(a, 'e1');
  lookLine({ runId: 'someone' }, 'e2', 'judging', 'x');
  assert.match(compare(a, other).refusals.join('\n'), /run other: its judging look \(evaluation e2\) is not in the ledger/);
  // Its look names another setup: refused.
  lookLine(other, 'e2', 'judging', 'f'.repeat(64));
  assert.match(compare(a, other).refusals.join('\n'), /run other: its look names setup ffffffffffff, not the one it recorded/);
  // Both looks recorded: compared, with the outcomes.
  const b = makeRun(w, 'b', { over, root: w.roots.skill, decisions: decs(2), gate: gate('e3') });
  lookLine(b, 'e3');
  const ok = compare(a, b);
  assert.strictEqual(ok.refused, false, (ok.refusals || []).join('\n'));
  assert.strictEqual(ok.rows.find(x => x.measure.startsWith('R per decision')).verdict, AB.BETTER);
  assert.match(AB.reportText(ok), /looks: A judging look e1, B judging look e3/);
  // A reasoning-fix look on either side: every outcome measure hidden, the process measures kept.
  const fix = makeRun(w, 'fix', { over, root: w.roots.skill, decisions: bars.map(bar => decision(bar, { hidden: true })), gate: gate('e4', 'reasoning-fix') });
  lookLine(fix, 'e4', 'reasoning-fix');
  const hid = compare(a, fix, { deps: { skillUsage: null, mc: () => assert.fail('the Monte Carlo reads outcomes') } });
  assert.strictEqual(hid.refused, false, (hid.refusals || []).join('\n'));
  for (const m of ['R per decision', 'R per trade']) assert.deepStrictEqual([hid.rows.find(x => x.measure === m).verdict, hid.rows.find(x => x.measure === m).test], ['N/A', 'hidden: a reasoning-fix look hides outcomes']);
  assert.ok(hid.rows.some(x => x.measure.startsWith('correct-read rate') && x.n === 30));
  assert.ok(!JSON.stringify(hid.rows).includes('"a":-1'), 'no outcome of A shows either');
  assert.match(AB.reportText(hid), /\(outcomes hidden\)/);
  for (const run of [a, fix]) fs.writeFileSync(path.join(run.paths.runDir, AB.SETUP_FILE), JSON.stringify({ ...recordOf(run), pinned: { ...recordOf(run).pinned, stage: 2 } }));
  const mcHidden = compare(a, fix, { metrics: ['mc'], deps: { mc: () => assert.fail('the Monte Carlo reads outcomes') } });
  assert.deepStrictEqual([mcHidden.rows[0].verdict, mcHidden.rows[0].test], ['N/A', 'hidden: a reasoning-fix look hides outcomes']);
  // A window that can't be read is held back (fail closed); two roles are never paired.
  const garbled = { runId: 'g', manifest: { start: 'garbage', end: 'garbage' }, gate: null, setup: null };
  assert.match(AB.checkLooks(garbled, garbled).refusals.join('\n'), /run g holds held-back days/);
  const after = role => ({ runId: role, manifest: { start: '2027-03-01T14:00:00Z', end: '2027-03-01T20:00:00Z' }, gate: { learning: false, role, look: null }, setup: null });
  assert.deepStrictEqual(AB.checkLooks(after(null), after(null)).refusals, []);
  assert.match(AB.checkLooks(after('practice-train'), after(null)).refusals.join('\n'), /different windows \(practice-train vs none\)/);
  // Two windows: refused.
  const train = makeRun(w, 'train', { root: w.roots.skill, decisions: decs(1) });
  assert.match(compare(a, train).refusals.join('\n'), /list differs/);
});

test('stage 2: the paired Monte Carlo (B minus A) when the branch has it; N/A otherwise; skill usage when present', () => {
  const w = world();
  const a = makeRun(w, 'a', { decisions: [] });
  const b = makeRun(w, 'b', { root: w.roots.skill, decisions: [] });
  const mcRow = r => r.rows.find(x => x.measure.includes('Monte Carlo'));
  assert.match(mcRow(compare(a, b, { metrics: ['mc'] })).test, /stage 2 runs only \(stage none\)/);
  for (const run of [a, b]) fs.writeFileSync(path.join(run.paths.runDir, AB.SETUP_FILE), JSON.stringify({ ...recordOf(run), pinned: { ...recordOf(run).pinned, stage: 2 } }));
  assert.match(mcRow(compare(a, b, { metrics: ['mc'] })).test, /pairRuns\) is not on this branch/);
  const iv = (diff, lo, hi) => ({ diff, lo, hi, n: 100 });
  const res = { verdict: 'A better', a: { resampled: { passRate: 0.5, blowRate: 0, medianDaysToPass: 12 } }, b: { resampled: { passRate: 0.3, blowRate: 0.1, medianDaysToPass: 15 } }, diff: { resampled: { passRate: iv(0.2, 0.1, 0.3), blowRate: iv(-0.1, -0.15, -0.05), medianDaysToPass: iv(-3, -5, -1) } } };
  const seen = [];
  const r = compare(a, b, { metrics: ['mc'], deps: { mc: (x, y) => { seen.push(x.runId, y.runId); return res; } } });
  assert.deepStrictEqual(seen, ['a', 'b']);
  const pass = r.rows.find(x => x.measure === 'MC pass within 30 days');
  assert.deepStrictEqual([pass.diff, pass.lo, pass.hi, pass.verdict], [-0.2, -0.3, -0.1, AB.WORSE], 'A minus B turned into B minus A');
  assert.strictEqual(r.rows.find(x => x.measure === 'MC blow rate').lo, 0.05);
  assert.strictEqual(r.result, AB.WORSE);
  assert.match(mcRow(compare(a, b, { metrics: ['mc'], deps: { mc: () => { throw new Error('no account'); } } })).test, /^no account$/);
  // Skill usage: N/A without the module, descriptive rows with it.
  assert.match(compare(a, b, { metrics: ['skills'] }).rows[0].test, /skill-usage.js is not on this branch/);
  const usage = dir => ({ skills: [{ skill: 'cisd', usedRate: dir === a.paths.runDir ? 0.5 : 0.75, correctRate: 0.8, missed: dir === a.paths.runDir ? 4 : 1, used: 2, available: 4, correct: 4, reads: 5 }] });
  const s = compare(a, b, { metrics: ['skills'], deps: { skillUsage: usage } });
  assert.match(s.rows[0].measure, /skill cisd: used \+0\.25, correct 0, missed -3/);
  assert.strictEqual(s.result, AB.NONE);
});

test('the CLI: a table and one line, and exit code 0 even when refused or misused', () => {
  const w = world();
  const [a, b] = scripted(w, { better: true });
  const cli = args => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'ab-compare.js'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: w.dir } });
  const out = path.join(w.dir, 'ab.json');
  const ok = cli([a.paths.runHome, b.paths.runHome, '--metric', 'r-decision,process', '--out', out]);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /\| measure \| n \| A \| B \| B - A \[90%\] \| verdict \| test \|[\s\S]*Result: B better/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).rows.filter(x => !x.measure.startsWith(' ')).map(x => x.measure.split(' (')[0]), ['R per decision', 'process adherence']);
  const same = cli([a.paths.runHome, a.paths.runDir]);
  assert.strictEqual(same.status, 0);
  assert.match(same.stdout, /refused:\n- the setups are identical/);
  const bad = cli([a.paths.runHome]);
  assert.strictEqual(bad.status, 0);
  assert.match(bad.stderr, /usage: ab-compare.js/);
});

test('scripts/replay.js run records the setup at the run\'s start, the one its look names; a refused run records none', () => {
  const user = tmpDir();
  const run = (start, end, flags = []) => {
    fs.writeFileSync(path.join(user, 'replay.json'), JSON.stringify({
      runId: 'r', workDir: path.join(user, 'replays'), broker: 'replaymock', start, end, premarket: false,
      autotrader: { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3 },
    }));
    fs.mkdirSync(path.join(user, 'live'), { recursive: true });
    fs.writeFileSync(path.join(user, 'live', 'brokers.json'), JSON.stringify({ brokers: { replaymock: { command: ['true'], replay: true, journalEnv: 'MOCK_JOURNAL', env: ['MOCK_JOURNAL'] } } }));
    return spawnSync(process.execPath, [path.join(REPO, 'scripts', 'replay.js'), 'run', '--config', path.join(user, 'replay.json'), ...flags], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: user, FTH_HOME: path.join(user, 'live') }, timeout: 60000 });
  };
  const file = path.join(user, 'replays', 'r', 'replay', 'r', AB.SETUP_FILE);
  run('2024-08-05T14:30:00Z', '2024-08-05T15:00:00Z');
  assert.ok(!fs.existsSync(file), 'refused by the gate: nothing recorded');
  run('2024-08-05T14:30:00Z', '2024-08-05T15:00:00Z', ['--validate']);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const [look] = fs.readFileSync(path.join(user, '.futures-trading-harness', 'learning', 'looks.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual([rec.runId, rec.setup, rec.arm, rec.pinned.index], ['r', look.config, look.arm, 'without']);
});

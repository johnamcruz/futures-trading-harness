'use strict';

// The schedule is config (config/schedule.json): every caller reads it through the resolver (scripts/lib/schedule.js),
// and no module keeps a window of its own.
//
// 1. Each caller follows the schedule: a child process reads another schedule in place of the committed file
//    (tests/fixtures/schedule/use-file.js), with the learning and prop open windows, the budgets, the validate cap and
//    the flow coverage moved; every caller's answer moves with it.
// 2. No stray window literal in scripts/lib: no date literal at all in a module of the schedule's (one that reads it,
//    directly or through the splits, the looks, the run gate, the scorecard's look or the ledger file), and no
//    window-shaped literal ([from, to] dates, or from: and to: dates) anywhere, but in the schema (ALLOW).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib');
const RAW = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'schedule.json'), 'utf8'));
/** The schema: the only module allowed a window literal (it holds none today). */
const ALLOW = ['scripts/lib/schedule.js'];

function shifted() {
  const d = JSON.parse(JSON.stringify(RAW));
  d.version = 'shifted';
  d.learning.open['practice-train'] = ['2020-01-01', '2023-01-01'];
  d.learning.open['practice-validate'] = ['2023-01-01', '2025-01-01'];
  d.learning.sealed.lookBudgets.test = 2;
  d.learning.sealed.validateRunsPerCandidate = 2;
  d.learning.sealed.finalNeedsTestPass = false; // looser than the pin (tests/lib/schedule.test.js): a probe only
  d.learning.sealed.recordedLooks = [];
  d.prop.open.train = ['2021-01-01', '2023-01-01'];
  d.prop.open.select = ['2023-01-01', '2024-07-01'];
  d.prop.sealed.lookBudget = 2;
  d.prop.sealed.recordedLooks = [];
  d.data.flowCoverage = ['2021-05-01', '2023-01-01'];
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fth-schedule-callers-')), 'schedule.json');
  fs.writeFileSync(f, JSON.stringify(d));
  return f;
}

// Each caller's answer for days that move between the two schedules (2023-03 and 2023-06: practice-train and train in
// the committed one, practice-validate and select in the shifted one).
const PROBE = `
const path = require('path');
const fs = require('fs');
const os = require('os');
const out = {};
const t = (k, f) => { try { out[k] = f(); } catch (e) { out[k] = 'threw: ' + e.message.split('\\n')[0]; } };
const lib = m => require(path.join(process.cwd(), 'scripts', 'lib', m));
t('resolve', () => lib('schedule').resolve('2023-06-05', 'learning').role);
t('resolveProp', () => lib('schedule').resolve('2023-03-06', 'prop').role);
t('learningSplits', () => lib('learning/splits').roleOf('2023-06-05'));
t('propSplits', () => lib('prop/splits').roleOf('2023-03-06').role);
t('flow', () => lib('prop/splits').isFlowCovered('2023-06-05'));
t('runGate', () => lib('learning/run-gate').checkLearningRun({ from: '2023-06-05', to: '2023-06-06', runId: 'r', learning: true }).role);
t('looksBudget', () => lib('learning/looks').lookRule('test').budget);
t('finalNeedsPass', () => lib('learning/looks').lookRule('final').needsTestPass);
t('looksBudgetConst', () => lib('learning/looks').LOOK_BUDGETS.test);
t('validateCap', () => lib('learning/looks').validateRuns(['a', 'b', 'c'].map(r => ({ kind: 'look', purpose: 'validate', role: 'practice-validate', candidate: 'c', evaluation: r, runId: r, from: '2024-07-01', to: '2024-07-02' })), 'c').counted.length);
t('propLooks', () => lib('prop/looks').checkLook({ candidate: 'c', purpose: 'tuning', from: '2023-03-06', to: '2023-03-07' }, []).ok);
t('propBudget', () => lib('prop/looks').lookRule({ role: 'oos', part: null }).budgetLooks);
t('preflight', () => lib('learning/preflight').splitWindow({ gate: { from: '2023-06-05', to: '2023-06-06' } }).detail);
t('evaluator', () => lib('prop/evaluator').checkWindow({ from: '2023-03-06', to: '2023-03-10' }).unit.role);
t('scorecard', () => lib('replay/scorecard').lookAt({ manifest: { runId: 'r', source: 'replay' }, days: { '2023-03-06': {} } }, { purpose: 'tuning', ledger: [] }).units.map(u => u.role).join());
t('scorecardLook', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-probe-'));
  fs.writeFileSync(path.join(dir, 'learning-run.json'), JSON.stringify({ learning: true, role: 'practice-train' }));
  return lib('learning/scorecard-look').learningLook(dir, { manifest: { runId: 'r' }, days: { '2023-06-05': {} } }).role;
});
t('checkedScorecard', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-probe-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ runId: 'r', source: 'replay' }));
  fs.writeFileSync(path.join(dir, '2023-03-06.jsonl'), '');
  return lib('train/loop').checkedScorecard(() => 'scored')({ runDir: dir, look: { purpose: 'tuning', ledger: [] } });
});
t('modelVerifier', () => lib('train/model-verifier').windowErrors([{ from: '2023-06-05', to: '2023-06-06' }], []).length);
t('trainLoop', () => lib('train/loop').judgeHeldOut({ loop: { heldOutWindows: [{ from: '2023-03-06', to: '2023-03-10' }] }, heldOutLook: true, env: { HOME: os.tmpdir() }, root: process.cwd() }));
const settle = k => Promise.resolve(out[k]).then(v => { out[k] = v; }, e => { out[k] = 'threw: ' + e.message.split('\\n')[0]; });
Promise.all([settle('trainLoop'), settle('checkedScorecard')]).then(() => process.stdout.write(JSON.stringify(out)));
`;

function probe(source) {
  const r = spawnSync(process.execPath, ['--require', path.join(ROOT, 'tests', 'fixtures', 'schedule', 'use-file.js'), '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, FTH_TEST_SCHEDULE_SOURCE: source || '' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('every caller reads the schedule through the resolver: moving the config moves each answer', () => {
  const was = probe(null);
  const now = probe(shifted());
  const moved = {
    resolve: ['practice-train', 'practice-validate'],
    resolveProp: ['train', 'select'],
    learningSplits: ['practice-train', 'practice-validate'],
    propSplits: ['train', 'select'],
    flow: [true, false],
    looksBudget: [3, 2],
    looksBudgetConst: [3, 2],
    finalNeedsPass: [true, false],
    validateCap: [3, 2],
    propLooks: [true, false],
    propBudget: [3, 2],
    preflight: ['practice-train (practice)', 'practice-validate (validate)'],
    evaluator: ['train', /^threw: window 2023-03-06..2023-03-10 is in select, not train: it needs a look/],
    scorecard: ['train', /^threw: .*select \[2023-01-01, 2024-07-01\) allows judging looks only, not tuning/],
    scorecardLook: ['practice-train', /^threw: .*are practice-validate, not the practice-train window/],
    modelVerifier: [0, 1],
    checkedScorecard: ['scored', /^threw: .*select \[2023-01-01, 2024-07-01\) allows judging looks only, not tuning/],
    runGate: ['practice-train', /^threw: learning run refused: practice-validate months need the validate flag/],
    trainLoop: [/^threw: heldOutWindows 2023-03-06..2023-03-10: not inside one held-out unit/, /^threw: (?!heldOutWindows)/],
  };
  for (const [k, [a, b]] of Object.entries(moved)) {
    for (const [got, want, which] of [[was[k], a, 'committed'], [now[k], b, 'shifted']]) {
      if (want instanceof RegExp) assert.match(String(got), want, `${k} (${which})`);
      else assert.deepStrictEqual(got, want, `${k} (${which})`);
    }
  }
});

/** The code of a module, without its comments (a rough strip: line and block comments outside strings). */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
}

const DATE = /(['"`])\d{4}-\d{2}(?:-\d{2})?\1/g;
const WINDOW = [
  /\[\s*(['"`])\d{4}-\d{2}(?:-\d{2})?\1\s*,\s*(['"`])\d{4}-\d{2}(?:-\d{2})?\2\s*\]/,
  /from:\s*(['"`])\d{4}-\d{2}(?:-\d{2})?\1[^\n]*to:\s*(['"`])\d{4}-\d{2}(?:-\d{2})?\2/,
];
const SCHEDULE_MODULES = /require\([^)]*(?:\/schedule|\/splits|\/looks|\/run-gate|\/scorecard-look|\/ledger-file|\/promotion)['"]\)/;

function libFiles(dir = LIB) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return libFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

/** The stray window literals in one module's text: [why]. */
function strays(rel, text) {
  if (ALLOW.includes(rel)) return [];
  const src = code(text);
  const out = [];
  if (WINDOW.some(re => re.test(src))) out.push(`${rel}: a window-shaped date literal (windows are config/schedule.json's)`);
  if (SCHEDULE_MODULES.test(text) || /^scripts\/lib\/(learning|prop)\/(splits|looks)\.js$/.test(rel)) {
    const dates = src.match(DATE) || [];
    if (dates.length) out.push(`${rel}: date literal(s) ${[...new Set(dates)].join(', ')} in a module of the schedule's (read them from config/schedule.json)`);
  }
  return out;
}

test('no stray window literal in scripts/lib: the dates are the schedule\'s, and the schema is the only exception', () => {
  for (const a of ALLOW) assert.ok(fs.existsSync(path.join(ROOT, a)), `${a} exists`);
  const found = libFiles().flatMap(f => {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    return strays(rel, fs.readFileSync(f, 'utf8'));
  });
  assert.deepStrictEqual(found, []);
});

test('the stray-literal scan catches what it claims to (its mutations)', () => {
  const mod = "const s = require('../schedule');\n";
  assert.match(strays('scripts/lib/x.js', `${mod}const W = { test: ['2025-01-01', '2026-01-01'] };`).join(), /window-shaped/);
  assert.match(strays('scripts/lib/x.js', "const w = { from: '2025-01-01', to: '2026-01-01' };").join(), /window-shaped/, 'anywhere, schedule module or not');
  assert.match(strays('scripts/lib/x.js', `${mod}const START = '2021-04-01';`).join(), /date literal\(s\) '2021-04-01'/);
  assert.match(strays('scripts/lib/learning/splits.js', "const START = '2021-04';").join(), /date literal/);
  assert.match(strays('scripts/lib/x.js', "const s = require('./prop/splits');\nconst X = `2024-07-01`;").join(), /date literal/);
  assert.deepStrictEqual(strays('scripts/lib/x.js', `${mod}// a comment naming '2025-01-01'\n/* and '2026-01-01' */`), [], 'comments are no code');
  assert.deepStrictEqual(strays('scripts/lib/x.js', "const HOLIDAY = '2026-01-01';"), [], 'a calendar date outside the schedule\'s modules');
  assert.deepStrictEqual(strays('scripts/lib/schedule.js', `${mod}const W = ['2025-01-01', '2026-01-01'];`), [], 'the schema');
});

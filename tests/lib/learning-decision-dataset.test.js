'use strict';

// The verified-decision dataset (scripts/lib/learning/decision-dataset.js): correct decisions only, as byte-faithful
// chat JSONL; train from practice-train only, validate from practice-validate only, test and final refused; balanced
// by the spec, deduplicated, fingerprinted, two-step.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const DS = require('../../scripts/lib/learning/decision-dataset');
const { tmpDir } = require('../helpers');
const F = require('../fixtures/decision-run');

const ROOT = path.join(__dirname, '..', '..');
const REPO_SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', 'spec.json'), 'utf8'));
// The build tests' spec: the repository's, its balance loose enough for a small fixture (balance() is tested apart).
const SPEC = { ...REPO_SPEC, balance: { ...REPO_SPEC.balance, takeShare: [0.1, 0.9], maxSkillShare: 0.9, maxYearShare: 0.95, minYears: 1, minNearMllShare: 0.25 } };
const RULES = { minRR: 2, maxRiskUsd: 300 };
// The harness's digests now, as the fixture runs record theirs (F.DOCS: harness is the prompt digest).
const CURRENT = { skills: F.DOCS.skills, prompt: F.DOCS.harness, code: F.CODE };
const rec = skill => ({ ok: true, side: 'long', entry: 21000, stop: 20990, target: 21025, size: 5, tick: 0.25, tickValue: 0.5, reads: [{ step: 'setup', skill, check: true }] });
const ROOM = { status: 'active', cushion: 2500, dailyHeadroom: 600, softHeadroom: 400 };

/** A practice-train stage-1 run: two correct takes (one a loser), a winner with a false read, a correct pass, an unverifiable pass, a duplicate. */
function trainRun(home, { runId = 'train1', prompt = 'PROMPT-A  \r\né', documents = F.DOCS } = {}) {
  return F.writeRun(home, {
    runId, start: '2022-03-07T00:00:00Z', end: '2022-03-12T00:00:00Z', stage: 1, documents,
    decisions: [
      { t: '2022-03-07T14:33:00.000Z', kind: 'take', record: rec('fair-value-gaps'), prompt, headText: ['TAKE-A'], tasks: [{ role: 'risk-manager', prompt: 'RM-A', reply: 'APPROVED' }], R: 2.5 },
      { t: '2022-03-08T14:33:00.000Z', kind: 'take', record: rec('order-blocks'), prompt: 'PROMPT-LOSER', headText: ['TAKE-LOSER'], R: -1 },
      { t: '2022-03-08T15:33:00.000Z', kind: 'take', record: { ...rec('fair-value-gaps'), reads: [{ step: 'setup', skill: 'fair-value-gaps', check: false }] }, prompt: 'PROMPT-WRONG-WINNER', headText: ['TAKE-WRONG'], R: 4 },
      { t: '2022-03-09T14:33:00.000Z', kind: 'pass', composed: [{ symbol: 'MNQ', ok: false, reads: [] }], prompt: 'PROMPT-PASS', headText: ['PASS-NO-SETUP'] },
      { t: '2022-03-09T15:33:00.000Z', kind: 'pass', prompt: 'PROMPT-UNVERIFIED', headText: ['PASS-UNKNOWN'] },
      // The same prompt and response as the first decision's head turn: one example, not two.
      { t: '2022-03-10T14:33:00.000Z', kind: 'take', record: rec('liquidity-sweeps'), prompt, headText: ['TAKE-A'], tasks: [{ role: 'risk-manager', prompt: 'RM-A', reply: 'APPROVED' }] },
    ],
  });
}

/** A practice-train stage-2 run: near the max loss limit and mid states. */
const TRAIN_OPTS = (runId, prompt) => ({
  runId, start: '2022-03-07T00:00:00Z', end: '2022-03-12T00:00:00Z', stage: 1,
  decisions: [{ t: '2022-03-07T14:33:00.000Z', kind: 'take', record: rec('fair-value-gaps'), prompt, headText: [prompt] }],
});

function stage2Run(home) {
  return F.writeRun(home, {
    runId: 'train2', start: '2022-04-04T00:00:00Z', end: '2022-04-09T00:00:00Z', stage: 2,
    states: [{ day: '2022-04-04', bucket: 'near-mll', weight: 0.3 }, { day: '2022-04-05', bucket: 'mid', weight: 1.2 }],
    decisions: [
      // Near the max loss limit with the soft daily stop reached: the account alone calls for standing down (a pass is
      // never judged by the risk of a plan it didn't take).
      { t: '2022-04-04T14:33:00.000Z', kind: 'pass', record: rec('fair-value-gaps'), attempt: { ...ROOM, cushion: 80, softHeadroom: 0 }, prompt: 'S2-NEAR-STANDDOWN', headText: ['STAND-DOWN'] },
      { t: '2022-04-04T15:33:00.000Z', kind: 'take', record: rec('order-blocks'), attempt: { ...ROOM, cushion: 2000 }, prompt: 'S2-NEAR-TAKE', headText: ['S2-TAKE-NEAR'] },
      { t: '2022-04-05T14:33:00.000Z', kind: 'take', record: rec('fair-value-gaps'), attempt: ROOM, prompt: 'S2-MID-TAKE', headText: ['S2-TAKE-MID'] },
      { t: '2022-04-05T15:33:00.000Z', kind: 'take', record: rec('fair-value-gaps'), attempt: { ...ROOM, entryBlock: 'loss streak stop' }, prompt: 'S2-BLOCKED', headText: ['S2-TAKE-BLOCKED'] },
    ],
  });
}

function validateRun(home) {
  return F.writeRun(home, {
    runId: 'val1', start: '2024-08-05T00:00:00Z', end: '2024-08-10T00:00:00Z', stage: 1,
    decisions: [{ t: '2024-08-05T14:33:00.000Z', kind: 'take', record: rec('fair-value-gaps'), prompt: 'VAL-PROMPT', headText: ['VAL-TAKE'] }],
  });
}

const sourceOf = r => DS.sourceFromRun(r.runDir, { score: r.score });
const lines = text => text.split('\n').filter(Boolean).map(l => JSON.parse(l));

function buildAll(over = {}) {
  const home = tmpDir();
  const t1 = trainRun(path.join(home, 'a'), over);
  const t2 = stage2Run(path.join(home, 'b'));
  const v = validateRun(path.join(home, 'c'));
  return DS.buildDataset({ train: [sourceOf(t1), sourceOf(t2)], validate: [sourceOf(v)], spec: SPEC, rules: RULES, current: CURRENT });
}

test('only correct decisions are written, as the exact prompts and responses (byte-faithful), tagged by stage', () => {
  const { files, dataset } = buildAll();
  const step1 = lines(files['step1/train.jsonl']);
  const all = JSON.stringify(files);
  // The losing-but-correct trade is in; the winning-but-wrong one, the unverifiable pass and the blocked stage-2 take are not.
  assert.ok(all.includes('TAKE-LOSER') && all.includes('PASS-NO-SETUP') && all.includes('STAND-DOWN') && all.includes('S2-TAKE-NEAR'));
  for (const gone of ['TAKE-WRONG', 'PASS-UNKNOWN', 'S2-TAKE-BLOCKED']) assert.ok(!all.includes(gone), gone);
  // Byte-faithful: the prompt and the system prompt as recorded.
  const head = step1.find(x => x.messages.some(m => m.content === 'TAKE-A'));
  assert.deepStrictEqual(head.messages.slice(0, 2), [{ role: 'system', content: F.SYSTEM['fth-head-trader'] }, { role: 'user', content: 'PROMPT-A  \r\né' }]);
  assert.deepStrictEqual(head.messages.slice(2).map(m => m.role), ['assistant', 'tool', 'assistant'], 'its risk-manager task call and result, then its text');
  assert.strictEqual(head.messages[3].content, '<task id="ses_c" state="completed">\n<task_result>\nAPPROVED\n</task_result>\n</task>');
  assert.deepStrictEqual(head.messages[4], { role: 'assistant', content: 'TAKE-A' });
  // The head trader's turns only by default: no subagent example (its claims are unchecked).
  assert.ok(lines(files['meta.jsonl']).every(m => m.role === 'fth-head-trader' && m.subagent === false));
  assert.ok(!step1.some(x => x.messages[x.messages.length - 1].content === 'APPROVED'));
  assert.ok(step1.every(x => Object.keys(x).length === 1 && Array.isArray(x.messages)), 'model-agnostic chat lines: messages only');
  // Labels counted, nothing correct-by-outcome.
  assert.deepStrictEqual(dataset.labels.train, { correct: 7, incorrect: 2, unverifiable: 1 });
  assert.strictEqual(dataset.duplicates.train, 1, 'the repeated head turn');
  // Stage tags: step1 holds stage 1 only; step2 its stage-2 examples plus the spec's slice of stage 1.
  const meta = lines(files['meta.jsonl']);
  assert.ok(meta.filter(m => m.file === 'step1/train.jsonl').every(m => m.stage === 1));
  const s2 = meta.filter(m => m.file === 'step2/train.jsonl');
  assert.strictEqual(s2.filter(m => m.stage === 2).length, 3);
  assert.strictEqual(s2.filter(m => m.stage === 1).length, Math.round((3 * 0.2) / 0.8), 'mixStage1 0.2: one stage-1 example per four');
  assert.deepStrictEqual(dataset.counts.step1, { train: step1.length, valid: 1 });
  assert.ok(lines(files['step1/valid.jsonl'])[0].messages.some(m => m.content === 'VAL-PROMPT'));
  assert.ok(meta.find(m => m.decision.accountState === 'near-mll'));
  assert.deepStrictEqual(dataset.harness, { ...F.DOCS, code: F.CODE });
  assert.deepStrictEqual([dataset.v, dataset.exitPlan, dataset.roles], [2, F.EXIT.hash, ['fth-head-trader']]);
  assert.deepStrictEqual(dataset.sources.map(s => [s.set, s.runId]), [['train', 'train1'], ['train', 'train2'], ['validate', 'val1']]);
});

test('the fingerprint: the same sources give the same bytes; another prompt byte another fingerprint; a changed file is refused', () => {
  const a = buildAll();
  const b = buildAll();
  assert.strictEqual(a.dataset.fingerprint, b.dataset.fingerprint);
  assert.deepStrictEqual(a.files, b.files);
  assert.match(a.dataset.fingerprint, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(buildAll({ prompt: 'PROMPT-A  \né' }).dataset.fingerprint, a.dataset.fingerprint, 'one byte of one prompt');
  assert.strictEqual(DS.fingerprintOf(a.files), a.dataset.fingerprint);
  const dir = path.join(tmpDir(), 'ds');
  DS.writeDataset(dir, a);
  assert.strictEqual(DS.readDataset(dir).fingerprint, a.dataset.fingerprint);
  assert.throws(() => DS.writeDataset(dir, a), /already holds a dataset/);
  fs.appendFileSync(path.join(dir, 'step1', 'train.jsonl'), '{"messages":[]}\n');
  assert.throws(() => DS.readDataset(dir), /don't match its fingerprint/);
});

test('splits: train only from practice-train, validate only from practice-validate; test and final refused', () => {
  const home = tmpDir();
  const t = sourceOf(trainRun(path.join(home, 'a')));
  const v = sourceOf(validateRun(path.join(home, 'c')));
  const build = (train, validate = []) => DS.buildDataset({ train, validate, spec: SPEC, rules: RULES, current: CURRENT });
  assert.throws(() => build([v]), /run val1 refused for the train set: practice refused: .*practice-validate/);
  assert.throws(() => build([t], [t]), /run train1 refused for the validate set/);
  const sealed = (start, end) => ({ ...t, start, end });
  assert.throws(() => build([sealed('2025-03-03T00:00:00Z', '2025-03-08T00:00:00Z')]), /refused for the train set: .*test \(sealed/);
  assert.throws(() => build([t], [sealed('2026-03-02T00:00:00Z', '2026-03-07T00:00:00Z')]), /refused for the validate set: .*final/);
  assert.throws(() => build([sealed('2024-06-24T00:00:00Z', '2024-07-03T00:00:00Z')]), /practice-validate/, 'a window reaching into practice-validate');
  // A decision outside its source's window (a record that lies about its day) is refused too.
  const liar = { ...t, decisions: [...t.decisions, { ...t.decisions[0], key: 'late', day: '2025-01-06' }] };
  assert.throws(() => build([liar]), /outside the train set's window/);
  assert.throws(() => build([]), /no train sources/);
});

test('the digest: only examples made under the harness\'s skills and prompt digest now; the stale dropped and counted; others only by name, marked', () => {
  const home = tmpDir();
  const a = sourceOf(trainRun(path.join(home, 'a')));
  const OLD = { ...F.DOCS, skills: 'c'.repeat(64) };
  const b = sourceOf(trainRun(path.join(home, 'b'), { runId: 'train9', prompt: 'OLD-WORDING', documents: OLD }));
  assert.ok(a.decisions.every(d => d.digest.skills === CURRENT.skills && d.digest.prompt === CURRENT.prompt), 'each decision records its digest');
  const kept = DS.buildDataset({ train: [a, b], spec: SPEC, rules: RULES, current: CURRENT });
  assert.ok(!JSON.stringify(kept.files).includes('OLD-WORDING'), 'made under old skills: dropped');
  assert.ok(kept.dataset.digests.stale.train > 0, 'and counted');
  assert.strictEqual(kept.dataset.digests.stale.train, DS.buildDataset({ train: [b, a], spec: SPEC, rules: RULES, current: CURRENT }).dataset.digests.stale.train);
  assert.deepStrictEqual(kept.dataset.harness, { ...F.DOCS, code: F.CODE });
  assert.ok(lines(kept.files['meta.jsonl']).every(m => m.digest.current === true && m.digest.skills === CURRENT.skills));
  // Included by name ('any' or a prefix): kept, and marked as another digest's.
  for (const include of [['any'], ['cccccccc']]) {
    const inc = DS.buildDataset({ train: [a, b], spec: SPEC, rules: RULES, current: CURRENT, include });
    const meta = lines(inc.files['meta.jsonl']);
    assert.ok(JSON.stringify(inc.files).includes('OLD-WORDING'), include.join());
    assert.ok(meta.some(m => m.digest.current === false && m.digest.skills === OLD.skills));
    assert.ok(inc.dataset.digests.included.train > 0);
    assert.strictEqual(inc.dataset.digests.stale.train, 0);
  }
  assert.strictEqual(DS.digestStatus(null, CURRENT, ['cccccccc']), 'stale', 'no digest: only \'any\' includes it');
  assert.strictEqual(DS.digestStatus(null, CURRENT, ['any']), 'included');
  assert.throws(() => DS.buildDataset({ train: [a], spec: SPEC, rules: RULES, current: CURRENT, include: ['abc'] }), /hex digest prefix of 8/);
  assert.throws(() => DS.buildDataset({ train: [b], spec: SPEC, rules: RULES, current: CURRENT }), /every correct train decision was made under another skills or prompt digest/);
  assert.throws(() => DS.buildDataset({ train: [a], spec: SPEC, rules: RULES }), /current: the harness's skills, prompt and code digests/);
  assert.throws(() => DS.buildDataset({ train: [a], spec: { ...SPEC, steps: [] }, rules: RULES, current: CURRENT }), /spec is invalid/);
});

test('a cycle that decided wrongly on one symbol gives no example for its other symbol (one prompt speaks for both)', () => {
  const home = tmpDir();
  const src = sourceOf(trainRun(path.join(home, 'a')));
  const [first, , wrong] = src.decisions;
  assert.ok(first.cycle && wrong.cycle, 'decisions name their cycle');
  // The wrong-winner's decision recorded in the first decision's cycle, as another symbol of it.
  // (Without the last decision, whose head turn repeats the first's.)
  const shared = { ...src, decisions: src.decisions.slice(0, -1).map(d => (d === wrong ? { ...d, key: `${first.t}|MES`, cycle: first.cycle } : d)) };
  const built = DS.buildDataset({ train: [shared], spec: SPEC, rules: RULES, current: CURRENT });
  const text = JSON.stringify(built.files);
  assert.ok(!text.includes('RM-A'), 'the shared cycle\'s turns are out');
  assert.ok(text.includes('TAKE-LOSER'), 'other cycles are not');
});

test('only correct decisions, even without a cycle to group them by', () => {
  const src = sourceOf(trainRun(path.join(tmpDir(), 'a')));
  const loose = { ...src, decisions: src.decisions.map(d => ({ ...d, cycle: null })) };
  const text = JSON.stringify(DS.buildDataset({ train: [loose], spec: SPEC, rules: RULES, current: CURRENT }).files);
  for (const gone of ['TAKE-WRONG', 'PASS-UNKNOWN']) assert.ok(!text.includes(gone), gone);
  assert.ok(text.includes('TAKE-LOSER'));
});

test('dedupe: the first of identical examples is kept, by the id of its exact messages', () => {
  const m = [{ role: 'user', content: 'a' }];
  const ex = DS.examplesOf({ turns: [{ role: 'fth-head-trader', faithful: true, messages: m }, { role: 'fth-head-trader', faithful: false, messages: null }] });
  assert.strictEqual(ex.length, 1);
  const { kept, dropped } = DS.dedupe([{ id: '1', n: 1 }, { id: '2' }, { id: '1', n: 2 }]);
  assert.deepStrictEqual([kept.map(x => x.n || x.id), dropped.length], [[1, '2'], 1]);
  assert.strictEqual(DS.examplesOf({ turns: [{ role: 'fth-head-trader', faithful: true, messages: [{ role: 'user', content: 'a ' }] }] })[0].id === ex[0].id, false, 'one trailing space is another example');
});

const D = (n, over) => Array.from({ length: n }, (_, i) => ({ uid: `${over.kind}-${over.skill}-${over.year}-${over.accountState || ''}-${i}`, ...over }));
const RB = { seed: 1, takeShare: [0.3, 0.7], maxSkillShare: 0.5, maxYearShare: 0.6, minYears: 2, minNearMllShare: 0.25 };
const share = (xs, f) => xs.filter(f).length / xs.length;

test('balance: takes against passes, skills and years within the spec, by dropping seeded draws (never repeating one)', () => {
  const input = [...D(30, { kind: 'take', skill: 'a', year: '2021' }), ...D(10, { kind: 'take', skill: 'b', year: '2022' }), ...D(10, { kind: 'pass', skill: 'none', year: '2022' }), ...D(6, { kind: 'pass', skill: 'c', year: '2023' })];
  const { kept, dropped, report } = DS.balance(input, RB);
  const tp = kept.filter(d => d.kind !== 'risk');
  assert.ok(share(tp, d => d.kind === 'take') <= 0.7 + 1e-9 && share(tp, d => d.kind === 'take') >= 0.3 - 1e-9);
  for (const s of ['a', 'b', 'none', 'c']) assert.ok(share(kept, d => d.skill === s) <= 0.5 + 1e-9, s);
  for (const y of ['2021', '2022', '2023']) assert.ok(share(kept, d => d.year === y) <= 0.6 + 1e-9, y);
  assert.strictEqual(new Set(kept).size, kept.length, 'no decision twice');
  assert.ok(kept.every(d => input.includes(d)));
  assert.strictEqual(kept.length + dropped.length, input.length);
  assert.strictEqual(report.before.n, input.length);
  // Deterministic for a seed; the draws follow the seed.
  assert.deepStrictEqual(DS.balance(input, RB).kept.map(d => d.uid), kept.map(d => d.uid));
  assert.notDeepStrictEqual(DS.balance(input, { ...RB, seed: 2 }).kept.map(d => d.uid).sort(), kept.map(d => d.uid).sort());
  // Already balanced: nothing dropped.
  const fine = [...D(3, { kind: 'take', skill: 'a', year: '2021' }), ...D(3, { kind: 'pass', skill: 'b', year: '2022' })];
  assert.strictEqual(DS.balance(fine, RB).dropped.length, 0);
});

test('balance: stage 2 keeps the states near the max loss limit well represented', () => {
  const input = [...D(4, { kind: 'take', skill: 'a', year: '2021', accountState: 'near-mll' }), ...D(4, { kind: 'pass', skill: 'b', year: '2022', accountState: 'near-mll' }),
    ...D(20, { kind: 'take', skill: 'a', year: '2022', accountState: 'mid' }), ...D(20, { kind: 'pass', skill: 'b', year: '2021', accountState: 'fresh' })];
  const { kept, report } = DS.balance(input, RB, { stage: 2 });
  assert.ok(share(kept, d => d.accountState === 'near-mll') >= 0.25 - 1e-9, JSON.stringify(report.after));
  const kept8 = kept.filter(d => d.accountState === 'near-mll').length / 8;
  const keptOthers = kept.filter(d => d.accountState !== 'near-mll').length / 40;
  assert.ok(kept8 > keptOthers, `the near-limit states kept at a higher rate (${kept8} vs ${keptOthers})`);
  assert.ok(report.after.accountState);
});

test('balance: a constraint that can\'t be met refuses, never writes a skewed set', () => {
  assert.throws(() => DS.balance(D(10, { kind: 'take', skill: 'a', year: '2021' }), RB), /takes and passes both needed/);
  assert.throws(() => DS.balance([...D(3, { kind: 'take', skill: 'a', year: '2021' }), ...D(3, { kind: 'pass', skill: 'b', year: '2021' })], RB), /1 year\(s\), under 2/);
  const noNear = [...D(3, { kind: 'take', skill: 'a', year: '2021', accountState: 'mid' }), ...D(3, { kind: 'pass', skill: 'b', year: '2022', accountState: 'mid' })];
  assert.throws(() => DS.balance(noNear, RB, { stage: 2 }), /near the max loss limit at 0/);
  assert.doesNotThrow(() => DS.balance(noNear, RB, { stage: 1 }), 'stage 1 has no account state');
});

test('the repository\'s spec builds on a fixture that meets it', () => {
  const home = tmpDir();
  const decisions = [];
  const skills = ['fair-value-gaps', 'order-blocks', 'liquidity-sweeps'];
  for (const [y, day] of [['2021', '2021-06-0'], ['2022', '2022-06-0'], ['2023', '2023-06-0']]) {
    skills.forEach((s, i) => decisions.push({ t: `${day}${7 + i}T14:33:00.000Z`, kind: 'take', record: rec(s), prompt: `T-${y}-${s}`, headText: [`take ${y} ${s}`] }));
    for (let i = 0; i < 2; i += 1) decisions.push({ t: `${day}${7 + i}T15:33:00.000Z`, kind: 'pass', composed: [{ symbol: 'MNQ', ok: false, reads: [{ step: 'setup', skill: skills[i], check: false }] }], prompt: `P-${y}-${i}`, headText: [`pass ${y} ${i}`] });
  }
  const r = F.writeRun(home, { start: '2021-06-01T00:00:00Z', end: '2023-07-01T00:00:00Z', stage: 1, decisions });
  const built = DS.buildDataset({ train: [sourceOf(r)], spec: REPO_SPEC, rules: RULES, current: CURRENT });
  assert.ok(built.dataset.counts.step1.train > 0);
  assert.strictEqual(built.dataset.counts.step2.train, 0, 'no stage-2 data: step 2 waits for it');
});

test('roles: a subagent\'s turns only when named, marked in meta.jsonl; the head trader always', () => {
  const home = tmpDir();
  const src = sourceOf(trainRun(path.join(home, 'a')));
  const named = DS.buildDataset({ train: [src], spec: SPEC, rules: RULES, current: CURRENT, roles: ['fth-head-trader', 'risk-manager'] });
  const meta = lines(named.files['meta.jsonl']);
  assert.ok(meta.some(m => m.role === 'risk-manager' && m.subagent === true));
  assert.ok(lines(named.files['step1/train.jsonl']).some(x => x.messages[x.messages.length - 1].content === 'APPROVED'));
  assert.ok(lines(DS.buildDataset({ train: [src], spec: SPEC, rules: RULES, current: CURRENT, roles: ['fth-head-trader', 'all'] }).files['meta.jsonl']).some(m => m.subagent));
  assert.throws(() => DS.buildDataset({ train: [src], spec: SPEC, rules: RULES, current: CURRENT, roles: ['risk-manager'] }), /roles: the head trader/);
});

test('the code digest and the exit plan: a code change marks examples stale; two exit plans are never mixed; no exit record dropped', () => {
  const home = tmpDir();
  const a = sourceOf(trainRun(path.join(home, 'a')));
  const oldCode = sourceOf(F.writeRun(path.join(home, 'b'), { ...TRAIN_OPTS('train8', 'OLD-CODE'), code: 'e'.repeat(64) }));
  const built = DS.buildDataset({ train: [a, oldCode], spec: SPEC, rules: RULES, current: CURRENT });
  assert.ok(!JSON.stringify(built.files).includes('OLD-CODE'), 'made under other code: stale');
  assert.ok(built.dataset.digests.stale.train > 0);
  assert.ok(lines(built.files['meta.jsonl']).every(m => m.digest.code === F.CODE && m.digest.exitPlan === F.EXIT.hash));
  assert.ok(JSON.stringify(DS.buildDataset({ train: [a, oldCode], spec: SPEC, rules: RULES, current: CURRENT, include: ['eeeeeeee'] }).files).includes('OLD-CODE'), 'included by its code digest');
  // A run whose code changed mid-run holds no code digest: stale.
  assert.strictEqual(DS.digestStatus({ skills: CURRENT.skills, prompt: CURRENT.prompt, code: null }, CURRENT), 'stale');
  const { exitRecord } = require('../../scripts/lib/learning/experience-log');
  const trail = exitRecord({ mode: 'trail', plan: { trailR: 1 } });
  const other = sourceOf(F.writeRun(path.join(home, 'c'), { ...TRAIN_OPTS('train7', 'TRAIL-EXIT'), exit: trail }));
  assert.throws(() => DS.buildDataset({ train: [a, other], spec: SPEC, rules: RULES, current: CURRENT }), /made under 2 exit plans/);
  const none = sourceOf(F.writeRun(path.join(home, 'd'), { ...TRAIN_OPTS('train6', 'NO-EXIT'), exit: null }));
  const dropped = DS.buildDataset({ train: [a, none], spec: SPEC, rules: RULES, current: CURRENT });
  assert.ok(!JSON.stringify(dropped.files).includes('NO-EXIT'));
  assert.ok(dropped.dataset.untaggedExit.train.decisions > 0);
});

test('validSetups: correct takes against correct passes on valid setups are counted (the labeller\'s lean)', () => {
  const { dataset } = buildAll();
  assert.deepStrictEqual(dataset.validSetups.train, { correctTakes: 5, correctPasses: 1 }, 'stage 1 takes and stage 2 takes; the stand-down pass');
});

test('repeated samples: every repeat of a moment answering the same is counted and warned, refused past half', () => {
  const home = tmpDir();
  const src = sourceOf(trainRun(path.join(home, 'a')));
  const resp = text => [{ role: 'fth-head-trader', faithful: true, messages: [{ role: 'user', content: 'p' }, { role: 'assistant', content: text }] }];
  const sampled = (t, texts) => texts.map((x, repeat) => ({ ...src.decisions[0], key: `${t}|${repeat}`, sample: { t, repeat }, turns: resp(x) }));
  const r = DS.repeatedSamples([{ runId: 'r', decisions: [...sampled('m1', ['a', 'a', 'a']), ...sampled('m2', ['a', 'b', 'a']), ...sampled('m3', ['x', 'x'])] }]);
  assert.deepStrictEqual(r, { moments: 3, identical: 2, times: ['r|m1', 'r|m3'] });
  const base = { ...src, decisions: [...src.decisions, ...sampled('m1', ['a', 'a']), ...sampled('m2', ['a', 'b'])] };
  const ok = DS.buildDataset({ train: [base], spec: SPEC, rules: RULES, current: CURRENT });
  assert.deepStrictEqual(ok.dataset.repeatedSamples, { moments: 2, identical: 1, times: ['train1|m1'] }, 'half: recorded, not refused');
  const most = { ...src, decisions: [...src.decisions, ...sampled('m1', ['a', 'a']), ...sampled('m2', ['b', 'b']), ...sampled('m3', ['c', 'd'])] };
  assert.throws(() => DS.buildDataset({ train: [most], spec: SPEC, rules: RULES, current: CURRENT }), /2 of 3 sampled moments answered identically/);
});

test('the format version: a v1 dataset is refused on read; the spec must name the builder\'s version', () => {
  const a = buildAll();
  const dir = path.join(tmpDir(), 'ds');
  DS.writeDataset(dir, { ...a, dataset: { ...a.dataset, v: 1 } });
  assert.throws(() => DS.readDataset(dir), /a format v1 dataset/);
  assert.throws(() => DS.buildDataset({ train: [], spec: { ...SPEC, dataset: { ...SPEC.dataset, version: 1 } }, rules: RULES, current: CURRENT }), /dataset\.version/);
});

test('examplesOf: the head trader\'s turns by default; the fingerprint names the format; a run whose code changed mid-run has no code digest', () => {
  const head = { role: 'fth-head-trader', faithful: true, messages: [{ role: 'user', content: 'h' }] };
  const sub = { role: 'risk-manager', faithful: true, messages: [{ role: 'user', content: 's' }] };
  assert.deepStrictEqual(DS.examplesOf({ turns: [head, sub] }).map(x => x.role), ['fth-head-trader']);
  assert.deepStrictEqual(DS.examplesOf({ turns: [head, sub] }, ['fth-head-trader', 'risk-manager']).map(x => [x.role, x.subagent]), [['fth-head-trader', false], ['risk-manager', true]]);
  // A format-1 fingerprint (the files alone) is never a format-2 one.
  const files = { 'step1/train.jsonl': 'x\n' };
  const legacy = require('crypto').createHash('sha256');
  for (const name of DS.DATA_FILES) legacy.update(`${name}\0${files[name] || ''}\0`);
  assert.notStrictEqual(DS.fingerprintOf(files), legacy.digest('hex'));
  const r = trainRun(path.join(tmpDir(), 'a'));
  const setupFile = path.join(r.runDir, 'setup.json');
  fs.writeFileSync(setupFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(setupFile, 'utf8')), codeChanged: true }));
  assert.ok(sourceOf(r).decisions.every(d => d.digest.code === null));
});

// --- The head trader's machine-local delivery keys (autotrader.js HEAD_DELIVERY_KEYS): never pooled.
const { HEAD_DELIVERY_KEYS } = require('../../scripts/lib/autotrader');
/** A run's delivery keys, as its setup record's config (cfg.<key>, JSON values) or its runner config (autotrader.json) holds them. */
function withDelivery(r, keys, { via = 'setup' } = {}) {
  if (via === 'setup') {
    const f = path.join(r.runDir, 'setup.json');
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), config: Object.fromEntries(Object.entries(keys).map(([k, v]) => [`cfg.${k}`, JSON.stringify(v)])) }));
  } else fs.writeFileSync(path.join(r.runDir, 'autotrader.json'), JSON.stringify({ timeframe: 3, ...keys }));
  return r;
}
const build3 = (t1, t2, v) => DS.buildDataset({ train: [sourceOf(t1), sourceOf(t2)], validate: [sourceOf(v)], spec: SPEC, rules: RULES, current: CURRENT });
function runs(home = tmpDir()) {
  return { t1: trainRun(path.join(home, 'a')), t2: stage2Run(path.join(home, 'b')), v: validateRun(path.join(home, 'c')) };
}

test('delivery keys absent (or false): the digest, the files and dataset.json exactly as before the keys existed', () => {
  // Captured from the base branch's builder for this fixture (buildAll), before the delivery keys were read.
  const a = buildAll();
  assert.strictEqual(a.dataset.fingerprint, 'a5b0bc194d1dd06b07c3bd7455795c0057db239d1db7ec10d0e2cb7aa5496f12');
  assert.ok(!('delivery' in a.dataset));
  assert.ok(lines(a.files['meta.jsonl']).every(m => !('delivery' in m.digest)));
  assert.ok(sourceOf(trainRun(path.join(tmpDir(), 'a'))).decisions.every(d => !('delivery' in d.digest)));
  // False, or a runner config without them: the same bytes.
  const r = runs();
  withDelivery(r.t1, { headSkillsInPrompt: false, cycleDataInPrompt: false });
  withDelivery(r.t2, { cycleDataInPrompt: false }, { via: 'runner' });
  const b = build3(r.t1, r.t2, r.v);
  assert.deepStrictEqual(b.files, a.files);
  assert.strictEqual(b.dataset.fingerprint, a.dataset.fingerprint);
});

// A delivery key's "on" value (a mode key: its first mode, autotrader.js HEAD_DELIVERY_MODES) and its name in a delivery.
const { HEAD_DELIVERY_MODES, ENTRY_SKILLS_MODES } = require('../../scripts/lib/autotrader');
const onValue = k => (HEAD_DELIVERY_MODES.includes(k) ? ENTRY_SKILLS_MODES[0] : true);
const named = k => (HEAD_DELIVERY_MODES.includes(k) ? `${k}=${onValue(k)}` : k);

test('a delivery key on: the decisions\' digest names it, the dataset is another one; read from the setup record or the runner config', () => {
  const base = buildAll();
  for (const k of HEAD_DELIVERY_KEYS) {
    for (const via of ['setup', 'runner']) {
      const r = runs();
      for (const x of [r.t1, r.t2, r.v]) withDelivery(x, { [k]: onValue(k) }, { via });
      assert.ok(sourceOf(r.t1).decisions.every(d => d.digest.delivery === named(k)), `${k} via ${via}`);
      const on = build3(r.t1, r.t2, r.v);
      assert.notStrictEqual(on.dataset.fingerprint, base.dataset.fingerprint, `${k} via ${via}`);
      assert.strictEqual(on.dataset.delivery, named(k));
      assert.ok(lines(on.files['meta.jsonl']).every(m => m.digest.delivery === named(k)));
    }
  }
  // Every one: in the list's order, one delivery (a mode key with its mode).
  assert.strictEqual(DS.deliveryOf({ config: Object.fromEntries(HEAD_DELIVERY_KEYS.map(k => [`cfg.${k}`, JSON.stringify(onValue(k))])) }, null), HEAD_DELIVERY_KEYS.map(named).join(','));
  assert.strictEqual(DS.deliveryOf({ config: { 'cfg.cycleDataInPrompt': 'true', 'cfg.headSkillsInPrompt': 'true' } }, null), 'headSkillsInPrompt,cycleDataInPrompt');
  assert.strictEqual(DS.deliveryOf(null, { headSkillsInPrompt: true, headEntrySkills: 'lookup' }), 'headSkillsInPrompt,headEntrySkills=lookup');
  assert.strictEqual(DS.deliveryOf(null, { cycleDataInPrompt: true }), 'cycleDataInPrompt');
  assert.strictEqual(DS.deliveryOf({ config: { 'cfg.cycleDataInPrompt': 'false' } }, { headSkillsInPrompt: false }), null);
  assert.strictEqual(DS.deliveryOf(null, null), null);
});

test('a mixed pool (decisions made with a delivery key on and without it) is refused, in a set or across train and validate', () => {
  const r = runs();
  withDelivery(r.t2, { cycleDataInPrompt: true });
  assert.throws(() => build3(r.t1, r.t2, r.v), /made under 2 head trader deliveries \(none \| cycleDataInPrompt; the runner config's headSkillsInPrompt, cycleDataInPrompt, headEntrySkills\): build from runs under one/);
  const r2 = runs();
  withDelivery(r2.v, { headSkillsInPrompt: true }, { via: 'runner' });
  assert.throws(() => build3(r2.t1, r2.t2, r2.v), /2 head trader deliveries/);
  // Two keys against one: another delivery, refused too.
  const r3 = runs();
  for (const x of [r3.t1, r3.t2]) withDelivery(x, { cycleDataInPrompt: true, headSkillsInPrompt: true });
  withDelivery(r3.v, { cycleDataInPrompt: true });
  assert.throws(() => build3(r3.t1, r3.t2, r3.v), /2 head trader deliveries/);
  // The entry skills looked up (headEntrySkills) against embedded (absent): refused, the mode named.
  const r4 = runs();
  for (const x of [r4.t1, r4.t2]) withDelivery(x, { headSkillsInPrompt: true, headEntrySkills: 'lookup' });
  withDelivery(r4.v, { headSkillsInPrompt: true });
  assert.throws(() => build3(r4.t1, r4.t2, r4.v), /2 head trader deliveries \(headSkillsInPrompt,headEntrySkills=lookup \| headSkillsInPrompt|2 head trader deliveries \(headSkillsInPrompt \| headSkillsInPrompt,headEntrySkills=lookup/);
});

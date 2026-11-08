'use strict';

// The moment probe (scripts/lib/eval/moment-probe.js): a skill fix is checked in minutes by re-asking the model about
// recorded moments whose answer is known, once under the old skills and once under the new (owner rule, 2026-11-07).
// Nothing here calls a model: `ask` is injected. A moment is a recorded cycle (its prompt, its result line, its set).

const test = require('node:test');
const assert = require('node:assert');
const P = require('../../scripts/lib/eval/moment-probe');

const skill = (name, body) => `<skill name="${name}">\n${body}\n</skill>`;
const PROMPT = `Autonomous cycle.\n\n${skill('breakout-vs-fakeout', 'OLD sweep text')}\n\n${skill('candle-reading', 'candle text')}\n\nBriefing: m3.sweeps = []`;

test('swapSkills: a skill block takes the new tree\'s body; other blocks and the briefing are untouched', () => {
  const body = n => (n === 'breakout-vs-fakeout' ? '  NEW sweep text\n' : null);
  const { prompt, swapped } = P.swapSkills(PROMPT, body);
  assert.deepStrictEqual(swapped, ['breakout-vs-fakeout']);
  assert.ok(prompt.includes(skill('breakout-vs-fakeout', 'NEW sweep text')), 'the body is trimmed like a lookup returns it');
  assert.ok(!prompt.includes('OLD sweep text'));
  assert.ok(prompt.includes(skill('candle-reading', 'candle text')) && prompt.endsWith('Briefing: m3.sweeps = []'));
});

test('swapSkills: a body equal to the recorded one is not a swap; a skill the prompt lacks is not added', () => {
  assert.deepStrictEqual(P.swapSkills(PROMPT, n => (n === 'candle-reading' ? 'candle text' : null)).swapped, []);
  const { prompt, swapped } = P.swapSkills(PROMPT, n => (n === 'cisd' ? 'x' : null));
  assert.deepStrictEqual(swapped, []);
  assert.strictEqual(prompt, PROMPT);
});

test('outcomeOf: the model\'s last CYCLE RESULT outcome; none when it reported none or a template', () => {
  assert.strictEqual(P.outcomeOf('thinking...\nCYCLE RESULT: no-trade - sweep unconfirmed'), 'no-trade');
  assert.strictEqual(P.outcomeOf('CYCLE RESULT: no-trade - a\nCYCLE RESULT: planned - long 3 MNQ'), 'planned');
  assert.strictEqual(P.outcomeOf('**CYCLE RESULT: executed - filled**'), 'executed');
  assert.strictEqual(P.outcomeOf('CYCLE RESULT: <no-trade | planned> - <reason>'), null);
  assert.strictEqual(P.outcomeOf('I could not decide'), null);
  assert.strictEqual(P.outcomeOf(''), null);
});

test('enters: planned and executed enter; every other outcome, and none, does not', () => {
  for (const o of ['planned', 'executed']) assert.strictEqual(P.enters(o), true);
  for (const o of ['no-trade', 'managed', 'flattened', 'blocked', 'error', null]) assert.strictEqual(P.enters(o), false);
});

const moment = (id, set, want, extra = {}) => ({ id, set, want, ...extra });

test('judge: a "change" moment is right when the new outcome is the wanted one; a "hold" moment must not flip', () => {
  // change: the early entry that lost should now wait (want no-trade)
  assert.strictEqual(P.judge(moment('m1', 'change', 'no-trade'), 'planned', 'no-trade').verdict, 'fixed');
  assert.strictEqual(P.judge(moment('m1', 'change', 'no-trade'), 'planned', 'planned').verdict, 'unchanged');
  assert.strictEqual(P.judge(moment('m1', 'change', 'no-trade'), 'no-trade', 'no-trade').verdict, 'already');
  assert.strictEqual(P.judge(moment('m1', 'change', 'no-trade'), 'no-trade', 'planned').verdict, 'broke');
  // hold: the entry that banked R must not flip
  assert.strictEqual(P.judge(moment('m2', 'hold', 'planned'), 'planned', 'planned').verdict, 'held');
  assert.strictEqual(P.judge(moment('m2', 'hold', 'planned'), 'planned', 'no-trade').verdict, 'broke');
  // an answer the model never gave is never a pass
  assert.strictEqual(P.judge(moment('m3', 'hold', 'planned'), 'planned', null).verdict, 'unanswered');
  assert.strictEqual(P.judge(moment('m3', 'change', 'no-trade'), null, 'no-trade').verdict, 'unanswered');
});

test('judge: a hold moment compares entering, not the exact outcome (planned vs executed is no flip)', () => {
  assert.strictEqual(P.judge(moment('m2', 'hold', 'planned'), 'planned', 'executed').verdict, 'held');
});

test('summarize: counts by verdict and set; ok only when nothing broke, nothing is unanswered, and at least one is fixed', () => {
  const rows = [
    { id: 'a', set: 'change', verdict: 'fixed' }, { id: 'b', set: 'change', verdict: 'unchanged' },
    { id: 'c', set: 'hold', verdict: 'held' }, { id: 'd', set: 'hold', verdict: 'held' },
  ];
  const s = P.summarize(rows);
  assert.deepStrictEqual([s.change.total, s.change.fixed, s.change.unchanged, s.hold.total, s.hold.held, s.hold.broke], [2, 1, 1, 2, 2, 0]);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(P.summarize([...rows, { id: 'e', set: 'hold', verdict: 'broke' }]).ok, false, 'a broken hold moment fails it');
  assert.strictEqual(P.summarize([...rows, { id: 'e', set: 'hold', verdict: 'unanswered' }]).ok, false, 'an unanswered one is never a pass');
  assert.strictEqual(P.summarize(rows.filter(r => r.verdict !== 'fixed')).ok, false, 'nothing fixed: the edit shows no effect');
  assert.strictEqual(P.summarize([]).ok, false);
});

test('probeMoments: each moment is asked once under the old prompt and once under the new; an errored ask is unanswered', async () => {
  const calls = [];
  const ask = async (prompt, { id, arm }) => {
    calls.push(`${id}:${arm}`);
    if (id === 'bad') throw new Error('timeout');
    return { text: arm === 'new' && id === 'early' ? 'CYCLE RESULT: no-trade - waits for the push' : 'CYCLE RESULT: planned - long 3 MNQ' };
  };
  const moments = [
    { id: 'early', set: 'change', want: 'no-trade', prompt: PROMPT },
    { id: 'good', set: 'hold', want: 'planned', prompt: PROMPT },
    { id: 'bad', set: 'hold', want: 'planned', prompt: PROMPT },
  ];
  const out = await P.probeMoments({ moments, bodyOf: n => (n === 'breakout-vs-fakeout' ? 'NEW' : null), ask });
  assert.deepStrictEqual(calls.sort(), ['bad:new', 'bad:old', 'early:new', 'early:old', 'good:new', 'good:old']);
  const by = Object.fromEntries(out.rows.map(r => [r.id, r]));
  assert.strictEqual(by.early.verdict, 'fixed');
  assert.strictEqual(by.good.verdict, 'held');
  assert.strictEqual(by.bad.verdict, 'unanswered');
  assert.strictEqual(out.summary.ok, false);
});

test('probeMoments: the old arm gets the recorded prompt unchanged, the new arm the swapped one; a moment whose prompt holds no changed skill is untestable: never asked, counted, not a pass', async () => {
  const seen = {};
  const ask = async (prompt, { id, arm }) => { seen[`${id}:${arm}`] = prompt; return { text: 'CYCLE RESULT: no-trade - x' }; };
  const m = { id: 'e', set: 'change', want: 'no-trade', prompt: PROMPT };
  await P.probeMoments({ moments: [m], bodyOf: n => (n === 'breakout-vs-fakeout' ? 'NEW' : null), ask });
  assert.strictEqual(seen['e:old'], PROMPT);
  assert.ok(seen['e:new'].includes(skill('breakout-vs-fakeout', 'NEW')));
  const asked = [];
  const out = await P.probeMoments({ moments: [m], bodyOf: () => null, ask: async (...a) => { asked.push(a); return { text: '' }; } });
  assert.deepStrictEqual(asked, [], 'a prompt the fix cannot reach is never asked');
  assert.strictEqual(out.rows[0].verdict, 'untestable');
  assert.strictEqual(out.summary.change.untestable, 1);
  assert.strictEqual(out.summary.ok, false, 'nothing tested is no pass');
  // Untestable moments are reported, and do not by themselves fail the others.
  const mixed = P.summarize([{ id: 'a', set: 'change', verdict: 'fixed' }, { id: 'b', set: 'hold', verdict: 'held' }, { id: 'c', set: 'change', verdict: 'untestable' }]);
  assert.strictEqual(mixed.ok, true);
  assert.strictEqual(mixed.change.untestable, 1);
});

test('momentFromCycle: a recorded cycle log becomes a moment: its prompt with the probe instruction, its system file and model from the recorded argv', () => {
  const log = { prompt: PROMPT, argv: ['claude', '-p', '<prompt>', '--model', 'haiku', '--append-system-prompt-file', '/runs/x/head.md', '--permission-mode', 'dontAsk'] };
  const m = P.momentFromCycle(log, { id: 'e', set: 'change', want: 'no-trade' });
  assert.deepStrictEqual([m.id, m.set, m.want, m.system, m.model], ['e', 'change', 'no-trade', '/runs/x/head.md', 'haiku']);
  assert.ok(m.prompt.startsWith(PROMPT) && m.prompt.endsWith(P.PROBE_SUFFIX), 'the same instruction ends both arms\' prompts');
  assert.match(P.PROBE_SUFFIX, /not available/);
  assert.match(P.PROBE_SUFFIX, /CYCLE RESULT: planned/);
  assert.match(P.PROBE_SUFFIX, /CYCLE RESULT: no-trade/);
  assert.throws(() => P.momentFromCycle({ prompt: PROMPT, argv: ['claude'] }, { id: 'e', set: 'change', want: 'no-trade' }), /system prompt file/);
  assert.throws(() => P.momentFromCycle(log, { id: 'e', set: 'other', want: 'no-trade' }), /set/);
  assert.throws(() => P.momentFromCycle(log, { id: 'e', set: 'hold', want: 'maybe' }), /want/);
});

test('treeBodyOf: the body of a tree\'s skill (frontmatter removed); null for a skill the tree lacks', () => {
  const fs = require('fs'); const path = require('path'); const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
  fs.mkdirSync(path.join(root, 'skills', 'cisd'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'cisd', 'SKILL.md'), '---\nname: cisd\ndescription: d\n---\n# CISD\n\nbody\n');
  const of = P.treeBodyOf(root);
  assert.strictEqual(of('cisd'), '# CISD\n\nbody');
  assert.strictEqual(of('nope'), null);
  assert.strictEqual(of('../etc/passwd'), null, 'a name that is not a skill name is never read');
});

test('majorityOutcome: the commonest outcome (planned and executed count as one); a tie or no answer is null', () => {
  assert.strictEqual(P.majorityOutcome(['planned', 'executed', 'no-trade']), 'planned');
  assert.strictEqual(P.majorityOutcome(['no-trade', 'no-trade', null]), 'no-trade');
  assert.strictEqual(P.majorityOutcome(['no-trade', 'planned']), null, 'a tie is no answer');
  assert.strictEqual(P.majorityOutcome([null, null]), null);
  assert.strictEqual(P.majorityOutcome([]), null);
});

test('momentFromCycle: the recorded outcome of the cycle is kept for calibration', () => {
  const argv = ['claude', '-p', '<prompt>', '--append-system-prompt-file', '/s.md'];
  assert.strictEqual(P.momentFromCycle({ prompt: PROMPT, argv, result: 'CYCLE RESULT: executed - short 5 MNQ' }, { id: 'a', set: 'hold', want: 'planned' }).recorded, 'planned');
  assert.strictEqual(P.momentFromCycle({ prompt: PROMPT, argv, result: 'CYCLE RESULT: no-trade - x' }, { id: 'a', set: 'hold', want: 'planned' }).recorded, 'no-trade');
  assert.strictEqual(P.momentFromCycle({ prompt: PROMPT, argv }, { id: 'a', set: 'hold', want: 'planned' }).recorded, null);
});

test('probeMoments with k: the old arm asked k times first; a moment whose majority is not the recorded outcome is uncalibrated, and its new arm is never asked', async () => {
  const calls = [];
  const ask = async (prompt, { id, arm }) => {
    calls.push(`${id}:${arm}`);
    if (id === 'drift') return { text: 'CYCLE RESULT: no-trade - x' }; // the real cycle entered; the tool-less model does not
    return { text: arm === 'new' && id === 'early' ? 'CYCLE RESULT: no-trade - waits' : 'CYCLE RESULT: planned - long' };
  };
  const moments = [
    { id: 'early', set: 'change', want: 'no-trade', recorded: 'planned', prompt: PROMPT },
    { id: 'drift', set: 'hold', want: 'planned', recorded: 'planned', prompt: PROMPT },
  ];
  const out = await P.probeMoments({ moments, bodyOf: n => (n === 'breakout-vs-fakeout' ? 'NEW' : null), ask, k: 3 });
  assert.strictEqual(calls.filter(c => c === 'early:old').length, 3);
  assert.strictEqual(calls.filter(c => c === 'early:new').length, 3);
  assert.strictEqual(calls.filter(c => c === 'drift:old').length, 3);
  assert.strictEqual(calls.filter(c => c === 'drift:new').length, 0, 'an uncalibrated moment costs no new-arm calls');
  const by = Object.fromEntries(out.rows.map(r => [r.id, r]));
  assert.strictEqual(by.early.verdict, 'fixed');
  assert.strictEqual(by.drift.verdict, 'uncalibrated');
  assert.strictEqual(out.summary.hold.uncalibrated, 1);
  assert.strictEqual(out.summary.ok, true, 'an uncalibrated moment is reported, not counted for or against');
});

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
  const log = { prompt: PROMPT, result: 'CYCLE RESULT: planned - x', argv: ['claude', '-p', '<prompt>', '--model', 'model-a', '--append-system-prompt-file', '/runs/x/head.md', '--permission-mode', 'dontAsk'] };
  const m = P.momentFromCycle(log, { id: 'e', set: 'change', want: 'no-trade' });
  assert.deepStrictEqual([m.id, m.set, m.want, m.system, m.model], ['e', 'change', 'no-trade', '/runs/x/head.md', 'model-a']);
  assert.ok(m.prompt.startsWith(PROMPT) && m.prompt.endsWith(P.PROBE_SUFFIX), 'the same instruction ends both arms\' prompts');
  assert.match(P.PROBE_SUFFIX, /not available/);
  assert.match(P.PROBE_SUFFIX, /CYCLE RESULT: planned/);
  assert.match(P.PROBE_SUFFIX, /CYCLE RESULT: no-trade/);
  assert.throws(() => P.momentFromCycle({ prompt: PROMPT, result: 'CYCLE RESULT: planned - x', argv: ['claude'] }, { id: 'e', set: 'change', want: 'no-trade' }), /system prompt file/);
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
  assert.strictEqual(P.momentFromCycle({ prompt: PROMPT, argv, result: 'CYCLE RESULT: no-trade - x' }, { id: 'a', set: 'change', want: 'no-trade' }).recorded, 'no-trade');
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
    { id: 'steady', set: 'hold', want: 'planned', recorded: 'planned', prompt: PROMPT },
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

test('review fix: an old arm whose asks all fail is unanswered, never uncalibrated; and ok needs a tested hold moment', async () => {
  const ask = async () => { throw new Error('rate limited'); };
  const moments = [{ id: 'h', set: 'hold', want: 'planned', recorded: 'planned', prompt: PROMPT }];
  const out = await P.probeMoments({ moments, bodyOf: n => (n === 'breakout-vs-fakeout' ? 'NEW' : null), ask, k: 3 });
  assert.strictEqual(out.rows[0].verdict, 'unanswered');
  assert.strictEqual(out.summary.ok, false);
  // One change moment fixed and every hold moment unreadable: nothing shows the winners held.
  const s = P.summarize([{ id: 'a', set: 'change', verdict: 'fixed' }, { id: 'b', set: 'hold', verdict: 'uncalibrated' }]);
  assert.strictEqual(s.ok, false, 'no hold moment was tested');
});

test('review fix: a hold moment is a recorded entry; one that never entered is refused, not "held"', () => {
  const argv = ['claude', '-p', '<prompt>', '--append-system-prompt-file', '/s.md'];
  assert.throws(() => P.momentFromCycle({ prompt: PROMPT, argv, result: 'CYCLE RESULT: no-trade - x' }, { id: 'h', set: 'hold', want: 'planned' }), /hold moment.*entered/);
  assert.throws(() => P.momentFromCycle({ prompt: PROMPT, argv }, { id: 'h', set: 'hold', want: 'planned' }), /recorded/);
  assert.throws(() => P.momentFromCycle({ prompt: PROMPT, argv }, { id: 'c', set: 'change', want: 'no-trade' }), /recorded/);
  assert.strictEqual(P.judge({ set: 'hold', want: 'planned' }, 'no-trade', 'no-trade').verdict, 'uncalibrated', 'a hold moment that does not enter is no test');
});

test('review fix: ok needs no broken or unanswered change moment; executed counts as the wanted planned', () => {
  const held = [{ id: 'h', set: 'hold', verdict: 'held' }, { id: 'f', set: 'change', verdict: 'fixed' }];
  assert.strictEqual(P.summarize(held).ok, true);
  assert.strictEqual(P.summarize([...held, { id: 'x', set: 'change', verdict: 'broke' }]).ok, false);
  assert.strictEqual(P.summarize([...held, { id: 'x', set: 'change', verdict: 'unanswered' }]).ok, false);
  assert.strictEqual(P.judge({ set: 'change', want: 'executed' }, 'no-trade', 'planned').verdict, 'fixed');
  assert.strictEqual(P.judge({ set: 'change', want: 'planned' }, 'no-trade', 'executed').verdict, 'fixed');
});

test('review fix: a whitespace-only difference is no swap; a traversal name reads nothing even when the file exists', () => {
  assert.deepStrictEqual(P.swapSkills(PROMPT, n => (n === 'candle-reading' ? '  candle text \n' : null)).swapped, []);
  const fs = require('fs'); const path = require('path'); const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp2-'));
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(root, 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'x', 'SKILL.md'), '---\nname: x\n---\nsecret\n');
  assert.strictEqual(P.treeBodyOf(root)('../x'), null);
});

test('review fix: duplicate moment ids are refused (they would share one binary, model and system file)', async () => {
  const m = { id: 'same', set: 'change', want: 'no-trade', prompt: PROMPT };
  await assert.rejects(P.probeMoments({ moments: [m, m], bodyOf: () => 'x', ask: async () => ({ text: '' }), k: 1 }), /duplicate/);
});

test('probeArgs: the tools, the user settings, MCP servers and session files are all off, like the context quiz', () => {
  const a = P.probeArgs({ prompt: 'p', system: '/s.md', model: 'model-a' });
  assert.strictEqual(a[0], '-p');
  assert.ok(a.includes('--strict-mcp-config') && a.includes('--no-session-persistence'));
  assert.deepStrictEqual(a.slice(a.indexOf('--tools'), a.indexOf('--tools') + 2), ['--tools', '']);
  assert.deepStrictEqual(a.slice(a.indexOf('--setting-sources'), a.indexOf('--setting-sources') + 2), ['--setting-sources', '']);
  assert.deepStrictEqual(a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 2), ['--permission-mode', 'dontAsk']);
  assert.deepStrictEqual(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2), ['--model', 'model-a']);
  assert.ok(!P.probeArgs({ prompt: 'p', system: '/s.md', model: null }).includes('--model'));
});

// Review round 2.
test('review 2: a result line must start the line; text that quotes the label later in a line is not the answer', () => {
  assert.strictEqual(P.outcomeOf('CYCLE RESULT: no-trade - x\n(I would have said CYCLE RESULT: planned - long if the stop fit)'), 'no-trade');
  assert.strictEqual(P.outcomeOf('maybe CYCLE RESULT: planned - x'), null);
  assert.strictEqual(P.outcomeOf('  > **CYCLE RESULT: planned - x**'), 'planned');
});

test('review 2: the majority is over all k asks; failed asks are not dropped, so one answer of three decides nothing', async () => {
  assert.strictEqual(P.majorityOutcome(['planned', null, null]), null);
  assert.strictEqual(P.majorityOutcome(['planned', 'planned', null]), 'planned');
  assert.strictEqual(P.majorityOutcome(['planned', 'executed']), 'planned');
  assert.strictEqual(P.majorityOutcome(['planned', null]), null);
  let n = 0;
  const flaky = async () => { n += 1; if (n % 3) throw new Error('rate limit'); return { text: 'CYCLE RESULT: planned - x' }; };
  const moments = [{ id: 'c', set: 'change', want: 'planned', prompt: PROMPT, recorded: 'planned' }, { id: 'h', set: 'hold', want: 'planned', prompt: PROMPT, recorded: 'planned' }];
  const { summary, rows } = await P.probeMoments({ moments, bodyOf: n2 => (n2 === 'candle-reading' ? 'new' : null), ask: flaky, k: 3 });
  assert.strictEqual(summary.ok, false);
  assert.ok(rows.every(r => r.verdict === 'unanswered'), JSON.stringify(rows));
});

test('review 2: ids 1 and "1" are one id (the CLI keys moments by the string form)', async () => {
  const ms = [{ id: 1, set: 'change', want: 'planned', prompt: PROMPT }, { id: '1', set: 'change', want: 'planned', prompt: PROMPT }];
  await assert.rejects(P.probeMoments({ moments: ms, bodyOf: () => 'x', ask: async () => ({ text: '' }), k: 1 }), /duplicate/);
});

test('review 2: the argv carries the prompt at -p, the system prompt file, and text output', () => {
  const a = P.probeArgs({ prompt: 'THE PROMPT', system: '/s.md', model: null });
  assert.strictEqual(a[0], '-p');
  assert.strictEqual(a[1], 'THE PROMPT');
  assert.deepStrictEqual(a.slice(a.indexOf('--append-system-prompt-file'), a.indexOf('--append-system-prompt-file') + 2), ['--append-system-prompt-file', '/s.md']);
  assert.deepStrictEqual(a.slice(a.indexOf('--output-format'), a.indexOf('--output-format') + 2), ['--output-format', 'text']);
});

test('review 2: a cycle log with no prompt is refused; a failed ask leaves its reason on the row', async () => {
  const argv = ['claude', '--append-system-prompt-file', '/s.md'];
  assert.throws(() => P.momentFromCycle({ result: 'CYCLE RESULT: planned - x', argv }, { id: 'e', set: 'change', want: 'no-trade' }), /no prompt/);
  assert.throws(() => P.momentFromCycle({ prompt: '', result: 'CYCLE RESULT: planned - x', argv }, { id: 'e', set: 'change', want: 'no-trade' }), /no prompt/);
  const ask = async () => { throw new Error('claude exited 1: boom'); };
  const { rows } = await P.probeMoments({ moments: [{ id: 'c', set: 'change', want: 'planned', prompt: PROMPT, recorded: 'planned' }], bodyOf: n => (n === 'candle-reading' ? 'new' : null), ask, k: 2 });
  assert.match(rows[0].errors[0], /boom/);
});

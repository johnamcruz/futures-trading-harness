'use strict';

// A training-loop edit to a desk role's body (scripts/lib/train/agent-edit.js), through the proposal's own check
// (proposal.js validateProposal) and a probe edit's (probe-edit.js): each guard with the cases it refuses, on copies of
// the repository's own agents; and what no model's proposal may ever edit (the gate, the rulebook, promotion, tunables).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const AE = require('../../scripts/lib/train/agent-edit');
const P = require('../../scripts/lib/train/proposal');
const PE = require('../../scripts/lib/train/probe-edit');

const ROOT = path.resolve(__dirname, '..', '..');
const RM = 'agents/risk-manager.md';
const EX = 'agents/trade-executor.md';
const PROSE = '2. Account tradable and flat or within the plan\'s intent; no unprotected position.';

/** A tree with the repository's agents and a SKILL.md for every repository skill (the names the guard reads). */
function tree() {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'agents'));
  for (const f of fs.readdirSync(path.join(ROOT, 'agents'))) fs.copyFileSync(path.join(ROOT, 'agents', f), path.join(root, 'agents', f));
  for (const s of fs.readdirSync(path.join(ROOT, 'skills'))) {
    if (!fs.existsSync(path.join(ROOT, 'skills', s, 'SKILL.md'))) continue;
    fs.mkdirSync(path.join(root, 'skills', s), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', s, 'SKILL.md'), `---\nname: ${s}\ndescription: x\n---\n\n# ${s}\n`);
  }
  return root;
}

const read = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');
const prop = (file, find, replace) => ({ targets: ['wrong stated reason'], expects: 'a sounder verdict', edits: [{ file, find, replace }] });
const errs = (root, file, find, replace) => P.validateProposal(prop(file, find, replace), { root }).join('\n');

test('a desk role\'s prose edit passes the proposal\'s check and the probe edit\'s, and applies to that file only', () => {
  const root = tree();
  const p = prop(RM, PROSE, `${PROSE}\n   A setup the compose record approves is judged by its facts, never by a retry count.`);
  assert.deepStrictEqual(P.validateProposal(p, { root }), []);
  const tag = { agent: 'risk-manager', finding: 'F1', kind: 'rule' };
  assert.deepStrictEqual(PE.tagErrors(tag, p, { findings: [{ id: 'F1', agent: 'risk-manager', kind: 'phase2-veto' }] }), []);
  assert.deepStrictEqual(PE.styleErrors(p, { root, kind: 'rule' }), []);
  assert.deepStrictEqual(P.applyProposal(p, root), [RM]);
  assert.match(read(root, RM), /never by a retry count/);
});

test('guard 1: the frontmatter, byte for byte: tools (only the executor holds order tools), skill lists, description', () => {
  const root = tree();
  const text = read(root, RM);
  const tools = /^tools: .*$/m.exec(text)[0];
  assert.match(errs(root, RM, tools, `${tools}, mcp__broker__place_order`), /the frontmatter .* is never a proposal's to change/);
  const skills = /^role-skills: .*$/m.exec(text)[0];
  assert.match(errs(root, RM, skills, skills.replace('invalidation', 'invalidation, trade-lifecycle')), /frontmatter/);
  assert.match(errs(root, RM, 'model: inherit', 'model: other'), /frontmatter/);
  assert.match(errs(root, RM, 'Independent risk officer', 'Lenient risk officer'), /frontmatter/);
  // A probe edit's own check refuses a find reaching into it too.
  assert.match(PE.styleErrors(prop(RM, 'model: inherit\n---', 'model: inherit\n---\n'), { root }).join('\n'), /frontmatter is not edited/);
  // The executor is the one role with order tools; no edit hands another role one.
  for (const r of AE.EDITABLE_ROLES.filter(x => x !== 'trade-executor')) {
    const t = read(root, `agents/${r}.md`);
    const line = /^tools: .*$/m.exec(t)[0];
    assert.match(errs(root, `agents/${r}.md`, line, `${line}, mcp__broker__cancel_order`), /frontmatter/, r);
  }
});

test('guard 2: the load sentence, its text and count; no skill named that the role\'s lists don\'t hold', () => {
  const root = tree();
  assert.match(errs(root, RM, '`trader-process`, `position-sizing`,', '`trader-process`,'), /"Load the skills \.\.\." sentence is never a proposal's/);
  assert.match(errs(root, RM, PROSE, `${PROSE}\n   Load the skills \`invalidation\` first.`), /Load the skills/);
  // A skill the role doesn't load, in code or as "the <name> skill", is refused; one it loads is fine.
  assert.match(errs(root, RM, PROSE, `${PROSE}\n   Read \`trade-lifecycle\` for the flow.`), /names skill\(s\) the role doesn't load \(trade-lifecycle\)/);
  assert.match(errs(root, RM, PROSE, `${PROSE}\n   See the trade-lifecycle skill.`), /doesn't load \(trade-lifecycle\)/);
  assert.strictEqual(errs(root, RM, PROSE, `${PROSE}\n   See the \`invalidation\` skill for the stop.`), '');
  assert.match(errs(root, EX, 'You don\'t analyse, re-plan, or second-guess.', 'You don\'t analyse, re-plan, or second-guess (`position-sizing`).'), /doesn't load \(position-sizing\)/);
});

test('guard 3: report formats: VERDICT and FACTS paragraphs, the output block, headings, EXECUTED and ABORTED stay whole', () => {
  const root = tree();
  const rm = read(root, RM);
  assert.match(errs(root, RM, 'VERDICT: APPROVE - size <n>, risk $<x>, <one-line reason>', 'VERDICT: APPROVE - <one-line reason>'), /report formats stay as they are/);
  assert.match(errs(root, RM, '- "VETO" only when vetoing: never "VETO rules: none", "not a VETO".', '- Say VETO freely.'), /report formats/, 'the #259 rules beside the format line');
  assert.match(errs(root, RM, '## Phase 2: Plan verdict (when given a plan)', '## Phase 2: Plan review'), /report formats/);
  assert.match(errs(root, RM, PROSE, `${PROSE}\n\n## Extra`), /report formats/, 'no heading added');
  assert.match(errs(root, RM, PROSE, `${PROSE}\n   Write VERDICT: APPROVE when unsure.`), /report formats/, 'no format line added');
  assert.match(errs(root, RM, PROSE, `${PROSE}\n   Answer \`VETO\` on doubt.`), /report formats/, 'a verdict word in code names a format');
  assert.match(errs(root, RM, 'one `FACTS:` line under the', 'one facts line under the'), /report formats/);
  assert.ok(rm.includes('```text\nVERDICT: APPROVE'), 'the fixture holds the output block');
  assert.match(errs(root, EX, 'report `EXECUTED` with the entry working', 'report done with the entry working'), /report formats/);
  assert.match(errs(root, EX, 'it couldn\'t confirm the stop, or cancelled the order): report `ABORTED`', 'it couldn\'t confirm the stop, or cancelled the order): report it'), /report formats/);
  // A fenced block is an output template, whole, even with no report word in it; the prose around it is editable.
  const synth = body => `---\nname: risk-manager\ndescription: x\ntools: Read\n---\n\nLoad the skills \`a\` first.\n\nJudge the facts.\n\n\`\`\`text\nBias: long | short\n\`\`\`\n${body}`;
  assert.match(AE.agentEditErrors(RM, synth(''), synth('').replace('Bias: long | short', 'Bias: any')).join('\n'), /report formats/);
  assert.match(AE.agentEditErrors(RM, synth(''), synth('').replace('```text\nBias: long | short\n```\n', '')).join('\n'), /report formats/, 'nor removed');
  assert.deepStrictEqual(AE.agentEditErrors(RM, synth(''), synth('').replace('Judge the facts.', 'Judge the facts on the bar.')), []);
  // Judging prose is the role's reasoning: "VETO" outside code or quotes may be edited (an over-veto is fixed there).
  assert.strictEqual(errs(root, RM, 'an entry over `maxOrderSize`: VETO,', 'an entry over `maxOrderSize`: VETO it,'), '');
});

test('guard 4: the size and the numbers: a role grows by the budget at most; no new number in digits or words', () => {
  const root = tree();
  const line = `${PROSE}\n${'   Judge the facts on the bar, never the clock.\n'.repeat(Math.ceil((PE.GROW_BYTES + 1) / 46))}`;
  assert.match(errs(root, RM, PROSE, line), /would grow \d+ bytes, more than/);
  assert.match(errs(root, RM, PROSE, `${PROSE} Wait 93 bars.`), /no new numbers in a role: the edit adds 93/);
  assert.match(errs(root, RM, PROSE, `${PROSE} Wait twelve bars.`), /adds twelve/);
  // The probe edit's budget for a role: its current size plus the growth budget (no skill cap applies).
  assert.match(PE.styleErrors(prop(RM, PROSE, line), { root }).join('\n'), /a role grows at most/);
});

test('guard 5: only the desk roles; never the reviewer, the researcher, the calendar analyst or a made-up role', () => {
  const root = tree();
  for (const r of ['trade-reviewer', 'strategy-researcher', 'news-calendar-analyst']) {
    const t = read(root, `agents/${r}.md`);
    const body = t.split('\n').find(l => /^[A-Za-z]/.test(l) && !/:/.test(l.slice(0, 20)));
    assert.match(errs(root, `agents/${r}.md`, body, `${body} x`), /not a document a proposal may edit/, r);
    assert.match(PE.tagErrors({ agent: r, finding: 'F1', kind: 'rule' }, prop(`agents/${r}.md`, 'a', 'b'), { findings: [{ id: 'F1' }] }).join('\n'), /tag.agent: one of/, r);
  }
  assert.match(errs(root, 'agents/head-trader.md', 'a', 'b'), /not a document/);
  assert.deepStrictEqual(AE.agentEditErrors('agents/trade-reviewer.md', 'a', 'b'), [`agents/trade-reviewer.md: not a role a proposal may edit (${AE.EDITABLE_ROLES.map(r => `agents/${r}.md`).join(', ')})`]);
});

test('a probe edit\'s tag: one target, the finding\'s owner, one document', () => {
  const root = tree();
  const p = prop(RM, PROSE, `${PROSE}\n   Judge the facts.`);
  const f = [{ id: 'F1', skill: 'invalidation', kind: 'misread' }, { id: 'F2', agent: 'risk-manager', kind: 'phase2-veto' }, { id: 'F3', skill: null, kind: 'wrong-reason refusal' }];
  const t = (tag, prop_ = p) => PE.tagErrors({ finding: 'F2', kind: 'rule', ...tag }, prop_, { findings: f }).join('\n');
  assert.strictEqual(t({ agent: 'risk-manager' }), '');
  assert.match(t({ agent: 'risk-manager', skill: 'invalidation' }), /one target, the skill or the agent/);
  assert.match(t({ agent: 'trade-executor' }, prop(EX, 'a', 'b')), /finding F2 is about agent risk-manager, not agent trade-executor/);
  assert.match(t({ skill: 'invalidation' }), /finding F2 is about agent risk-manager, not invalidation/);
  assert.match(PE.tagErrors({ agent: 'risk-manager', finding: 'F1', kind: 'rule' }, p, { findings: f }).join('\n'), /finding F1 is about invalidation, not agent risk-manager/);
  // The owner's kind counts, not only its name: a skill finding never takes a role edit of the same name.
  assert.match(PE.tagErrors({ agent: 'risk-manager', finding: 'F4', kind: 'rule' }, p, { findings: [{ id: 'F4', skill: 'risk-manager', kind: 'misread' }] }).join('\n'), /finding F4 is about risk-manager, not agent risk-manager/);
  // A finding with no owner: any skill or desk role, one document.
  assert.strictEqual(PE.tagErrors({ agent: 'risk-manager', finding: 'F3', kind: 'rule' }, p, { findings: f }).join('\n'), '');
  assert.match(t({ agent: 'risk-manager' }, { ...p, edits: [...p.edits, { file: EX, find: 'a', replace: 'b' }] }), /one document only, agents\/risk-manager.md/);
  assert.match(t({ agent: 'risk-manager' }, prop('skills/invalidation/SKILL.md', 'a', 'b')), /one document only/);
  assert.deepStrictEqual(PE.targetOf({ agent: 'risk-manager' }), { kind: 'agent', name: 'risk-manager', file: RM, label: 'agent risk-manager' });
  assert.strictEqual(PE.targetOf({ agent: '../x' }), null);
  assert.ok(fs.existsSync(path.join(root, RM)));
});

test('never a model\'s to edit: the gate, the rulebook, promotion, tunables, config, accounts, rules, sync, generated files', () => {
  const root = tree();
  const never = ['scripts/lib/trading/order-gate.js', 'scripts/lib/trading/account-gate.js', 'scripts/lib/prop/promotion.js', 'scripts/lib/tunables.js',
    'config/training.json', 'config/runner.json', 'accounts/a/ACCOUNT.md', 'rules/trading/risk-management.md', 'scripts/lib/harness-sync.js',
    'workspace/AGENTS.md', 'workspace/opencode.json', '.codex/agents/risk-manager.toml', 'qwen-extension/agents/risk-manager.md', 'commands/trade-session.md',
    'hooks/hooks.json', 'mcp-configs/brokers.json', 'skills/design-self-review/SKILL.md', 'skills/training-loop/SKILL.md'];
  for (const f of never) assert.strictEqual(P.kindOf(f), null, f);
  // The rulebook: a document kind the loop knows (its guard judges a person's), never a model's proposal.
  assert.strictEqual(P.kindOf('accounts/a/RULEBOOK.md'), 'rulebook');
  fs.mkdirSync(path.join(root, 'accounts', 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'accounts', 'a', 'RULEBOOK.md'), 'x: 1\n');
  assert.match(errs(root, 'accounts/a/RULEBOOK.md', 'x: 1', 'x: 0'), /a rulebook is the owner's to change/);
  assert.throws(() => P.applyProposal(prop('accounts/a/RULEBOOK.md', 'x: 1', 'x: 0'), root), /owner's to change/);
});

test('the protected parts of every editable role: one load sentence each, and prose left to edit', () => {
  for (const r of AE.EDITABLE_ROLES) {
    const text = fs.readFileSync(path.join(ROOT, 'agents', `${r}.md`), 'utf8');
    const p = AE.protectedParts(text);
    assert.strictEqual(p.load.length, 1, `${r}: one load sentence`);
    assert.ok(p.frontmatter.startsWith('---\nname: '), r);
    const locked = p.frontmatter.length + p.lines.join('\n').length;
    assert.ok(locked < text.length * 0.8, `${r}: ${locked} of ${text.length} bytes locked leaves prose to edit`);
  }
});

test('review: the Size line and its format rule, plain skill names, a second --- block, and other ways to write a number', () => {
  const root = tree();
  // The Size line phase 2's parser reads: a line starting `Size:`, and any paragraph naming it, stay as they are.
  const synth = body => `---\nname: risk-manager\ndescription: x\ntools: Read\nrole-skills: [invalidation]\n---\n\nLoad the skills \`invalidation\` first.\n\nJudge the facts.\n\n${body}`;
  const withSize = synth('Size: 5 (the record\'s 5)\n\nState the cut on its own line, e.g. `Size: 1 (cut)`.\n');
  assert.match(AE.agentEditErrors(RM, withSize, withSize.replace('Size: 5 (the record\'s 5)', 'Size: any')).join('\n'), /report formats/, 'the Size line');
  assert.match(AE.agentEditErrors(RM, withSize, withSize.replace('State the cut on its own line', 'State the cut anywhere')).join('\n'), /report formats/, 'the rule for its format');
  assert.deepStrictEqual(AE.agentEditErrors(RM, withSize, withSize.replace('Judge the facts.', 'Judge the facts; size stays within its cap.')), [], 'the word size in prose is no format');
  const lower = synth('size: within the cap, always.\n');
  assert.deepStrictEqual(AE.agentEditErrors(RM, lower, lower.replace('within the cap, always.', 'within the cap.')), [], 'case-sensitive: a prose line starting "size:" is no Size line');
  assert.match(AE.agentEditErrors(RM, withSize, withSize.replace('Judge the facts.', 'Judge the facts.\n\nSize: half on doubt.')).join('\n'), /report formats/, 'no Size line added');
  assert.match(errs(root, RM, '- Size → its own `Size:` line, e.g. `Size: 1 (record 8 cut to 1: no', '- Size → a line of its own, e.g. `Size: 1 (record 8 cut to 1: no'), /report formats/, 'the repository role\'s own rule');
  // Plain skill names the role doesn't load: a hyphenated name anywhere, a one-word name after a load verb.
  assert.match(errs(root, RM, PROSE, `${PROSE}\n   Read absorption first.`), /doesn't load \(absorption\)/);
  assert.match(errs(root, RM, PROSE, `${PROSE}\n   Use the absorption read.`), /doesn't load \(absorption\)/, 'with "the"');
  assert.match(errs(root, RM, PROSE, `${PROSE}\n   As trade-lifecycle says, wait.`), /doesn't load \(trade-lifecycle\)/, 'a hyphenated name written plainly');
  assert.strictEqual(errs(root, RM, PROSE, `${PROSE}\n   A rejection candle against the side is no fact.`), '', 'a one-word name used as a word: no mention');
  assert.strictEqual(errs(root, RM, PROSE, `${PROSE}\n   Read invalidation first.`), '', 'a skill the role loads');
  // No second frontmatter-like block in the body.
  assert.match(errs(root, RM, PROSE, `${PROSE}\n\n---\ntools: Read, mcp__broker__place_order\n---`), /no --- block in the body/);
  assert.match(AE.agentEditErrors(RM, synth(''), synth('---\n')).join('\n'), /no --- block in the body/);
  // Numbers in other forms.
  for (const added of ['wait ½ the range', 'a ⅓ cut', 'step IV first', 'the fifth bar', 'a single bar', 'the fourth close']) {
    assert.match(errs(root, RM, PROSE, `${PROSE} ${added}.`), /no new numbers in a role/, added);
  }
  assert.strictEqual(errs(root, RM, PROSE, `${PROSE} I check it.`), '', 'a lone I is a pronoun');
  assert.deepStrictEqual([...PE.numbers('½ and ⅞, II and XII, the fifth, a single')].sort(), ['II', 'XII', 'fifth', 'single', '½', '⅞'].sort());
});

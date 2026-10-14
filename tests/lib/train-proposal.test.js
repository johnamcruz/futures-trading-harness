'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const { FAILURES, LOCKED_KEYS, parseProposals, validateProposal, applyProposal, proposalId, isMechanical, kindOf } = require('../../scripts/lib/train/proposal');

function tree() {
  const root = tmpDir();
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('skills/session-timing/SKILL.md', '# Session Timing\n\nThe opening window runs until 09:35.\n');
  put('skills/training-loop/SKILL.md', '# Loop\n');
  put('strategies/orb/STRATEGY.md', '---\nname: orb\nstatus: paper\nstop_atr: 1.0\n---\n# ORB\n');
  put('scripts/lib/prop/promotion.js', "const PROMOTION_GATE = { minPassRate: 0.4 };\n");
  put('accounts/a/ACCOUNT.md', 'daily_loss_limit: 1000\n');
  return root;
}

const ok = (over = {}) => ({ targets: ['wrong stated reason'], expects: 'fewer wrong reasons', edits: [{ file: 'skills/session-timing/SKILL.md', find: 'until 09:35.', replace: 'until 09:35; the briefing says when entries are allowed.' }], ...over });

test('parseProposals: PROPOSAL lines, plain or inside a harness\'s JSON events, each once; a bad one is an error', () => {
  const p = ok();
  const out = [
    'thinking...', `PROPOSAL ${JSON.stringify(p)}`, 'PROPOSAL {not json}',
    JSON.stringify({ type: 'result', result: `done\nPROPOSAL ${JSON.stringify(p)}\n` }),
    JSON.stringify({ type: 'text', part: { text: `PROPOSAL ${JSON.stringify(ok({ expects: 'other' }))}` } }),
  ].join('\n');
  const got = parseProposals(out);
  assert.strictEqual(got.length, 3);
  assert.deepStrictEqual(got[0].proposal, p);
  assert.match(got[1].error, /not JSON/);
  assert.strictEqual(got[2].proposal.expects, 'other');
  assert.deepStrictEqual(parseProposals('NO PROPOSAL'), []);
});

test('validateProposal: a small edit to a skill passes; applyProposal changes only that text', () => {
  const root = tree();
  assert.deepStrictEqual(validateProposal(ok(), { root }), []);
  assert.deepStrictEqual(applyProposal(ok(), root), ['skills/session-timing/SKILL.md']);
  assert.match(fs.readFileSync(path.join(root, 'skills/session-timing/SKILL.md'), 'utf8'), /until 09:35; the briefing says/);
});

test('validateProposal: never code, accounts, the loop\'s own skills, a path outside, or a strategy\'s name or status', () => {
  const root = tree();
  const edit = e => validateProposal(ok({ edits: [e] }), { root }).join('\n');
  assert.match(edit({ file: 'scripts/lib/prop/promotion.js', find: '0.4', replace: '0.1' }), /not a document a proposal may edit/);
  assert.match(edit({ file: 'accounts/a/ACCOUNT.md', find: '1000', replace: '9000' }), /not a document/);
  assert.match(edit({ file: 'skills/training-loop/SKILL.md', find: '# Loop', replace: '# X' }), /not a document/);
  assert.match(edit({ file: 'skills/../scripts/x/SKILL.md', find: 'a', replace: 'b' }), /not a document/);
  assert.match(edit({ file: '/etc/skills/x/SKILL.md', find: 'a', replace: 'b' }), /not a document/);
  assert.match(edit({ file: 'strategies/orb/STRATEGY.md', find: 'status: paper', replace: 'status: active' }), /name or status line is the owner's/);
  assert.match(edit({ file: 'strategies/orb/STRATEGY.md', find: 'stop_atr: 1.0', replace: 'stop_atr: 1.0\nstatus: active' }), /name or status/);
  assert.deepStrictEqual(validateProposal(ok({ edits: [{ file: 'strategies/orb/STRATEGY.md', find: 'stop_atr: 1.0', replace: 'stop_atr: 1.25' }] }), { root }), []);
  // However the edit is worded, the parsed owner-held keys may not move.
  assert.match(edit({ file: 'strategies/orb/STRATEGY.md', find: 'tatus: paper', replace: 'tatus: active' }), /status is the owner's to change/);
  assert.match(edit({ file: 'strategies/orb/STRATEGY.md', find: 'paper', replace: 'active' }), /status is the owner's/);
  assert.match(edit({ file: 'strategies/orb/STRATEGY.md', find: 'stop_atr: 1.0\n', replace: 'stop_atr: 1.0\nregime_gate: false\n' }), /regime_gate is the owner's/);
  assert.match(edit({ file: 'strategies/orb/STRATEGY.md', find: '---\n# ORB', replace: '# ORB' }), /frontmatter no longer parses/);
  assert.ok(LOCKED_KEYS.includes('sizing') && LOCKED_KEYS.includes('account') && LOCKED_KEYS.includes('strategies'));
  // A symbolic link out of the tree is refused.
  fs.mkdirSync(path.join(root, 'skills', 'linked'));
  fs.symlinkSync(path.join(root, 'accounts', 'a', 'ACCOUNT.md'), path.join(root, 'skills', 'linked', 'SKILL.md'));
  assert.match(edit({ file: 'skills/linked/SKILL.md', find: '1000', replace: '9000' }), /symbolic link/);
});

test('validateProposal: the find text exactly once, small edits, known targets, an expectation, no extra keys', () => {
  const root = tree();
  const errs = p => validateProposal(p, { root }).join('\n');
  assert.match(errs(ok({ edits: [{ file: 'skills/session-timing/SKILL.md', find: 'nowhere', replace: 'x' }] })), /found 0 times/);
  assert.match(errs(ok({ edits: [{ file: 'skills/session-timing/SKILL.md', find: 'e', replace: 'x' }] })), /found [2-9]\d* times/);
  assert.match(errs(ok({ targets: ['right'] })), /targets:/);
  assert.match(errs(ok({ targets: [] })), /targets:/);
  assert.match(errs(ok({ expects: '' })), /expects/);
  assert.match(errs(ok({ extra: 1 })), /unknown keys: extra/);
  assert.match(errs(ok({ edits: [] })), /edits: 1 to 3/);
  assert.match(errs(ok({ edits: Array(4).fill(ok().edits[0]) })), /edits: 1 to 3/);
  assert.match(errs(ok({ edits: [{ file: 'skills/session-timing/SKILL.md', find: 'until 09:35.', replace: 'x'.repeat(2001) }] })), /up to 2000/);
  assert.match(errs(ok({ edits: [{ file: 'skills/session-timing/SKILL.md', find: 'until 09:35.', replace: 'until 09:35.' }] })), /replace equals find/);
  assert.match(errs(ok({ edits: [{ file: 'skills/nope/SKILL.md', find: 'a', replace: 'b' }] })), /no such file/);
  assert.match(errs('x'), /JSON object/);
  // Edits apply in order: the second sees the first's text.
  assert.deepStrictEqual(validateProposal(ok({ edits: [ok().edits[0], { file: 'skills/session-timing/SKILL.md', find: 'the briefing says', replace: 'the briefing decides' }] }), { root }), []);
  assert.throws(() => applyProposal(ok({ targets: ['right'] }), root), /proposal refused/);
});

test('proposalId: the same change is the same id; isMechanical: a strategy or rulebook edit', () => {
  assert.strictEqual(proposalId(ok()), proposalId(ok({ expects: 'worded otherwise', why: 'x' })));
  assert.notStrictEqual(proposalId(ok()), proposalId(ok({ targets: ['bad size'] })));
  assert.strictEqual(isMechanical(ok()), false);
  assert.strictEqual(isMechanical(ok({ edits: [{ file: 'strategies/orb/STRATEGY.md', find: 'a', replace: 'b' }] })), true);
  assert.strictEqual(kindOf('rulebooks/test_50k/RULEBOOK.md'), 'rulebook');
  assert.strictEqual(kindOf('agents/risk-manager.md'), null);
  assert.ok(FAILURES.includes('wrong stated reason') && !FAILURES.includes('right') && !FAILURES.includes('unchecked'));
});

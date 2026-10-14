'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir, homeBrokers } = require('../helpers');
const { validateConfig } = require('../../scripts/lib/autotrader');
const P = require('../../scripts/lib/train/proposer');

const ROOT = path.resolve(__dirname, '..', '..');
const HARNESS = path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js');
const flagged = [{ day: '2022-03-09', et: '09:40', symbol: 'MNQ', category: 'wrong stated reason', expected: { decision: 'take', setup: 'fx_break' }, actual: { action: 'none' }, why: ['skipped citing the opening window'], falseReasons: ['"opening window until 10:00": entries allowed from 09:35'], stated: 'CYCLE RESULT: no-trade - opening window until 10:00' }];

test('the prompt template: the skill\'s text block, with every placeholder; short enough for a small local model', () => {
  const t = P.readTemplate(ROOT);
  for (const k of ['{{FLAGGED}}', '{{CATEGORIES}}', '{{FILES}}', '{{MAX}}']) assert.ok(t.includes(k), k);
  assert.ok(t.length < 2500, `${t.length} characters`);
  assert.match(t, /You propose\. Code tests your edit/);
  const prompt = P.selfReviewPrompt({ template: t, flagged, files: P.editableFiles(ROOT), maxProposals: 2 });
  assert.ok(prompt.startsWith(`${P.MARKER}\n`));
  assert.match(prompt, /1\. 2022-03-09 09:40 MNQ: wrong stated reason\. Expected: take fx_break\. You did: none\. Why flagged: skipped citing the opening window\. False reasons: "opening window until 10:00"/);
  assert.match(prompt, /skills\/session-timing\/SKILL\.md/);
  assert.match(prompt, /strategies\/prop_portfolio\/STRATEGY\.md/);
  assert.doesNotMatch(prompt, /skills\/training-loop\/SKILL\.md|skills\/training-verdict\/SKILL\.md|skills\/design-self-review\/SKILL\.md/, 'never the loop\'s own skills');
  assert.doesNotMatch(prompt, /\{\{/);
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'skills', 'design-self-review'), { recursive: true });
  fs.writeFileSync(path.join(dir, P.SKILL), '# x\n\n### The prompt\n\n```text\nno placeholders\n```\n');
  assert.throws(() => P.readTemplate(dir), /has no \{\{FLAGGED\}\}/);
});

test('proposerEnv: a scratch home with the kill switch on, paper mode, and every live broker\'s variables disabled', () => {
  const home = tmpDir();
  const base = { PATH: process.env.PATH, FTH_HOME: home };
  homeBrokers(home, {}, { broker: 'fake', env: base });
  const brokers = JSON.parse(fs.readFileSync(base.FTH_BROKERS_FILE, 'utf8')).brokers;
  const liveVar = brokers.fake.env[0];
  base[liveVar] = 'secret';
  const scratch = path.join(tmpDir(), 'proposer');
  const env = P.proposerEnv(base, scratch);
  assert.strictEqual(env.FTH_HOME, scratch);
  assert.match(fs.readFileSync(env.FTH_KILL_SWITCH_FILE, 'utf8'), /never trades/);
  assert.strictEqual(env.FTH_PAPER, '1');
  assert.strictEqual(env[liveVar], 'disabled-by-fth-replay');
  assert.ok(env.FTH_GATE_LOG.startsWith(scratch));
});

test('propose: the runner config\'s harness CLI, built as the runner builds it, in its own tree; PROPOSAL lines read, the prompt\'s own example never', async () => {
  const proposal = { targets: ['wrong stated reason'], expects: 'x', edits: [{ file: 'skills/a/SKILL.md', find: 'a', replace: 'b' }] };
  const base = { PATH: process.env.PATH, HOME: tmpDir(), FAKE_HARNESS_PROPOSALS: JSON.stringify([proposal, proposal, { ...proposal, expects: 'y' }]) };
  homeBrokers(base.HOME, {}, { broker: 'fake', env: base });
  const cfg = validateConfig({ harness: 'custom', command: [process.execPath, HARNESS, '{prompt}'], symbols: ['MNQ'], timeframe: 3 });
  const home = path.join(tmpDir(), 'home');
  const res = await P.propose({ cfg, tree: ROOT, flagged, home, baseEnv: base, maxProposals: 2 });
  assert.strictEqual(res.code, 0);
  // The fake harness echoes the prompt (its example PROPOSAL line among it): not a proposal.
  assert.match(res.output, /prompt=FTH-SELF-REVIEW/);
  assert.deepStrictEqual(res.proposals.map(p => p.proposal.expects), ['x', 'y']);
  assert.ok(fs.existsSync(path.join(home, 'output.txt')));
  // Any runner: a stub run sees the argv buildCommand makes and the isolated env.
  let seen = null;
  await P.propose({ cfg, tree: ROOT, flagged, home, baseEnv: base, run: async (argv, opts) => { seen = { argv, opts }; return { code: 0, output: 'NO PROPOSAL' }; } });
  assert.deepStrictEqual(seen.argv.slice(0, 2), [process.execPath, HARNESS]);
  assert.ok(seen.argv[2].startsWith(P.MARKER));
  assert.deepStrictEqual([seen.opts.cwd, seen.opts.env.FTH_HOME, seen.opts.env.FTH_PAPER], [ROOT, home, '1']);
});

'use strict';

// Phase 2's real reports from a 10-session continuous-combine replay (fix/phase2-verdict-parsing, owner-approved
// 2026-10-24), kept as fixtures (tests/fixtures/phase2-reports/, the account renamed to the fixture account): each wrote
// an approving VERDICT line, and the runner read it as a veto (prose naming "the verdict" mid-line) or as an approval
// with no size (a Size line in prose). The decision reader now reads a keyword only where it starts its line (or labels
// a value with ':'), and a prose Size line binds only by its cuts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../../scripts/lib/trading/roles-ran');

const DIR = path.join(__dirname, '..', 'fixtures', 'phase2-reports');
const read = name => fs.readFileSync(path.join(DIR, name), 'utf8');
// Each report and the size its approving VERDICT line states (and every cut in it binds to).
const APPROVED = {
  '2021-05-03T145702Z-reads-as-veto.txt': 5,
  '2021-05-04T145418Z-reads-as-veto.txt': 3,
  '2021-05-07T142116Z-reads-as-veto.txt': 4,
  '2021-05-07T142417Z-reads-as-veto.txt': 4,
  '2021-05-11T150314Z-reads-as-veto.txt': 3,
  '2021-05-12T135121Z-reads-as-veto.txt': 5,
  '2021-05-10T142415Z-size-unreadable.txt': 3,
  '2021-05-11T153914Z-size-unreadable.txt': 4,
  '2021-05-14T141202Z-size-unreadable.txt': 5,
};
// Its "8 Decision:" line starts the line and decides "the" ("8 Decision: the composed trade passes ..."): a step-8
// line phase 2 is taught never to write, whose first word is no approval. It stays a veto (fails closed): a line-start
// decision in prose can refuse ("8. **Decision:** The setup is sound ... Stand aside." in the same replay).
const STILL_VETO = '2021-05-04T154822Z-reads-as-veto.txt';
const withoutFacts = t => t.split('\n').filter(l => !/^FACTS:/.test(l)).join('\n');

test('the fixtures are the replay\'s reports: every one has an approving VERDICT line, and none is left out', () => {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.txt')).sort();
  assert.deepStrictEqual(files, [...Object.keys(APPROVED), STILL_VETO].sort());
  for (const f of files) assert.match(read(f), /^VERDICT: APPROVE - size \d+/m, f);
});

test('each real report now approves, with the size its VERDICT line states; decisiveLine is that line', () => {
  for (const [f, size] of Object.entries(APPROVED)) {
    const t = read(f);
    assert.strictEqual(R.verdictOf(t), 'APPROVE', `${f}: ${R.verdictProblem(t)}`);
    assert.strictEqual(R.verdictProblem(t), null, f);
    assert.strictEqual(R.approvalReadAsVeto(t), null, f);
    assert.deepStrictEqual(R.approvedSize(t), { size }, f);
    assert.match(R.decisiveLine(t), new RegExp(`^VERDICT: APPROVE - size ${size},`), f);
    // The gate's phase2-size check: at the size goes, over it refuses.
    assert.strictEqual(R.sizeRefusal({ text: t }, size), null, f);
    assert.match(R.sizeRefusal({ text: t }, size + 1), new RegExp(`is over the ${size} risk-manager phase 2 approved`), f);
  }
});

test('the step-8 prose decision still vetoes (no loosening of a line-start decision)', () => {
  const t = read(STILL_VETO);
  assert.strictEqual(R.verdictOf(t), 'VETO');
  assert.match(R.verdictProblem(t), /^a decision line decides the, not APPROVE \("8 Decision: the composed trade/);
  assert.deepStrictEqual(R.approvalReadAsVeto(t).line.slice(0, 22), 'VERDICT: APPROVE - siz');
});

test('a genuine veto beside each real approval still vetoes, in every form', () => {
  const refusals = [
    'VERDICT: VETO - room: stand aside', 'VETO: no room to the target', 'Decision: pass', '8 Decision: skip - no room', '8. **Decision:** stand aside',
    '**Step 8, decision:** pass', 'PLAN 8 Decision: pass on the size check', '- Decision: wait', '> Final verdict: reject',
    '## Decision: skip', '# Verdict\nPASS', 'the plan was VETOED on room', 'Sizing verdict: skip x0.5', 'Room is short | final decision: skip',
    'the verdict is veto', 'Room is short, my verdict \u2014 skip', 'the final verdict - pass', 'overall decision \u2192 wait',
  ];
  for (const f of Object.keys(APPROVED)) {
    const t = withoutFacts(read(f));
    for (const r of refusals) {
      for (const text of [`${r}\n${t}`, `${t}\n${r}`]) assert.strictEqual(R.verdictOf(text), 'VETO', `${f} + ${JSON.stringify(r)}`);
    }
  }
});

test('with its VERDICT line gone, no real report approves: no trade, no size', () => {
  for (const f of [...Object.keys(APPROVED), STILL_VETO]) {
    const t = read(f).split('\n').filter(l => !/^VERDICT:/.test(l)).join('\n');
    assert.notStrictEqual(R.verdictOf(t), 'APPROVE', f);
    assert.ok(R.approvedSize(t).error, f);
  }
});

test('a keyword mid-line is prose: it neither approves nor refuses; a line-start keyword decides', () => {
  const V = 'VERDICT: APPROVE - size 3, risk $150, trade_lifecycle long';
  for (const prose of ['Budget: per trade $600.60 (the verdict\'s size rule applies)', 'Total exposure stays under the 28-MNQ verdict ceiling.',
    'Account active with a short verdict up to 11 MNQ.', 'we hold a decision on the target for later', 'Phase 1\'s verdict on record holds',
    'Size stays at the verdict\'s 4, not stepped up', 'our decision-making stays the same']) {
    assert.strictEqual(R.verdictOf(`${prose}\n${V}`), 'APPROVE', prose);
    assert.deepStrictEqual(R.decisionLines(prose), [], prose);
  }
  // Mid-line, never an approval: no approving line, no trade.
  for (const t of ['as the VERDICT: APPROVE - size 3 says', 'the plan, VERDICT: APPROVE - size 3']) assert.strictEqual(R.verdictOf(t), null, t);
  // Line start after markers, numbering, quotes, markup and the labels: decides.
  for (const t of ['VERDICT: APPROVE - size 3', '**Verdict:** APPROVE - size 3', '- VERDICT: APPROVE - size 3', '8 VERDICT: APPROVE - size 3', '8. **Verdict:** APPROVE - size 3',
    '> "VERDICT: APPROVE - size 3"', 'Final VERDICT: APPROVE - size 3', 'Phase 2 VERDICT: APPROVE - size 3', 'PLAN 8 VERDICT: APPROVE - size 3', '| VERDICT | APPROVE | size 3 |']) {
    assert.strictEqual(R.verdictOf(t), 'APPROVE', t);
  }
});

test('a prose Size line: no error; every cut in it binds, the smaller of it and the VERDICT size; an unreadable cut or size word fails closed', () => {
  const A = n => `VERDICT: APPROVE - size ${n}, risk $150`;
  for (const [text, size] of [
    [`- **Size:** order_plan gives 4 MNQ at $65.24 all in. I cut to 3 on serious against.\n${A(3)}`, 3],
    [`- **Size:** order_plan gives 4 MNQ at $65.24 all in. I cut to 3 on serious against.\n${A(4)}`, 3],
    [`- **Size:** I cut the translated 17 to 5. The trade is unproven.\n${A(5)}`, 5],
    [`- **Size:** I cut the translated 17 to 5.\n${A(8)}`, 5],
    [`- **Size:** the translated 8 is halved to 4, under the cushion cap.\n${A(4)}`, 4],
    [`- **Size:** the translated 8 is at risk $280 before fees. Half of 8 is 4. I'm not cutting below the floor of 3.\n${A(4)}`, 4],
    [`Size: the translated 6 stands (no step)\n${A(6)}`, 6],
    [`Size: the record's 9 trimmed to 7, then reduced to 6\n${A(8)}`, 6],
    [`Size: 2 (the record's 2)\n${A(3)}`, 2], // a number first still reads as the size
  ]) assert.deepStrictEqual(R.approvedSize(text), { size }, text);
  for (const text of [
    `- **Size:** I cut it to fit the cap.\n${A(3)}`, // a cut to no number
    `- **Size:** half of the translated 8\n${A(4)}`, `Size: none\n${A(1)}`, `Size: one contract\n${A(1)}`,
    `Size: I cut to 0\n${A(1)}`, `Size: I cut the 8 to 1.5\n${A(1)}`, `Size: 0\n${A(1)}`, `Size: 1-2\n${A(1)}`,
    'Size: the translated 4\nVERDICT: APPROVE - risk $150', // the VERDICT line still states its size
  ]) assert.ok(R.approvedSize(text).error, text);
});

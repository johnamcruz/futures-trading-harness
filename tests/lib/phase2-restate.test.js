'use strict';

// Phase 2's restatement (scripts/lib/trading/phase2-restate.js, feat/phase2-restate-retry, owner-approved 2026-10-24):
// when its approving VERDICT line is refused by the strict reading, the runner asks once for `Size: <n>` and the
// VERDICT line, reads the answer with the same readers, and binds its size to the first VERDICT line's. On the replay's
// real reports (tests/fixtures/phase2-reports/).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../../scripts/lib/trading/phase2-restate');
const R = require('../../scripts/lib/trading/roles-ran');
const F = require('../../scripts/lib/trading/fact-claims');
const { restate } = require('../../scripts/lib/orchestrate/requests');

const DIR = path.join(__dirname, '..', 'fixtures', 'phase2-reports');
const read = name => fs.readFileSync(path.join(DIR, name), 'utf8');
// The three prose Size lines (no size the reading takes) and the one approval read as a veto, with their VERDICT sizes.
const PROSE = { '2021-05-10T142415Z-size-unreadable.txt': 3, '2021-05-11T153914Z-size-unreadable.txt': 4, '2021-05-14T141202Z-size-unreadable.txt': 5 };
const READ_AS_VETO = '2021-05-04T154822Z-reads-as-veto.txt';
const READS_FINE = ['2021-05-03T145702Z-reads-as-veto.txt', '2021-05-04T145418Z-reads-as-veto.txt', '2021-05-07T142116Z-reads-as-veto.txt', '2021-05-07T142417Z-reads-as-veto.txt', '2021-05-11T150314Z-reads-as-veto.txt', '2021-05-12T135121Z-reads-as-veto.txt'];

test('verdictSize: the approving VERDICT lines alone (their sizes and cuts), never the Size line or prose', () => {
  for (const [f, size] of Object.entries(PROSE)) assert.deepStrictEqual(R.verdictSize(read(f)), { size }, f);
  assert.deepStrictEqual(R.verdictSize(read(READ_AS_VETO)), { size: 3 });
  assert.deepStrictEqual(R.verdictSize('Size: 1\nVERDICT: APPROVE - size 4, risk $80'), { size: 4 }, 'the Size line is not the VERDICT line');
  assert.deepStrictEqual(R.verdictSize('VERDICT: APPROVE - size 4 cut to 2, risk $40'), { size: 2 }, 'a cut on it binds');
  assert.match(R.verdictSize('VERDICT: APPROVE - risk $80').error, /no whole size/);
  assert.deepStrictEqual(R.verdictSize('VERDICT: VETO - room'), { error: 'no approving VERDICT line' });
});

test('restateDue: an approving VERDICT line the reading refuses (a prose Size line, or a line read as a refusal), bounded by its VERDICT size; never a plain veto, no verdict, or an approval that reads fine', () => {
  for (const [f, ceiling] of Object.entries(PROSE)) {
    const d = P.restateDue(read(f));
    assert.deepStrictEqual([d.kind, d.ceiling], ['size-unreadable', ceiling], f);
    assert.match(d.why, /^your size can't be read as one whole number \(the line "Size: /, f);
    // The report's own words, never the reader's internals.
    assert.doesNotMatch(d.why, /binds|share with no cut|approvedSize|decides/, f);
  }
  const v = P.restateDue(read(READ_AS_VETO));
  assert.deepStrictEqual([v.kind, v.ceiling], ['reads-as-veto', 3]);
  assert.strictEqual(v.why, 'your VERDICT line approves, but the line "8 Decision: the composed trade passes every step of the priority order: no hard stop, no trend against, R:R at the 2.00 floor, the plan\'s stop and target on the correct sides." reads as a refusal');
  assert.doesNotMatch(v.why, /decides the, not APPROVE/);
  for (const f of READS_FINE) assert.strictEqual(P.restateDue(read(f)), null, f);
  for (const t of ['VERDICT: VETO - room: stand aside\nFACTS: window asia', 'Phase 2 notes, no verdict', 'VERDICT: maybe', '']) assert.strictEqual(P.restateDue(t), null, t);
  // An approval with no VERDICT size: nothing bounds a restatement, so none.
  assert.strictEqual(P.restateDue('Size: half\nVERDICT: APPROVE - risk $20\nFACTS: none'), null);
  assert.strictEqual(P.restateDue('Decision: cut to size 1\nVERDICT: APPROVE - risk $20\nFACTS: none'), null);
});

test('readRestatement: the same readers; the size at most the first VERDICT line\'s; a veto is a veto; anything else unreadable', () => {
  const first = read('2021-05-11T153914Z-size-unreadable.txt'); // VERDICT size 4
  const facts = F.factsFrom(first);
  // The two lines, at the bound: approved 4, the decisive record the answer, the bound and the first report's FACTS.
  let r = P.readRestatement(first, 'Size: 4\nVERDICT: APPROVE - size 4, risk $140', 4);
  assert.deepStrictEqual([r.outcome, r.size, r.line], ['approved', 4, 'VERDICT: APPROVE - size 4, risk $140']);
  assert.strictEqual(r.text, `Size: 4\nVERDICT: APPROVE - size 4, risk $140\nSize: 4\n${facts}`);
  assert.deepStrictEqual([R.verdictOf(r.text), R.approvedSize(r.text)], ['APPROVE', { size: 4 }]);
  assert.deepStrictEqual(F.factsLines(r.text), F.factsLines(first), 'its facts are the first report\'s');
  assert.strictEqual(F.checkFacts(r.text, null).labels, 1, 'one FACTS line, last');
  // A smaller size: it binds.
  r = P.readRestatement(first, 'Size: 3\nVERDICT: APPROVE - size 3, risk $105', 4);
  assert.deepStrictEqual([r.outcome, r.size, R.approvedSize(r.text)], ['approved', 3, { size: 3 }]);
  // Larger than the first VERDICT line's: bound to it, in the record the gate reads too.
  r = P.readRestatement(first, 'Size: 9\nVERDICT: APPROVE - size 9, risk $315', 4);
  assert.deepStrictEqual([r.outcome, r.size, R.approvedSize(r.text)], ['approved', 4, { size: 4 }]);
  assert.match(R.sizeRefusal({ text: r.text }, 5), /size 5 is over the 4 risk-manager phase 2 approved/);
  assert.match(R.sizeRefusal({ text: r.text }, 9), /size 9 is over the 4/);
  assert.strictEqual(R.sizeRefusal({ text: r.text }, 4), null);
  // Its own FACTS line is dropped (one FACTS line: the first report's).
  r = P.readRestatement(first, 'Size: 4\nVERDICT: APPROVE - size 4, risk $140\nFACTS: window asia', 4);
  assert.deepStrictEqual([r.outcome, F.factsLines(r.text)], ['approved', F.factsLines(first)]);
  // A veto.
  r = P.readRestatement(first, 'VERDICT: VETO - room: stand aside', 4);
  assert.deepStrictEqual(r, { outcome: 'vetoed', line: 'VERDICT: VETO - room: stand aside' });
  // Unreadable: garbage, no verdict, a prose size again, an approval that reads as a veto again, nothing, no bound.
  for (const answer of ['Restated as asked.', 'Size: 4', 'Size: four\nVERDICT: APPROVE - size 4', 'VERDICT: APPROVE - size <n>', 'Decision: cut to size 1\nVERDICT: APPROVE - size 1', '', '   ']) {
    assert.strictEqual(P.readRestatement(first, answer, 4).outcome, 'unreadable', JSON.stringify(answer));
  }
  // The decisive record is read again: a first report whose FACTS block itself reads as a veto never makes one.
  const vetoFacts = 'Size: 2\nVERDICT: APPROVE - size 2, risk $40\nFACTS: window asia; no VETO rule fired';
  assert.strictEqual(P.restateDue(vetoFacts).kind, 'reads-as-veto');
  r = P.readRestatement(vetoFacts, 'Size: 2\nVERDICT: APPROVE - size 2, risk $40', 2);
  assert.deepStrictEqual(r, { outcome: 'unreadable', why: 'the restatement with the first report\'s facts is no single approval of its size' });
  for (const bad of [null, 0, 1.5, '4']) assert.strictEqual(P.readRestatement(first, 'Size: 4\nVERDICT: APPROVE - size 4', bad).outcome, 'unreadable', String(bad));
});

test('readRestatement on the approval read as a veto: its FACTS block (before its VERDICT line) carried whole, last', () => {
  const first = read(READ_AS_VETO);
  const r = P.readRestatement(first, 'Size: 3\nVERDICT: APPROVE - size 3, risk $295.50', 3);
  assert.deepStrictEqual([r.outcome, r.size], ['approved', 3]);
  assert.ok(r.text.endsWith('FACTS: window lunch lull; entries allowed; news clear; trend short allowed; vwap below; read short mixed; 15m range; 1h range'), r.text);
  assert.strictEqual(R.verdictOf(r.text), 'APPROVE');
});

test('factsFrom and dropFactsLabels: the text from the first FACTS line to the end; the text without FACTS lines', () => {
  assert.strictEqual(F.factsFrom('VERDICT: APPROVE - size 1\nFACTS: window asia; news clear'), 'FACTS: window asia; news clear');
  assert.strictEqual(F.factsFrom('FACTS: window asia;\ntrend long blocked\nVERDICT: APPROVE - size 1'), 'FACTS: window asia;\ntrend long blocked\nVERDICT: APPROVE - size 1');
  assert.strictEqual(F.factsFrom('VERDICT: APPROVE - size 1'), null);
  assert.strictEqual(F.dropFactsLabels('Size: 1\nFACTS: x\nVERDICT: APPROVE - size 1\n**FACTS:** y'), 'Size: 1\nVERDICT: APPROVE - size 1');
});

test('readRestatement carries the first report\'s facts exactly (review finding 1): two FACTS lines, or a fact on a non-bullet continuation line, never pass through a restatement', () => {
  const A = 'Size: 2\nVERDICT: APPROVE - size 2, risk $40';
  // Two FACTS lines: the gate refuses the first report (labels > 1); no restatement makes it one.
  const two = 'Size: the record\'s 2, 1 category against\nVERDICT: APPROVE - size 2, risk $40\nFACTS: window asia; trend long allowed\nFACTS: 15m up';
  assert.ok(P.restateDue(two));
  assert.deepStrictEqual(P.readRestatement(two, A, 2), { outcome: 'unreadable', why: 'the first report has no single FACTS line' });
  // A non-bullet continuation holding a false fact: carried whole, so the gate checks it as on main.
  const cont = 'Size: the record\'s 2, 1 category against\nVERDICT: APPROVE - size 2, risk $40\nFACTS: window asia;\ntrend long blocked; 15m range';
  const r = P.readRestatement(cont, A, 2);
  assert.strictEqual(r.outcome, 'approved');
  assert.deepStrictEqual(F.factsLines(r.text), ['window asia', 'trend long blocked', '15m range']);
  assert.deepStrictEqual(F.factsLines(r.text), F.factsLines(cont), 'the same items the gate read in the first report');
  // FACTS before the VERDICT line (the 05-04 report): reordered, the VERDICT and Size lines out of the block, no fact changed.
  const before = 'Size: the record\'s 2, 1 category against\nFACTS: window asia; trend long allowed\nVERDICT: APPROVE - size 2, risk $40\nSize: 2';
  const b = P.readRestatement(before, A, 2);
  assert.deepStrictEqual([b.outcome, F.factsLines(b.text)], ['approved', ['window asia', 'trend long allowed']]);
  // A prose line after the FACTS line stays an item (the gate refuses it as no known form, as on main).
  const prose = 'Size: the record\'s 2, 1 category against\nVERDICT: APPROVE - size 2, risk $40\nFACTS: window asia\nThat is all.';
  assert.deepStrictEqual(F.factsLines(P.readRestatement(prose, A, 2).text), ['window asia', 'that is all']);
});

test('restateDue never retries a real veto (review finding 2): a VETO VERDICT line beside an approving one, either order; a VERDICT line saying veto', () => {
  for (const t of [
    'VERDICT: VETO - room: stand aside\nVERDICT: APPROVE - size 2, risk $40\nFACTS: window asia',
    'VERDICT: APPROVE - size 2, risk $40\nVERDICT: VETO - room: stand aside\nFACTS: window asia',
    'VERDICT: APPROVE - size 2, not a veto of the side\nFACTS: window asia',
    'The verdict is veto.\nVERDICT: APPROVE - size 2\nFACTS: window asia',
    'Sizing verdict: skip x0.5\nVERDICT: APPROVE - size 2\nFACTS: window asia',
  ]) assert.strictEqual(P.restateDue(t), null, t);
  // A refusal from a non-VERDICT decision line or prose is restated.
  assert.strictEqual(P.restateDue('Decision: cut to size 1\nVERDICT: APPROVE - size 2\nFACTS: window asia').kind, 'reads-as-veto');
  assert.strictEqual(P.restateDue('No VETO rules apply.\nVERDICT: APPROVE - size 2\nFACTS: window asia').kind, 'reads-as-veto');
});

test('the ceiling is every size the first report stated (review finding 3): the VERDICT size, number-led Size lines and their cuts, prose cuts; a Size line stating no size: no restatement', () => {
  const ceiling = t => { const d = P.restateDue(t); return d ? d.ceiling : null; };
  assert.strictEqual(ceiling('Size: 0 (none)\nVERDICT: APPROVE - size 1\nFACTS: window asia'), null);
  assert.strictEqual(ceiling('Size: none\nVERDICT: APPROVE - size 2\nFACTS: window asia'), null);
  assert.strictEqual(ceiling('Size: n/a\nVERDICT: APPROVE - size 2\nFACTS: window asia'), null);
  // (It reads fine on its own, so no restatement; with a count under its cut it is unreadable, and its cut bounds it.)
  assert.strictEqual(P.restateDue('Size: the translated 4, I cut to 2 on serious against\nVERDICT: APPROVE - size 4\nFACTS: window asia'), null);
  assert.strictEqual(ceiling('Size: the translated 4, I cut to 2 on serious against, 1 category against\nVERDICT: APPROVE - size 4\nFACTS: window asia'), 2);
  // A number-led Size line binds; an unmade prose cut ("I would cut to half") lowers nothing: the ceiling is 2.
  assert.strictEqual(ceiling('Size: 2\nSize: I would cut to half\nVERDICT: APPROVE - size 4\nFACTS: window asia'), 2);
  assert.strictEqual(ceiling('Size: 3 cut to 2\nSize: the 3 holds, 1 against\nVERDICT: APPROVE - size 4\nFACTS: window asia'), 2);
  assert.strictEqual(ceiling('Size: one, at the floor of 3\nVERDICT: APPROVE - size 3\nFACTS: window asia'), 1);
  assert.strictEqual(ceiling('Size: 1.5\nSize: the 2 holds, 1 against\nVERDICT: APPROVE - size 2\nFACTS: window asia'), null);
  assert.deepStrictEqual(R.restateCeiling('Size: 4\nVERDICT: APPROVE - size 5'), { size: 4 });
});

test('readRestatement keeps to the order\'s symbol (review finding 5): a first report about another cycle symbol is unreadable', () => {
  const first = 'Size: the record\'s 2 on MES, 1 against\nVERDICT: APPROVE - size 2, MES long\nFACTS: window asia';
  const A = 'Size: 2\nVERDICT: APPROVE - size 2';
  assert.deepStrictEqual(P.readRestatement(first, A, 2, { root: 'MNQ', symbols: ['MNQ', 'MES'] }), { outcome: 'unreadable', why: 'the first report is about MES, not MNQ' });
  assert.strictEqual(P.readRestatement(first, A, 2, { root: 'MES', symbols: ['MNQ', 'MES'] }).outcome, 'approved');
  assert.strictEqual(P.readRestatement(`${first} MNQ`, A, 2, { root: 'MNQ', symbols: ['MNQ', 'MES'] }).outcome, 'approved', 'naming the order\'s symbol too, as the gate reads it');
  assert.deepStrictEqual(F.otherSymbols(first, 'MNQ', ['MNQ', 'MES']), ['MES']);
});

test('the handed line states the bound (review finding 6): an answer over it is rewritten to the bound, never "size 9"', () => {
  const first = read('2021-05-11T153914Z-size-unreadable.txt');
  const r = P.readRestatement(first, 'Size: 9\nVERDICT: APPROVE - size 9, risk $315', 4);
  assert.strictEqual(r.line, 'VERDICT: APPROVE - size 4, restated (it said 9; at most the 4 the first report stated)');
  assert.deepStrictEqual(R.approvedSize(r.line), { size: 4 });
  assert.strictEqual(P.readRestatement(first, 'Size: 3\nVERDICT: APPROVE - size 3, risk $105', 4).line, 'VERDICT: APPROVE - size 3, risk $105');
});

test('the restate request: what couldn\'t be read, the two lines, the bound, the first report; nothing else asked', () => {
  const d = P.restateDue(read(READ_AS_VETO));
  const req = restate('risk-manager', { symbol: 'MNQ', contractId: 'MNQ', at: '2021-05-04T15:48:22.000Z', timeframe: 3, why: d.why, ceiling: d.ceiling, report: read(READ_AS_VETO) });
  assert.match(req, /^Phase 2, restate, for MNQ \(contractId MNQ\) at the 3-minute bar that closed by 2021-05-04T15:48:22\.000Z\. The runner can't read your phase 2 report below as an approval: your VERDICT line approves, but the line "8 Decision: /);
  assert.ok(req.includes('Restate it in two lines and nothing else (no tools, no reasoning): `Size: <n>` (the number alone, at most the 3 your VERDICT line approved), then your `VERDICT: APPROVE - size <n>, ...` line. If you don\'t approve the plan, write only your `VERDICT: VETO - <reason>` line.'), req);
  assert.ok(req.includes(`--- your phase 2 report ---\n${read(READ_AS_VETO).trim()}\n--- end of your phase 2 report ---`));
});

test('the run report counts the restatements by outcome (approved: rescued), from the cycle log line through the replay store', () => {
  const store = require('../../scripts/lib/replay/store');
  const report = require('../../scripts/lib/replay/report');
  const line = (outcome, extra = {}) => ({ action: 'trade', at: '2026-03-02T15:00:00.000Z', ok: true, result: 'CYCLE RESULT: no-trade - x', entry: { outcome: 'x', ran: [], restated: { kind: 'size-unreadable', outcome, ...extra } } });
  const ran = [line('approved', { size: 4 }), line('approved', { size: 3 }), line('vetoed'), line('unreadable'), { action: 'trade', at: '2026-03-02T15:03:00.000Z', ok: true, result: 'CYCLE RESULT: no-trade - y' }].map(store.cycleSummary);
  assert.deepStrictEqual(ran[0].restated, { kind: 'size-unreadable', outcome: 'approved', size: 4 });
  assert.ok(!('restated' in ran[4]), 'none restated: nothing added');
  const sum = report.summarize({ '2026-03-02': [{ kind: 'trade', ran, trades: [] }] });
  assert.deepStrictEqual(sum.total.restated, { approved: 2, vetoed: 1, unreadable: 1 });
  const text = 'Phase 2 restated 4 approvals the runner couldn\'t read (approved 2, unreadable 1, vetoed 1): 2 rescued.';
  assert.strictEqual(report.restatedLine(sum.total), text);
  assert.ok(report.toMarkdown(sum).includes(text) && report.toText(sum).includes(text));
  // A run without any: no key, no line (the report as before).
  const none = report.summarize({ '2026-03-02': [{ kind: 'trade', ran: [ran[4]], trades: [] }] });
  assert.ok(!('restated' in none.total));
  assert.strictEqual(report.restatedLine(none.total), null);
  assert.ok(!/restated/.test(report.toText(none)));
});

test('config: entry.phase2RestateRetries is 1 (on), 0 turns it off, and more than one is refused', () => {
  const T = require('../../scripts/lib/tunables');
  assert.strictEqual(T.runner().entry.phase2RestateRetries, 1);
  const at = v => { const c = JSON.parse(JSON.stringify(T.runner())); c.entry.phase2RestateRetries = v; return T.SPECS.runner.validate(c); };
  assert.deepStrictEqual(at(0), []);
  for (const v of [2, -1, 0.5, '1']) assert.ok(at(v).length > 0, String(v));
});

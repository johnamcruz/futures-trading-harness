'use strict';

// The structure-read truth (scripts/lib/learning/structure-read.js): every field read from the briefing's own printed
// facts (the code's output for that bar), an answer kept only when it is exactly the truth, and the code-built answer.

const test = require('node:test');
const assert = require('node:assert');
const SR = require('../../scripts/lib/learning/structure-read');
const { briefing } = require('../fixtures/structure-briefing');

const wrap = b => `Cycle prompt before.\n\n${b}\nAfter the briefing: the account.\n`;

test('briefingOf: the bar_briefing block of a cycle prompt, its end line included; none, unfinished or two: null', () => {
  const b = briefing();
  assert.strictEqual(SR.briefingOf(wrap(b)), b);
  assert.strictEqual(SR.briefingOf('no briefing'), null);
  assert.strictEqual(SR.briefingOf(b.slice(0, b.indexOf('--- end of'))), null);
  assert.strictEqual(SR.briefingOf(`${b}${b}`), null, 'two briefings: which one is read is ambiguous');
  assert.strictEqual(SR.symbolOf(b), 'MNQ');
  assert.strictEqual(SR.symbolOf(briefing({ symbol: 'MES' })), 'MES');
});

test('truthOf structure: each field from the printed facts', () => {
  const t = SR.truthOf(briefing());
  assert.deepStrictEqual(t.structure, {
    b3_last: 'CHoCH up', b3_prev: 'BOS down', prot_price: 13990.25, prot_status: 'holding', b15_last: 'BOS up',
    cisd3: 'bullish strong', cisd15: 'none', pullback: 'yes', pb_depth: 38, alt_choch: 'no', day_so_far: 'trending up', vwap_crosses: 2, guard15: 'yes',
  });
  assert.strictEqual(t.regime, 'pullback');
  assert.strictEqual(t.case, 'potential reversal');
});

test('truthOf structure: the edge cases (broken swing, alternating CHoCHs, no lines printed, a 15m BOS before the open, a given-back pullback)', () => {
  const s = o => SR.truthOf(briefing(o)).structure;
  assert.strictEqual(s({ last: { kind: 'BOS', direction: 'up', protected: { level: 14000.5, brokenAt: '09:57' } } }).prot_status, 'broken');
  assert.strictEqual(s({ last: { kind: 'BOS', direction: 'up' } }).prot_price, 'none', 'no protected swing printed');
  assert.strictEqual(s({ last: { kind: 'CHoCH', direction: 'up' }, previous: { kind: 'CHoCH', direction: 'down' } }).alt_choch, 'yes');
  const none = s({ last: null, previous: null, last15: null, prev15: null, cisd3: 'unavailable', daySoFar: null, pullback: null });
  assert.deepStrictEqual([none.b3_last, none.b3_prev, none.b15_last, none.cisd3, none.pullback, none.pb_depth, none.day_so_far, none.vwap_crosses, none.guard15], ['none', 'none', 'none', 'none', 'no', 'none', 'none', 'none', 'no']);
  assert.strictEqual(s({ last15: { kind: 'BOS', direction: 'up', knownAt: '09:15' }, prev15: { kind: 'BOS', direction: 'up', knownAt: '03-06 15:00' } }).guard15, 'no', 'known before the open, or another day');
  assert.strictEqual(s({ last15: { kind: 'CHoCH', direction: 'up', knownAt: '09:45' }, prev15: { kind: 'BOS', direction: 'down', knownAt: '09:30' } }).guard15, 'yes', 'the previous 15m break, at the open');
  const back = SR.truthOf(briefing({ pullback: '- Pullback (15m, long leg 13980 -> 14030): given back past its origin.' }));
  assert.deepStrictEqual([back.structure.pullback, back.structure.pb_depth, back.regime], ['no', 'none', 'trend']);
  assert.strictEqual(SR.truthOf(briefing({ daySoFar: '- Day so far: too early (3 bars).' })).structure.day_so_far, 'too early');
  assert.strictEqual(SR.truthOf(briefing({ daySoFar: '- Day so far: unknown (no 09:30 ET bar in the data).' })).structure.vwap_crosses, 'none');
});

test('truthOf: a printed fact it can\'t read gives no truth for that instruction, never a guess', () => {
  assert.strictEqual(SR.truthOf(briefing({ pullback: '- Pullback (15m, long leg 13980 -> 14030): 4 bars since the extreme.' })).structure, null, 'a pullback without its depth');
  assert.strictEqual(SR.truthOf(briefing({ daySoFar: '- Day so far (10 3m bars): something new.' })).structure, null, 'a Day so far word it can\'t read');
  const broken = SR.truthOf(briefing({ m3Broken: true }));
  assert.deepStrictEqual([broken.structure, broken.sequence], [null, null], 'an unreadable detail line');
  assert.deepStrictEqual(SR.truthOf('no briefing'), { structure: null, sequence: null, case: null, regime: null });
});

test('truthOf sequence: the owner\'s table (continuation, potential, confirmed and failed reversal) and its invalidation', () => {
  const q = (last, previous) => SR.truthOf(briefing({ last, previous })).sequence;
  const P = { level: 100.25, brokenAt: null };
  assert.deepStrictEqual(q({ kind: 'BOS', direction: 'up', protected: P }, { kind: 'BOS', direction: 'up' }), { seq: 'continuation', seq_dir: 'up', inv_level: 100.25, invalidated: 'no' });
  assert.strictEqual(q({ kind: 'BOS', direction: 'down' }, { kind: 'CHoCH', direction: 'down' }).seq, 'confirmed reversal');
  assert.strictEqual(q({ kind: 'CHoCH', direction: 'down' }, { kind: 'BOS', direction: 'up' }).seq, 'potential reversal');
  assert.strictEqual(q({ kind: 'CHoCH', direction: 'up' }, { kind: 'CHoCH', direction: 'down' }).seq, 'failed reversal');
  assert.strictEqual(q({ kind: 'BOS', direction: 'up' }, null).seq, 'continuation', 'no break before it');
  assert.strictEqual(q({ kind: 'CHoCH', direction: 'up' }, null).seq, 'potential reversal');
  assert.deepStrictEqual(q(null, null), { seq: 'none', seq_dir: 'none', inv_level: 'none', invalidated: 'no' });
  assert.strictEqual(q({ kind: 'BOS', direction: 'up', protected: { level: 99, brokenAt: '09:54' } }, null).invalidated, 'yes');
});

test('regime: pullback, else the Market state class (trend, chop, other)', () => {
  const r = o => SR.truthOf(briefing({ pullback: null, ...o })).regime;
  assert.strictEqual(r({}), 'trend');
  assert.strictEqual(r({ marketState: '- Market state (3m): chop: overlap 0.8; class chop.' }), 'chop');
  assert.strictEqual(r({ marketState: '- Market state (3m): forming; class unclear.' }), 'other');
  assert.strictEqual(r({ marketState: null }), 'other');
});

test('verifyAnswer: one JSON object with exactly the instruction\'s keys, each exactly the truth; anything else is not kept', () => {
  const truth = SR.truthOf(briefing()).sequence;
  const ok = JSON.stringify(truth);
  assert.deepStrictEqual(SR.verifyAnswer(ok, 'sequence', truth), { ok: true, wrong: [], why: null });
  assert.strictEqual(SR.verifyAnswer(`\n${ok}\n`, 'sequence', truth).ok, true, 'surrounding whitespace');
  assert.deepStrictEqual(SR.verifyAnswer(JSON.stringify({ ...truth, seq: 'continuation' }), 'sequence', truth).wrong, ['seq']);
  assert.deepStrictEqual(SR.verifyAnswer(JSON.stringify({ ...truth, inv_level: String(truth.inv_level) }), 'sequence', truth).wrong, ['inv_level'], 'a number as a string');
  assert.deepStrictEqual(SR.verifyAnswer(JSON.stringify({ ...truth, inv_level: truth.inv_level + 0.05 }), 'sequence', truth).wrong, ['inv_level'], 'a close number');
  assert.deepStrictEqual(SR.verifyAnswer(JSON.stringify({ ...truth, seq: 'Potential Reversal' }), 'sequence', truth).wrong, ['seq'], 'another spelling');
  assert.strictEqual(SR.verifyAnswer(`\`\`\`json\n${ok}\n\`\`\``, 'sequence', truth).ok, false, 'a code fence');
  assert.strictEqual(SR.verifyAnswer(`Here: ${ok}`, 'sequence', truth).ok, false, 'prose');
  assert.match(SR.verifyAnswer(JSON.stringify({ ...truth, class: 'trend-up' }), 'sequence', truth).why, /keys/, 'an extra key');
  const missing = { ...truth };
  delete missing.invalidated;
  assert.match(SR.verifyAnswer(JSON.stringify(missing), 'sequence', truth).why, /keys/);
  assert.strictEqual(SR.verifyAnswer('[1]', 'sequence', truth).ok, false);
  assert.strictEqual(SR.verifyAnswer(ok, 'sequence', null).ok, false, 'no truth: nothing verifies');
  assert.throws(() => SR.verifyAnswer(ok, 'class', truth), /no structure-read instruction/);
});

test('goldAnswer: the code-built answer verifies against its own truth; promptOf: the briefing, a blank line, the instruction', () => {
  const b = briefing({ symbol: 'MES' });
  const t = SR.truthOf(b);
  for (const kind of SR.KINDS) {
    const gold = SR.goldAnswer(kind, t[kind]);
    assert.deepStrictEqual(Object.keys(JSON.parse(gold)), SR.FIELDS[kind]);
    assert.strictEqual(SR.verifyAnswer(gold, kind, t[kind]).ok, true);
    const p = SR.promptOf(b, kind);
    assert.ok(p.startsWith(`${b}\n\n`) && p.includes('a bar briefing for MES at'));
    for (const f of SR.FIELDS[kind]) assert.ok(SR.INSTRUCTIONS[kind].includes(`"${f}"`), `${kind} names ${f}`);
  }
  assert.ok(SR.INSTRUCTIONS.structure.includes(`at or after ${SR.CASH_OPEN_ET} ET`));
  assert.throws(() => SR.promptOf('no header', 'sequence'), /names its symbol/);
});

test('review fixes: only a 3m lane; a CISD displacement it can\'t read; the answer\'s text must be canonical; asOf', () => {
  const oneMin = briefing().replace(/\nBar briefing MNQ 3m,/, '\nBar briefing MNQ 1m,');
  assert.deepStrictEqual(SR.truthOf(oneMin), { structure: null, sequence: null, case: null, regime: null }, 'a 1m lane prints its own bars under [m3]');
  assert.strictEqual(SR.truthOf(briefing({ cisd3: { dir: 'bullish', level: 1 } })).structure, null, 'no displacement printed: not guessed weak');
  const truth = SR.truthOf(briefing()).sequence;
  const ok = JSON.stringify(truth);
  assert.strictEqual(SR.verifyAnswer(JSON.stringify(truth, null, 2), 'sequence', truth).ok, true, 'whitespace outside strings');
  const dup = ok.replace('{', '{"seq":"continuation",');
  assert.strictEqual(SR.verifyAnswer(dup, 'sequence', truth).ok, false, 'a repeated key (JSON.parse keeps the last)');
  assert.strictEqual(SR.verifyAnswer(ok.replace('13990.25', '1.399025e4'), 'sequence', truth).ok, false, 'a number written another way');
  assert.strictEqual(SR.verifyAnswer(ok.replace('13990.25', '13990.2500000000000001'), 'sequence', truth).ok, false);
  assert.strictEqual(SR.verifyAnswer(ok.replace('"up"', '"\\u0075p"'), 'sequence', truth).ok, false, 'an escaped character');
  assert.strictEqual(SR.verifyAnswer(`\uFEFF${ok}`, 'sequence', truth).ok, false, 'a BOM');
  assert.strictEqual(SR.verifyAnswer(`\u00A0${ok}`, 'sequence', truth).ok, false, 'a no-break space around it');
  assert.strictEqual(SR.verifyAnswer(`${ok}\u3000\n`, 'sequence', truth).ok, false, 'an ideographic space around it');
  assert.strictEqual(SR.asOf(briefing({ t: '2022-03-07T15:00:00.000Z' })), '2022-03-07T15:00:00.000Z');
  assert.strictEqual(SR.asOf('no header'), null);
});

test('truthOf reads the briefing code\'s own output (the golden 3m views): every field readable, values the instruction allows', () => {
  const fs = require('fs');
  const path = require('path');
  const views = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'golden', 'views-MNQ-3m.txt'), 'utf8');
  // The golden views print the briefing's body; the cycle's header and end lines wrap it as the runner's prompt does.
  const bodies = views.split('\n--- bar_briefing ---\n').slice(1).map(b => b.split(/\n(?:=== |--- )/)[0]);
  assert.ok(bodies.length >= 3);
  const allowed = { b3_last: /^(BOS|CHoCH) (up|down)$|^none$/, cisd3: /^(bullish|bearish) (strong|weak)$|^none$/, pullback: /^(yes|no)$/, guard15: /^(yes|no)$/ };
  let read = 0;
  for (const body of bodies) {
    const b = `--- bar_briefing {"symbol":"MNQ"} as of 2026-04-24T04:48:00.000Z ---\n${body}\n--- end of bar_briefing {"symbol":"MNQ"} (sha256 x) ---\n`;
    const t = SR.truthOf(b);
    assert.ok(t.sequence, 'the sequence truth');
    if (!t.structure) continue;
    read += 1;
    for (const [f, re] of Object.entries(allowed)) assert.match(String(t.structure[f]), re, f);
    assert.ok(typeof t.structure.prot_price === 'number' || t.structure.prot_price === 'none');
  }
  assert.ok(read >= 1, 'at least one golden briefing reads whole');
  const oneMin = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'golden', 'views-MNQ-1m.txt'), 'utf8').split('\n--- bar_briefing ---\n')[1].split(/\n(?:=== |--- )/)[0];
  assert.strictEqual(SR.truthOf(`--- bar_briefing {"symbol":"MNQ"} as of x ---\n${oneMin}\n`).sequence, null, 'the 1m lane refused');
});

'use strict';

// The briefing patch (scripts/lib/eval/briefing-patch.js): a named region of a recorded prompt replaced, inserted or
// removed by a patch given as data, failing loudly on a missing or ambiguous anchor; the recorded briefing read back into
// the State line's inputs; stateLineFor with the frame-state module injected (stand-ins here, never the real module).

const test = require('node:test');
const assert = require('node:assert');
const B = require('../../scripts/lib/eval/briefing-patch');

const SUMMARY = [
  'Summary (MNQ 3m, 10:03 ET):',
  '- Session: opening drive (market open, entries allowed) until 11:00 ET.',
  '- Trend rule: SHORT allowed (prevailing 1h down); long only as a reversal (mtf: reversal).',
  '- Alignment: long mixed, short mixed. Regime: transition, high volatility.',
  '- 3m (entry candle, timing, closed 10:03): none, close bottom third, range 1.19 ATR, vol 1.41x, momentum down; swept the previous 3m high, closed back inside.',
  '- 5m (closed 10:00): displacement up, close top third, range 2 ATR, vol 2.07x; traded beyond the previous 5m high, closed above its high.',
  '- 15m (setup candle, closed 10:00): none, close top third, range 2.29 ATR, vol 5.23x, momentum up; traded beyond the previous 15m high, closed above its high; rejected session POC (closed back above).',
  '- 1h (closed 10:00): bullish engulfing, close top third, range 3.55 ATR, vol 5.22x, momentum up; traded beyond the previous 1h high and low, closed above its high; rejected overnight low (closed back above).',
  '- 4h (closed 10:00); swept the previous 4h low, closed back inside.',
];
const DETAIL = [
  'Detail by timeframe:',
  '[m3] version m3@2021-05-11T14:03:00.000Z, valid until 10:06 ET',
  '  et: 10:03',
  '  windowEntries: allowed',
  '  trendRule: Trend rule: SHORT allowed (prevailing 1h down); long only as a reversal (mtf: reversal).',
  '[m15] version m15@2021-05-11T14:00:00.000Z, valid until 10:15 ET',
  '  frame: {"trend":"range","bias":0}',
  '  lastBreak: {"last":{"kind":"CHoCH","direction":"up","level":13189.25,"at":"09:30","barsAgo":1,"knownAt":"09:45"}}',
  '[h1] version h1@2021-05-11T14:00:00.000Z, valid until 11:00 ET',
  '  h1: {"trend":"down","bias":-1}',
  '  h4: {"trend":"range","bias":0}',
  '  lastBreak: {"last":{"kind":"BOS","direction":"down","level":13140,"at":"07:00","knownAt":"05-10 21:00"}}',
];
const BRIEF = ['--- bar_briefing {"symbol":"MNQ"} as of 2021-05-11T14:03:00.000Z ---', 'Bar briefing MNQ 3m, bar 10:00 ET closed 10:03 ET (05-11)', ...SUMMARY, '', ...DETAIL, '--- end of bar_briefing ---'].join('\n');
const PROMPT = `Cycle at 10:03.\n- Alignment: a line outside the briefing\n${BRIEF}\n--- risk-manager report ---\nok\n`;

const WITHIN = { from: '--- bar_briefing', to: '--- end of bar_briefing' };

test('applyPatch: inserts a line before the one anchor, byte-exact, everything else untouched', () => {
  const r = B.applyPatch(PROMPT, { name: 'x', within: WITHIN, line: '^- Alignment:', op: 'before', text: '- State: new.' });
  assert.strictEqual(r.applied, true);
  const i = PROMPT.indexOf('- Alignment: long mixed');
  assert.strictEqual(r.prompt, `${PROMPT.slice(0, i)}- State: new.\n${PROMPT.slice(i)}`);
});

test('applyPatch: after, replace and remove act on the whole anchored line', () => {
  const line = '- Trend rule: SHORT allowed (prevailing 1h down); long only as a reversal (mtf: reversal).';
  const i = PROMPT.indexOf(line);
  const end = i + line.length;
  assert.strictEqual(B.applyPatch(PROMPT, { within: WITHIN, line: '^- Trend rule:', op: 'after', text: 'A' }).prompt, `${PROMPT.slice(0, end)}\nA${PROMPT.slice(end)}`);
  assert.strictEqual(B.applyPatch(PROMPT, { within: WITHIN, line: '^- Trend rule:', op: 'replace', text: 'R' }).prompt, `${PROMPT.slice(0, i)}R${PROMPT.slice(end)}`);
  assert.strictEqual(B.applyPatch(PROMPT, { within: WITHIN, line: '^- Trend rule:', op: 'remove' }).prompt, `${PROMPT.slice(0, i)}${PROMPT.slice(end + 1)}`);
});

test('applyPatch: a text anchor replaces or inserts at the exact substring', () => {
  const r = B.applyPatch(PROMPT, { within: WITHIN, match: 'momentum down;', op: 'replace', text: 'momentum flat;' });
  assert.strictEqual(r.prompt, PROMPT.replace('momentum down;', 'momentum flat;'));
  const b = B.applyPatch(PROMPT, { within: WITHIN, match: 'momentum down;', op: 'before', text: '[X]' });
  assert.strictEqual(b.prompt, PROMPT.replace('momentum down;', '[X]momentum down;'));
  const a = B.applyPatch(PROMPT, { within: WITHIN, match: 'momentum down;', op: 'after', text: '[Y]' });
  assert.strictEqual(a.prompt, PROMPT.replace('momentum down;', 'momentum down;[Y]'));
  assert.strictEqual(B.applyPatch(PROMPT, { within: WITHIN, match: ' momentum down;', op: 'remove' }).prompt, PROMPT.replace(' momentum down;', ''));
});

test('applyPatch: a missing anchor or scope fails loudly', () => {
  assert.throws(() => B.applyPatch(PROMPT, { within: WITHIN, line: '^- Nothing here:', op: 'before', text: 'x' }), /anchor .* not found/);
  assert.throws(() => B.applyPatch(PROMPT, { within: { from: '--- nope', to: '--- end' }, line: '^- Alignment:', op: 'before', text: 'x' }), /scope .*--- nope.* not found/);
  assert.throws(() => B.applyPatch(PROMPT, { within: { from: '--- bar_briefing', to: '--- never' }, line: '^- Alignment:', op: 'before', text: 'x' }), /scope .* not found/);
});

test('applyPatch: an ambiguous anchor or scope fails loudly; the scope keeps the line outside the briefing out', () => {
  // Without the scope the anchor matches twice (one line outside the briefing).
  assert.throws(() => B.applyPatch(PROMPT, { line: '^- Alignment:', op: 'before', text: 'x' }), /anchor .* matched 2 times/);
  assert.throws(() => B.applyPatch(PROMPT, { within: WITHIN, match: 'closed back inside', op: 'remove' }), /matched 2 times/);
  assert.throws(() => B.applyPatch(`${PROMPT}${BRIEF}\n`, { within: WITHIN, line: '^- Alignment:', op: 'before', text: 'x' }), /scope .* matched 2 times/);
});

test('applyPatch: `unless` makes it idempotent: a second application changes nothing and says why', () => {
  const p = { name: 's', within: WITHIN, line: '^- Alignment:', op: 'before', text: '- State (x): y.', unless: '^- State \\(' };
  const once = B.applyPatch(PROMPT, p);
  const twice = B.applyPatch(once.prompt, p);
  assert.strictEqual(twice.applied, false);
  assert.strictEqual(twice.prompt, once.prompt);
  assert.match(twice.reason, /already/);
  // `unless` reads only inside the scope: the same text outside it does not stop the patch.
  assert.strictEqual(B.applyPatch(`- State (x): y.\n${PROMPT}`, p).applied, true);
});

test('validatePatch: refuses a malformed patch', () => {
  for (const bad of [null, {}, { line: '^x', op: 'move', text: 'a' }, { line: '^x', match: 'y', op: 'before', text: 'a' }, { line: '^x', op: 'before' }, { line: '(', op: 'remove' },
    { line: '^x', op: 'remove', within: { from: 'a' } }, { match: '', op: 'remove' }]) assert.throws(() => B.validatePatch(bad), /patch/, JSON.stringify(bad));
  assert.doesNotThrow(() => B.validatePatch({ line: '^x', op: 'remove' }));
});

test('applyPatches: a list applies in order; each result is named', () => {
  const r = B.applyPatches(PROMPT, [{ name: 'a', within: WITHIN, line: '^- Alignment:', op: 'before', text: 'A' }, { name: 'b', within: WITHIN, line: '^A$', op: 'after', text: 'B' }]);
  assert.match(r.prompt, /\nA\nB\n- Alignment: long mixed/);
  assert.deepStrictEqual(r.changed, ['a', 'b']);
});

test('briefingInputs: the runner briefing read back into frameStates inputs (ISO times, sweep null vs absent)', () => {
  const x = B.briefingInputs(PROMPT);
  assert.strictEqual(x.closedAt, '2021-05-11T14:03:00.000Z');
  assert.deepStrictEqual(x.m15.frame, { trend: 'range', bias: 0 });
  assert.strictEqual(x.m15.lastBreak.last.knownAt, '2021-05-11T13:45:00.000Z');
  assert.strictEqual(x.m15.lastBreak.last.at, '2021-05-11T13:30:00.000Z');
  assert.strictEqual(x.h1.h1.trend, 'down');
  assert.strictEqual(x.h1.h4.trend, 'range');
  assert.strictEqual(x.h1.lastBreak.last.knownAt, '2021-05-11T01:00:00.000Z', 'an MM-DD time is the previous day');
  assert.deepStrictEqual(x.candles['1h'], { pattern: 'bullish engulfing', rangeAtr: 3.55, closedAt: '2021-05-11T14:00:00.000Z', sweep: { of: 'previous 1h high and low', closedBack: false, closedBeyond: 'high' } });
  assert.deepStrictEqual(x.candles['5m'], { pattern: 'displacement', dir: 'up', rangeAtr: 2, closedAt: '2021-05-11T14:00:00.000Z', sweep: { of: 'previous 5m high', closedBack: false, closedBeyond: 'high' } });
  assert.deepStrictEqual(x.candles['15m'].sweep, { of: 'previous 15m high', closedBack: false, closedBeyond: 'high' }, 'a role prefix is read past');
  assert.deepStrictEqual(x.candles['4h'], { closedAt: '2021-05-11T14:00:00.000Z', sweep: { of: 'previous 4h low', closedBack: true, closedBeyond: null } }, 'a sweep-only line: no shape, no range');
  assert.strictEqual(x.et('2021-05-11T13:45:00.000Z'), '09:45');
  assert.strictEqual(x.et('2021-05-11T01:00:00.000Z'), '05-10 21:00');
  assert.strictEqual(x.windowEntries, 'allowed');
});

test('frameLabels: each frame\'s trend label as the briefing shows it, a missing one left out', () => {
  assert.deepStrictEqual(B.frameLabels(PROMPT), { '4h': 'range', '1h': 'down', '15m': 'range' });
  assert.deepStrictEqual(B.frameLabels(PROMPT.replace('  h4: {"trend":"range","bias":0}\n', '')), { '1h': 'down', '15m': 'range' });
  assert.deepStrictEqual(B.frameLabels('nothing'), {});
});

test('briefingInputs: a candle line with no sweep text has sweep null; a missing line has no candle', () => {
  const p = PROMPT.replace('; traded beyond the previous 15m high, closed above its high', '').replace(/- 4h \(closed 10:00\); .*\n/, '');
  const x = B.briefingInputs(p);
  assert.ok('sweep' in x.candles['15m']);
  assert.strictEqual(x.candles['15m'].sweep, null);
  assert.ok(!('4h' in x.candles));
});

test('briefingInputs: null without a runner briefing, its m3 version or its ET clock (never a guess)', () => {
  assert.strictEqual(B.briefingInputs('no briefing here'), null);
  assert.strictEqual(B.briefingInputs(PROMPT.replace(/\[m3\] version m3@\S+/, '[m3] version x')), null);
  assert.strictEqual(B.briefingInputs(PROMPT.replace('  et: 10:03\n', '')), null);
  assert.strictEqual(B.briefingInputs(PROMPT.replace('  frame: {"trend":"range","bias":0}\n', '  frame: {broken\n')).m15.frame, undefined, 'an unparseable JSON value is left out');
});

test('briefingInputs: a briefing across midnight ET reads its clock right (MM-DD of the same year, DST offset from the prompt)', () => {
  const p = PROMPT.replace('m3@2021-05-11T14:03:00.000Z', 'm3@2021-01-04T05:03:00.000Z').replace('  et: 10:03', '  et: 00:03').replace('"knownAt":"05-10 21:00"', '"knownAt":"01-03 23:00"');
  const x = B.briefingInputs(p);
  assert.strictEqual(x.h1.lastBreak.last.knownAt, '2021-01-04T04:00:00.000Z');
  assert.strictEqual(x.et('2021-01-04T04:00:00.000Z'), '01-03 23:00');
  const y = B.briefingInputs(p.replace('"knownAt":"01-03 23:00"', '"knownAt":"12-31 23:00"'));
  assert.strictEqual(y.h1.lastBreak.last.knownAt, '2021-01-01T04:00:00.000Z', 'December before a January bar is last year');
  // An evening ET bar is the next UTC day: its ET clock is later than its UTC clock.
  const e = B.briefingInputs(PROMPT.replace('m3@2021-05-11T14:03:00.000Z', 'm3@2021-05-11T02:03:00.000Z').replace('  et: 10:03', '  et: 22:03'));
  assert.strictEqual(e.m15.lastBreak.last.knownAt, '2021-05-10T13:45:00.000Z', 'the bar\'s ET day is 05-10');
  assert.strictEqual(e.h1.lastBreak.last.knownAt, '2021-05-11T01:00:00.000Z', '05-10 21:00 ET, the same ET day');
  assert.strictEqual(e.et('2021-05-11T01:00:00.000Z'), '21:00');
});

test('briefingInputs: a displacement down is a pattern and its side', () => {
  const x = B.briefingInputs(PROMPT.replace('- 5m (closed 10:00): displacement up,', '- 5m (closed 10:00): displacement down,'));
  assert.strictEqual(x.candles['5m'].pattern, 'displacement');
  assert.strictEqual(x.candles['5m'].dir, 'down');
});

// Stand-ins for scripts/lib/trading/frame-state.js (feat/state-line): the interface only.
const stub = {
  frameStates: ({ m15, h1, candles, closedAt }) => ({ seen: { m15, h1, candles, closedAt }, '1h': { label: h1.h1.trend, state: 'disagree' } }),
  stateLine: (states, et) => `- State (stub): 1h ${states['1h'].label}: DISAGREE - last break known ${et(states.seen.m15.lastBreak.last.knownAt)}.`,
};

test('stateLineFor: the recorded cycle\'s line from the injected module, times rendered as the briefing renders them', () => {
  assert.strictEqual(B.stateLineFor({ prompt: PROMPT }, stub), '- State (stub): 1h down: DISAGREE - last break known 09:45.');
  assert.strictEqual(B.stateLineFor({ prompt: 'nothing' }, stub), null);
  assert.strictEqual(B.stateLineFor({ prompt: PROMPT }, { ...stub, stateLine: () => null }), null);
});

test('statePatch: inserts the line right before Alignment inside the runner briefing, once', () => {
  const p = B.statePatch({ prompt: PROMPT }, stub);
  const r = B.applyPatch(PROMPT, p);
  const i = PROMPT.indexOf('- Alignment: long mixed');
  assert.strictEqual(r.prompt, `${PROMPT.slice(0, i)}- State (stub): 1h down: DISAGREE - last break known 09:45.\n${PROMPT.slice(i)}`);
  assert.strictEqual(B.applyPatch(r.prompt, p).applied, false, 'a prompt that already shows a State line is not patched twice');
  assert.strictEqual(B.statePatch({ prompt: 'nothing' }, stub), null);
});

test('loadFrameState: a checkout without the module says what it needs', () => {
  const req = () => { const e = new Error('Cannot find module'); e.code = 'MODULE_NOT_FOUND'; throw e; };
  assert.throws(() => B.loadFrameState(req), /State line .*frame-state\.js/);
  const mod = { frameStates: () => ({}), stateLine: () => '' };
  assert.strictEqual(B.loadFrameState(() => mod).frameStates, mod.frameStates);
});

'use strict';

// Fact-checked reasons in risk-manager phase 2 (scripts/lib/trading/fact-claims.js; the learned-rulebook design's
// R29, #4): each FACTS claim checked in code against the bar briefing; the gate's refusal; the cycle log's record.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const B = require('../../scripts/lib/trading/briefing');
const F = require('../../scripts/lib/trading/fact-claims');

const AS_OF = '2026-06-10T13:54:00.000Z';
const RULE_DOWN = 'Trend rule: prevailing trend 1h down; trend strategies may not go long; reversal strategies (mtf: reversal) may go long too.';
const KELTNER = { name: 'keltner', direction: 'short', stopPoints: 8, needR: 1.5, inTheWay: { name: 'VWAP (rth)', R: 0.4 }, trendRule: 'allows', alignment: 'mixed' };
const BOS = { name: 'bos', direction: 'short', stopPoints: 10, needR: 2, inTheWay: { name: 'IB low', R: 2.5 } };
const ORB = { name: 'orb', direction: 'long', stopPoints: 6, needR: 2, inTheWay: null };

/** A briefing of the opening drive (entries allowed, no blackout), the 1h down trend rule, and the given candidates. */
function briefing({ candidates = [KELTNER, ORB], m3 = {}, m15 = {}, h1 = {} } = {}) {
  return {
    symbol: 'MNQ', minutes: 3, asOf: AS_OF, closedAt: '2026-06-10T13:57:00.000Z',
    sections: {
      m3: { version: 'a', validUntil: '2026-06-10T14:00:00.000Z', data: { et: '09:57', window: 'opening drive', windowEntries: 'allowed', windowText: 'opening drive (market open, entries allowed) until 11:00 ET', news: { inBlackout: false }, trendRule: RULE_DOWN, vwap: { applies: 'rth', side: 'below' }, location: { priorValue: 'inside' }, candidates, ...m3 } },
      m15: { version: 'b', validUntil: '2026-06-10T14:00:00.000Z', data: { frame: { trend: 'down' }, alignment: { long: 'counter', short: 'mixed' }, ...m15 } },
      h1: { version: 'c', validUntil: '2026-06-10T14:00:00.000Z', data: { h1: { trend: 'down' }, h4: { trend: 'range' }, ...h1 } },
    },
  };
}
const one = (item, b = briefing()) => F.checkClaim(F.parseClaim(item), b);
const checks = (items, b) => items.map(i => one(i, b).check);

test('facts: the FACTS line read from a report (markdown, every line, "none"); free text left alone', () => {
  assert.strictEqual(F.factsLines('VERDICT: APPROVE - size 1, risk $10, aligned'), null);
  assert.deepStrictEqual(F.factsLines('VERDICT: APPROVE - x\n**FACTS:** Window Opening Drive;  vwap above.'), ['window opening drive', 'vwap above']);
  assert.deepStrictEqual(F.factsLines('FACTS: none'), []);
  // The block runs to the next VERDICT line or the end: every line in it is items.
  assert.deepStrictEqual(F.factsLines('FACTS: vwap above\nnotes\nFACTS: read long aligned'), ['vwap above', 'notes', 'read long aligned']);
  // The block runs from the FACTS line to the end: a VERDICT line after it is an item (that won't parse).
  assert.deepStrictEqual(F.factsLines('FACTS: vwap above\nVERDICT: VETO - x\nnotes'), ['vwap above', 'verdict: veto - x', 'notes']);
  assert.strictEqual(F.withoutFacts('VERDICT: VETO - x\nFACTS: vwap above'), 'VERDICT: VETO - x');
});

test('facts: each form parses; anything else is unknown', () => {
  assert.deepStrictEqual(F.parseClaim('trend long allowed'), { type: 'trend', text: 'trend long allowed', side: 'long', value: 'allowed' });
  assert.deepStrictEqual(F.parseClaim('room orb long enough'), { type: 'room', text: 'room orb long enough', side: 'long', value: 'enough', strategy: 'orb' });
  assert.deepStrictEqual(F.parseClaim('15m up'), { type: 'tf', text: '15m up', frame: '15m', value: 'up' });
  assert.deepStrictEqual(F.parseClaim('window: lunch lull'), { type: 'window', text: 'window: lunch lull', value: 'lunch lull' });
  for (const bad of ['trend up', 'trend long ok', 'read aligned', 'vwap over', '30m up', 'window noon', 'room long', 'above vwap', 'entries', 'moon full']) {
    assert.strictEqual(F.parseClaim(bad).type, 'unknown', bad);
  }
});

test('facts: window - the window name, rth, overnight', () => {
  assert.deepStrictEqual(checks(['window opening drive', 'window opening print', 'window rth', 'window overnight']), [true, false, true, false]);
  const asia = briefing({ m3: { window: 'asia' } });
  assert.deepStrictEqual(checks(['window rth', 'window overnight', 'window asia'], asia), [false, true, true]);
  assert.strictEqual(one('window opening print').fact, 'the window is opening drive');
  assert.strictEqual(one('window rth', briefing({ m3: { window: null } })).check, 'unchecked');
});

test('facts: entries - the window\'s entry clock', () => {
  assert.deepStrictEqual(checks(['entries allowed', 'entries none']), [true, false]);
  const print = briefing({ m3: { window: 'opening print', windowEntries: 'none' } });
  assert.deepStrictEqual(checks(['entries allowed', 'entries none'], print), [false, true]);
  assert.strictEqual(one('entries allowed', briefing({ m3: { windowEntries: undefined } })).check, 'unchecked');
});

test('facts: news - the blackout state; unknown is unchecked', () => {
  assert.deepStrictEqual(checks(['news clear', 'news blackout']), [true, false]);
  assert.deepStrictEqual(checks(['news clear', 'news blackout'], briefing({ m3: { news: { inBlackout: true, reason: 'CPI' } } })), [false, true]);
  assert.strictEqual(one('news clear', briefing({ m3: { news: { inBlackout: null, error: 'blackouts unreadable' } } })).check, 'unchecked');
});

test('facts: trend - the trend rule per side', () => {
  assert.deepStrictEqual(checks(['trend long allowed', 'trend long blocked', 'trend short allowed', 'trend short blocked']), [false, true, true, false]);
  assert.match(one('trend long allowed').fact, /may not go long/);
  assert.strictEqual(one('trend long allowed', briefing({ m3: { trendRule: 'Trend rule: something new' } })).check, 'unchecked');
});

test('facts: read - the multi-timeframe read for the side', () => {
  assert.deepStrictEqual(checks(['read short mixed', 'read short aligned', 'read long counter', 'read long aligned']), [true, false, true, false]);
  assert.strictEqual(one('read long aligned', briefing({ m15: { alignment: { long: 'unknown' } } })).check, 'unchecked');
});

test('facts: 15m, 1h, 4h - each frame\'s trend', () => {
  assert.deepStrictEqual(checks(['15m down', '15m up', '1h down', '1h up', '4h range', '4h up']), [true, false, true, false, true, false]);
  assert.strictEqual(one('1h up', briefing({ h1: { h1: { trend: 'unknown' } } })).check, 'unchecked');
});

test('facts: vwap and value - price against the VWAP and the prior value area', () => {
  assert.deepStrictEqual(checks(['vwap below', 'vwap above', 'vwap at', 'value inside', 'value above']), [true, false, false, true, false]);
  assert.strictEqual(one('vwap above', briefing({ m3: { vwap: { side: null } } })).check, 'unchecked');
  assert.strictEqual(one('value inside', briefing({ m3: { location: { priorValue: null } } })).check, 'unchecked');
});

test('facts: room - the first level in the way against the R needed; never guessed', () => {
  // keltner short: VWAP at 0.4R before the 1.5R it needs; orb long: nothing in its way.
  assert.deepStrictEqual(checks(['room short short', 'room short enough', 'room long enough', 'room long short']), [true, false, true, false]);
  assert.strictEqual(one('room short enough').fact, 'keltner: VWAP (rth) at 0.4R, it aims for 1.5R');
  // Two short setups, no strategy named and no order: it can't be matched (false, unmatched: it refuses).
  const two = briefing({ candidates: [KELTNER, BOS] });
  assert.deepStrictEqual([one('room short enough', two).check, one('room short enough', two).unmatched], [false, true]);
  assert.match(one('room short enough', two).fact, /2 short setups \(keltner, bos\): name the strategy/);
  // With the order's own setup, every room claim is about it: named or not; another strategy or side can't be matched.
  const claim = (item, order) => F.checkClaim(F.parseClaim(item), two, order);
  const BOS_SHORT = { strategy: 'bos', side: 'short' };
  assert.deepStrictEqual(['room short enough', 'room short short', 'room bos short enough'].map(i => claim(i, BOS_SHORT).check), [true, false, true]);
  assert.strictEqual(claim('room short enough', { strategy: 'keltner', side: 'short' }).check, false);
  for (const [item, order] of [['room keltner short enough', BOS_SHORT], ['room long enough', BOS_SHORT], ['room short enough', { strategy: null, side: 'short' }]]) {
    assert.deepStrictEqual([claim(item, order).check, claim(item, order).unmatched], [false, true], item);
  }
  assert.deepStrictEqual(checks(['room bos short enough', 'room keltner short enough'], two), [true, false]);
  // No setup on that side, an unknown stop, no scan: unchecked.
  assert.strictEqual(one('room long enough', two).check, 'unchecked');
  assert.strictEqual(one('room long enough', briefing({ candidates: [{ ...ORB, stopPoints: null }] })).check, 'unchecked');
  assert.strictEqual(one('room long enough', briefing({ candidates: null })).check, 'unchecked');
});

test('facts: checkFacts - a contradiction caught, a correct claim passed, an unknown recorded unchecked', () => {
  const b = briefing();
  const wrong = F.checkFacts('VERDICT: APPROVE - size 1\nFACTS: entries allowed; trend long allowed', b);
  assert.strictEqual(wrong.status, 'false');
  assert.deepStrictEqual(wrong.claims.map(c => [c.type, c.check]), [['entries', true], ['trend', false]]);
  assert.strictEqual(F.checkFacts('FACTS: entries allowed; trend short allowed; read short mixed', b).status, 'confirmed');
  const odd = F.checkFacts('FACTS: entries allowed; momentum strong', b);
  assert.strictEqual(odd.status, 'unchecked');
  assert.deepStrictEqual(odd.claims[1], { type: 'unknown', text: 'momentum strong', check: 'unchecked', fact: 'not a form this check knows (agents/risk-manager.md lists them)' });
  assert.deepStrictEqual(F.checkFacts('VERDICT: APPROVE - size 1', b), { stated: false, status: 'none', claims: [], unavailable: null, verdictProblem: null, labels: 0, symbols: [] });
  // No briefing: every claim unchecked, with why.
  const none = F.checkFacts('FACTS: entries allowed', null, 'no bar briefing for MNQ');
  assert.deepStrictEqual([none.status, none.unavailable, none.claims[0].check], ['unchecked', 'no bar briefing for MNQ', 'unchecked']);
  assert.match(F.renderFacts(wrong), /- FALSE trend: "trend long allowed" - Trend rule: [^\n]*\n1 FACT FALSE: name it, drop it and decide again/);
  assert.match(F.renderFacts(none), /can't be checked: the order gate refuses/);
});

test('facts: room at exactly the R it needs is enough (the briefing\'s >=)', () => {
  const edge = briefing({ candidates: [{ ...ORB, inTheWay: { name: 'IB high', R: 2 } }] });
  assert.deepStrictEqual(checks(['room long enough', 'room long short'], edge), [true, false]);
  const under = briefing({ candidates: [{ ...ORB, inTheWay: { name: 'IB high', R: 1.99 } }] });
  assert.deepStrictEqual(checks(['room long enough', 'room long short'], under), [false, true]);
});

test('facts: the gate\'s refusal - false facts, fewer than 2 checked with a current briefing, stale or missing briefings, other symbols, failures', () => {
  const home = tmpDir();
  B.writeBriefing(home, briefing());
  const NOW = new Date('2026-06-10T13:58:00.000Z'); // the briefing is current (its m3 holds until 14:00)
  const run = (text, extra = {}) => F.gateRefusal({ report: { text }, home, root: 'MNQ', now: NOW, ...extra });
  assert.match(run('VERDICT: APPROVE - size 1\nFACTS: trend long allowed; entries allowed'), /^Risk-manager phase 2 approved on a fact the bar briefing contradicts: "trend long allowed" \(the briefing: Trend rule: prevailing trend 1h down; trend strategies may not go long;.*\)\. The approval doesn't stand/);
  assert.strictEqual(run('VERDICT: APPROVE - size 1\nFACTS: trend short allowed; entries allowed'), null, 'two checked claims pass');
  // Any item in no known form refuses the report: it can't be checked.
  for (const item of ['moon full', 'vwap above!', '<b>vwap above</b>', 'trend long allowed&#41', 'read long sideways', 'vwap above\\', 'entries allowed?']) {
    assert.match(run(`VERDICT: APPROVE - size 1\nFACTS: trend short allowed; entries allowed; ${item}`), /approved on facts in no known form: "[^"]*"\. Write each fact exactly in one of the forms window <name>/, item);
  }
  // A current briefing: at least 2 checkable claims; none, one, or unknown forms only are refused, naming the forms.
  for (const text of ['VERDICT: APPROVE - size 1', 'VERDICT: APPROVE\nFACTS: none', 'VERDICT: APPROVE\nFACTS: entries allowed']) {
    assert.match(run(text), /approved with [01] checkable facts? \(at least 2 needed, in a FACTS line under the verdict, in the forms window <name>, [^)]*e\.g\. "FACTS: window opening drive; trend long allowed"\)/, text);
  }
  // A claim the briefing can't confirm (the order's setup isn't on the bar) refuses; written `unknown`, it is true and
  // doesn't count.
  const BOS_LONG = { order: { strategy: 'bos', side: 'long' } };
  assert.match(run('FACTS: entries allowed; window rth; room long enough', BOS_LONG), /can't confirm: "room long enough" \(no bos setup on the long side\)\. Write `<thing> unknown`/);
  assert.match(run('FACTS: entries allowed; room long unknown', BOS_LONG), /approved with 1 checkable fact /);
  assert.strictEqual(run('FACTS: entries allowed; window rth; room long unknown', BOS_LONG), null);
  assert.strictEqual(F.gateRefusal({ report: null, home, root: 'MNQ', now: NOW }), null, 'no approving report: roles-ran decides');
  // The gate given no order: no setup to match a room fact to, so it can't be matched.
  assert.match(run('FACTS: entries allowed; window rth; room long enough'), /can't be matched to this order: "room long enough" \(the order names no setup/);
  // The cycle's bar: this briefing; another bar's is no briefing for it.
  assert.strictEqual(run('FACTS: entries allowed; window rth', { cycleBars: { MNQ: AS_OF }, now: new Date('2026-06-10T15:00:00Z') }), null, 'the cycle bar decides, however long the cycle runs');
  assert.match(run('FACTS: entries allowed; window rth', { cycleBars: { MNQ: '2026-06-10T13:57:00.000Z' } }), /can't be read \(the MNQ briefing is for the bar at/);
  // No cycle bar: the briefing on file counts only while current (as bar_briefing and reason_check judge it).
  const stale = new Date('2026-10-01T14:00:00Z');
  assert.match(run('FACTS: vwap below; entries allowed', { now: stale }), /can't be checked \(the MNQ briefing \(bar at 2026-06-10T13:54:00.000Z\) is no longer current\)/);
  assert.match(run('FACTS: vwap above; entries allowed', { now: stale }), /can't be checked/, 'a stale briefing never confirms nor refutes');
  // No current briefing: no FACTS line or FACTS: none passes; stated facts are refused (fails closed).
  assert.strictEqual(run('VERDICT: APPROVE', { now: stale }), null);
  assert.strictEqual(run('VERDICT: APPROVE\nFACTS: none', { now: stale }), null);
  assert.match(F.gateRefusal({ report: { text: 'FACTS: entries allowed' }, home, root: 'MES', now: NOW }), /can't be checked \(no bar briefing for MES\)/);
  assert.strictEqual(F.gateRefusal({ report: { text: 'FACTS: none' }, home, root: 'MES', now: NOW }), null);
  // One symbol per report: a report naming another cycle symbol and not the order's is refused.
  const two = { cycleBars: { MNQ: AS_OF, MES: AS_OF } };
  assert.match(run('VERDICT: APPROVE - MES long\nFACTS: entries allowed; window rth', two), /names MES, not MNQ: its facts can't be checked for this order \(one symbol per report\)/);
  assert.strictEqual(run('VERDICT: APPROVE - MNQ long, MES flat\nFACTS: entries allowed; window rth', two), null);
  assert.strictEqual(run('VERDICT: APPROVE - long\nFACTS: entries allowed; window rth', two), null, 'no symbol named: the order\'s');
  // The transcript unreadable, the report reader throwing, a corrupt briefing: refused (fails closed), never passed.
  assert.match(F.gateRefusal({ report: { error: 'EACCES' }, home, root: 'MNQ', now: NOW }), /can't be read \(EACCES\)/);
  assert.match(F.gateRefusal({ report: () => { throw new Error('boom'); }, home, root: 'MNQ', now: NOW }), /failed \(boom\): no entry this cycle \(fails closed\)/);
  const bad = tmpDir();
  fs.mkdirSync(path.join(bad, 'briefing'), { recursive: true });
  fs.writeFileSync(B.briefingFile(bad, 'MNQ'), '{not json');
  assert.match(F.gateRefusal({ report: { text: 'FACTS: entries allowed' }, home: bad, root: 'MNQ', now: NOW }), /can't be checked \(no bar briefing for MNQ\)/);
});

test('facts: the formatting a careful model uses is read; each item still has to fit a closed form, and a false one is caught', () => {
  const b = briefing();
  const read = text => F.checkFacts(text, b).claims.map(c => [c.type, c.check]);
  // Separators, bullet lines, a list number, FACT, a symbol after the label.
  assert.deepStrictEqual(read('FACTS: window opening drive, entries allowed | news clear'), [['window', true], ['entries', true], ['news', true]]);
  assert.deepStrictEqual(read('VERDICT: APPROVE\nFACTS:\n- window opening drive\n* entries allowed\n2) read short mixed\nthe rest of the report'), [['window', true], ['entries', true], ['read', true], ['unknown', 'unchecked']]);
  assert.deepStrictEqual(read('1. FACTS: window opening drive; entries allowed'), [['window', true], ['entries', true]]);
  // FACT (singular) is no FACTS line: free text, never read.
  assert.deepStrictEqual(read('FACT: window opening drive; entries allowed'), []);
  assert.deepStrictEqual(read('FACTS (MNQ): window opening drive; entries allowed'), [['window', true], ['entries', true]]);
  // Hyphenated or quoted names, the briefing's own parenthetical, inner colons, 15-min and 15 min.
  assert.deepStrictEqual(read('FACTS: window opening-drive; window "opening drive"; window \u201copening drive\u201d; window opening\u2013drive'), [['window', true], ['window', true], ['window', true], ['window', true]]);
  assert.deepStrictEqual(read('FACTS: trend short: allowed; 15-min down; 15 min down; 1-hour down'), [['trend', true], ['tf', true], ['tf', true], ['tf', true]]);
  // The same forms, false: still caught.
  assert.deepStrictEqual(read('1. FACTS (MNQ): window opening-print, trend long: allowed | 15-min up'), [['window', false], ['trend', false], ['tf', false]]);
  assert.deepStrictEqual(read('FACTS:\n- window "lunch lull"\n- vwap: above'), [['window', false], ['vwap', false]]);
  // Words outside the forms stay unknown: normalizing never turns them into a claim.
  assert.deepStrictEqual(read('FACTS: trend long ok; window noon-ish; 30-min up; vwap above-ish'), [['unknown', 'unchecked'], ['unknown', 'unchecked'], ['unknown', 'unchecked'], ['unknown', 'unchecked']]);
  assert.strictEqual(F.withoutFacts('VERDICT: APPROVE - x\nFACTS:\n- vwap above\n- news clear\nnotes'), 'VERDICT: APPROVE - x');
});

test('facts: a negation, or a claim inside parentheses, is ambiguous: refused, never read as the claim without it', () => {
  const home = tmpDir();
  B.writeBriefing(home, briefing());
  const NOW = new Date('2026-06-10T13:58:00.000Z');
  const run = text => F.gateRefusal({ report: { text: `VERDICT: APPROVE - size 1\nFACTS: window opening drive; trend short allowed; ${text}` }, home, root: 'MNQ', now: NOW });
  // The reviewer's strings, and variations: each refused, naming the item.
  for (const item of [
    'entries allowed (trend short allowed)', 'trend short (not) blocked', 'entries (not) allowed', 'entries not allowed',
    'entries allowed (not)', 'trend long (no) blocked', 'trend long never blocked', "trend long isn't blocked", 'trend long isn\u2019t blocked',
    'vwap below (above earlier)', 'read short mixed (15-min aligned)', 'window opening drive (market open, entries allowed)',
    'news clear (no blackout)', 'value inside (prior day, inside)', 'entries allowed (window lunch lull)',
  ]) {
    assert.strictEqual(F.parseClaim(item).type, 'ambiguous', item);
    assert.match(run(item), /approved on facts that can't be read plainly: "[^]*" \(a negation, a parenthesis or bracket, or a character outside plain ASCII\)\. State each fact plainly/, item);
  }
  // In the record, an ambiguous item is a false claim.
  assert.deepStrictEqual(F.checkFacts('FACTS: entries (not) allowed', briefing()).claims.map(c => [c.type, c.check]), [['ambiguous', false]]);
  assert.deepStrictEqual(F.checkFacts('FACTS: entries (not) allowed', null, 'no briefing').claims.map(c => [c.type, c.check]), [['ambiguous', false]], 'with no briefing too');
  // Any parenthesis or bracket, whatever is inside, and any character outside plain ASCII: ambiguous, never stripped.
  for (const item of [
    'entries allowed (none)', 'window rth (overnight)', 'read short mixed (long counter)', 'entries allowed (market open)',
    'window opening drive (market open)', 'entries allowed [none]', 'entries allowed {none}', 'entries allowed )', 'entries allowed (',
    'entries\u200b allowed', 'entries allowed\u200b', '\u200bentries allowed', 'entri\u0435s allowed', 'vwap bel\u043ew',
    'entries allowed\ufeff',
  ]) {
    assert.strictEqual(F.parseClaim(item).type, 'ambiguous', JSON.stringify(item));
    assert.match(run(item), /approved on facts that can't be read plainly/, JSON.stringify(item));
  }
  // Contracted negations, with and without the apostrophe (a smart one too).
  for (const item of ['trend long doesnt blocked', 'trend long isnt blocked', 'trend long arent blocked', 'trend long wont blocked', 'trend long doesn\u2019t blocked', 'entries cant allowed']) {
    assert.strictEqual(F.parseClaim(item).type, 'ambiguous', item);
  }
  // Ordinary dashes and quotes map to ASCII first (the explicit list): those items read.
  assert.strictEqual(run('read short \u201cmixed\u201d'), null);
  assert.strictEqual(run('read short \u2018mixed\u2019'), null);
});

test('facts: line endings, control characters, underscores, the minus sign', () => {
  const home = tmpDir();
  B.writeBriefing(home, briefing());
  const NOW = new Date('2026-06-10T13:58:00.000Z');
  const run = text => F.gateRefusal({ report: { text }, home, root: 'MNQ', now: NOW });
  // A FACTS line behind CRLF, CR, U+2028, U+2029 or U+0085 is still found, and its false claim caught.
  for (const eol of ['\r\n', '\r', '\u2028', '\u2029', '\u0085']) {
    assert.match(run(`VERDICT: APPROVE - size 1${eol}FACTS: window opening drive; trend long allowed${eol}`), /contradicts: "trend long allowed"/, JSON.stringify(eol));
    assert.strictEqual(run(`VERDICT: APPROVE - size 1${eol}FACTS: window opening drive; trend short allowed${eol}`), null, JSON.stringify(eol));
  }
  // Any other control character inside an item: ambiguous.
  for (const c of ['\t', '\u0001', '\u0007', '\u000b', '\u000c', '\u001f', '\u007f']) {
    assert.strictEqual(F.parseClaim(`entries${c}allowed`).type, 'ambiguous', JSON.stringify(c));
    assert.match(run(`FACTS: window opening drive; entries${c}allowed`), /can't be read plainly/, JSON.stringify(c));
  }
  // Underscores are kept: a strategy name is checked, and a false room claim about it caught.
  const va = tmpDir();
  B.writeBriefing(va, briefing({ candidates: [{ name: 'value_area', direction: 'long', stopPoints: 6, needR: 2, inTheWay: null }] }));
  const vrun = text => F.gateRefusal({ report: { text }, home: va, root: 'MNQ', now: NOW, order: { strategy: 'value_area', side: 'long' } });
  assert.deepStrictEqual(F.factsLines('FACTS: room value_area long short; _vwap below_'), ['room value_area long short', 'vwap below']);
  assert.match(vrun('FACTS: window opening drive; room value_area long short'), /contradicts: "room value_area long short" \(the briefing: value_area: no level ahead, it aims for 2R\)/);
  assert.strictEqual(vrun('FACTS: window opening drive; room value_area long enough'), null);
  // The minus sign maps to a hyphen, as the explicit list says.
  assert.strictEqual(F.parseClaim('window opening\u2212drive').type, 'window');
  // The example taught to the model passes a current briefing that holds it.
  const taught = tmpDir();
  B.writeBriefing(taught, briefing({ candidates: [ORB], m3: { trendRule: 'Trend rule: prevailing trend 1h up; trend strategies may not go short; reversal strategies (mtf: reversal) may go short too.', vwap: { side: 'above' } }, m15: { alignment: { long: 'aligned', short: 'counter' } } }));
  const rm = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'risk-manager.md'), 'utf8');
  const example = /^FACTS: window opening drive; .*$/m.exec(rm)[0];
  assert.strictEqual(F.gateRefusal({ report: { text: `VERDICT: APPROVE - size 1\n${example}` }, home: taught, root: 'MNQ', now: NOW, order: { strategy: 'orb', side: 'long' } }), null, example);
});

test('facts: nothing after the FACTS line escapes; symbols any case; space separators are spaces', () => {
  const home = tmpDir();
  B.writeBriefing(home, briefing());
  const NOW = new Date('2026-06-10T13:58:00.000Z');
  const run = (text, extra = {}) => F.gateRefusal({ report: { text }, home, root: 'MNQ', now: NOW, ...extra });
  const OK = 'VERDICT: APPROVE - size 1\nFACTS: window opening drive; trend short allowed';
  assert.strictEqual(run(OK), null);
  // A wrapped line, bullets after a blank line, '+' bullets, '-item', '>' quotes, fences: all in the block, all checked.
  for (const tail of [';\nentries none', '\nentries none', '\n\n- entries none', '\n+ entries none', '\n-entries none', '\n> entries none', '\n\n\n  entries none', '\n```\nentries none\n```']) {
    assert.match(run(`${OK}${tail}`), /contradicts: "entries none"/, JSON.stringify(tail));
  }
  assert.match(run(`${OK}\nsome notes`), /in no known form: "some notes"/);
  // A VERDICT line after the FACTS line: a second verdict, and an item that doesn't parse.
  assert.match(run(`${OK}\nVERDICT: APPROVE - size 1, risk $10\nnotes after it`), /in no known form: "verdict: approve - size 1/);
  // On the FACTS line's block, a format character or a lookalike letter is ambiguous: refused.
  for (const label of ['FACTS\u200b:', '\u200bFACTS:', 'FA\u00adCTS:', 'F\u0410CTS:', 'FACT\u0405:', 'Fa\u0441ts:', 'FACTS:\u200b', 'FACTS\u2060:']) {
    assert.match(run(`${OK}\n${label} trend long allowed`), /can't be read plainly|has 2 FACTS lines/, JSON.stringify(label));
  }
  // Symbols any case: "mnq" with MES named is this order's; a report about "mes" isn't.
  const two = { cycleBars: { MNQ: AS_OF, MES: AS_OF } };
  assert.strictEqual(run('VERDICT: APPROVE - mnq long, MES flat\nFACTS: window opening drive; trend short allowed', two), null);
  assert.match(run('VERDICT: APPROVE - mes long\nFACTS: window opening drive; trend short allowed', two), /names MES, not MNQ/);
  // NBSP and other space separators are spaces, before trimming: no false refusal.
  assert.strictEqual(run('VERDICT: APPROVE - size 1\nFACTS:\u00a0window\u00a0opening drive;\u2009trend short allowed\u00a0'), null);
  assert.strictEqual(run('VERDICT: APPROVE - size 1\nFACTS\u00a0: window opening\u202fdrive; trend short allowed\u3000'), null);
});

test('facts: one canonical FACTS line decides; every other line is free text, never parsed for claims', () => {
  const home = tmpDir();
  B.writeBriefing(home, briefing());
  const NOW = new Date('2026-06-10T13:58:00.000Z');
  const run = text => F.gateRefusal({ report: { text }, home, root: 'MNQ', now: NOW });
  const FACTS = 'FACTS: window opening drive; trend short allowed';
  // Free text before the FACTS line, whatever it says or looks like: no refusal (round 8's false refusals among them).
  for (const line of [
    '\u2192 key factors', 'room 2.5R \u2265 2R, main factor', 'plan of action \u2192', '0.5 \u00d7 ATR is satisfactory', 'Fact-check - all good',
    'the facts: the trend is down', 'key fact: the 1h is up', 'Fact: the 1h trend is down.', '## Verdict', '**Verdict:**', 'Facts show the trend',
    'Note. FACTS: trend long allowed', 'see FACTS = below', 'Fact; trend long allowed', 'FACTS - trend long allowed', 'FACT: trend long allowed',
    'facts: trend long allowed', 'F ACTS: trend long allowed', 'FACTS\u200b: trend long allowed', 'F\u0410CTS: trend long allowed', 'FA\u00adCTS: trend long allowed',
    'F\u0301ACTS: trend long allowed', '\uff26\uff21\uff23\uff34\uff33: trend long allowed', '\u1d405\u1d400\u1d402\u1d413\u1d412: trend long allowed',
  ]) {
    assert.strictEqual(run(`${line}\nVERDICT: APPROVE - size 1\n${FACTS}`), null, JSON.stringify(line));
  }
  // A lookalike label alone is no FACTS line: the approval states no checked fact, refused.
  assert.match(run('VERDICT: APPROVE - size 1\nF\u0410CTS: window opening drive; trend short allowed'), /approved with 0 checkable facts/);
  assert.match(run('VERDICT: APPROVE - size 1\nFACT: window opening drive; trend short allowed'), /approved with 0 checkable facts/);
  // The canonical forms: FACTS and a colon, after markup, a list mark, a quote, a heading mark or a table pipe; a symbol.
  for (const label of ['FACTS:', '**FACTS:**', '- FACTS:', '1. FACTS:', '> FACTS:', '| FACTS: |', 'FACTS (MNQ):', '## FACTS:', '`FACTS:`', '_FACTS_:']) {
    assert.strictEqual(run(`VERDICT: APPROVE - size 1\n${label} window opening drive; trend short allowed`), null, label);
  }
  // Two FACTS lines, two verdicts as the verdict parser reads them, anything after the FACTS line that doesn't parse: refused.
  for (const [text, why] of [
    [`VERDICT: APPROVE - size 1\n${FACTS}\n| FACTS: | trend long allowed |`, /has 2 FACTS lines/],
    [`VERDICT: APPROVE - size 1\nFACTS: trend long allowed\n${FACTS}`, /has 2 FACTS lines/],
    [`VERDICT: APPROVE - size 1\n${FACTS}\nVERDICT: VETO - x`, /is no single approval: a verdict line decides veto/],
    [`VERDICT: APPROVE - size 1\nVERDICT: STAND ASIDE\n${FACTS}`, /a verdict line decides stand, not APPROVE/],
    [`VERDICT: APPROVE - size 1\nVERDICT: SKIP\n${FACTS}`, /a verdict line decides skip, not APPROVE/],
    [`VERDICT: APPROVE - size 1\n### Decision: **VETO** - room\n${FACTS}`, /is no single approval: a decision line says veto|a decision line decides veto/],
    [`VERDICT: APPROVE - size 1\n${FACTS}\nverdict stands`, /a verdict line decides stands, not APPROVE/],
    [`${FACTS}\nverdict: approve`, /in no known form: "verdict: approve"/],
    [`VERDICT: APPROVE - size 1\n${FACTS}\nFACTS = trend long allowed`, /in no known form: "facts = trend long allowed"/],
    [`VERDICT: APPROVE - size 1\n${FACTS}\nFacts; trend long allowed`, /in no known form: "facts"/],
  ]) assert.match(run(text), why, JSON.stringify(text));
  // A markdown heading is not a verdict the parser reads: no second verdict.
  assert.strictEqual(run(`## Verdict\nVERDICT: APPROVE - size 1\n${FACTS}`), null);
  assert.strictEqual(run(`VERDICT: APPROVE - size 1\n**Verdict:** APPROVE\n${FACTS}`), null, 'a repeat that agrees');
  assert.strictEqual(run(`VERDICT: APPROVE - size 1\nVERDICT: APPROVE - size 2\n${FACTS}`), null, 'APPROVE lines are one approval');
});

test('facts: the taught order - numbered step lines, then the VERDICT line, then the FACTS line last - passes the gate', () => {
  const rm = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'risk-manager.md'), 'utf8');
  assert.match(rm.replace(/\s+/g, ' '), /Write your VERDICT line, then the FACTS line last; nothing may follow it\. One VERDICT line per report\./);
  const home = tmpDir();
  B.writeBriefing(home, briefing({ candidates: [ORB], m3: { trendRule: 'Trend rule: prevailing trend 1h up; trend strategies may not go short; reversal strategies (mtf: reversal) may go short too.', vwap: { side: 'above' } }, m15: { alignment: { long: 'aligned', short: 'counter' } } }));
  const gate = text => F.gateRefusal({ report: { text }, home, root: 'MNQ', now: new Date('2026-06-10T13:58:00.000Z'), order: { strategy: 'orb', side: 'long' } });
  // The agent's example, alone and after a realistic block of the trader-process step lines 2, 5, 7 and 8.
  const example = /```text\n(VERDICT: APPROVE[^`\n]*\nFACTS: [^`]*?)```/.exec(rm)[1];
  assert.deepStrictEqual(example.trim().split('\n').map(l => l.split(':')[0]), ['VERDICT', 'FACTS']);
  assert.strictEqual(gate(example), null);
  const steps = [
    '2 Context: window opening drive, entries allowed, news clear, regime trend-up, account budget $40, attempt none',
    '5 Confluence: for 3, against 0, neutral 1: read aligned, values agree',
    '7 Risk: stop 21 ticks from order_plan, size 1, exit trail, room inTheWay past needR (risk $10.50 = 21 ticks x $0.50)',
    '8 Decision: take - aligned continuation with room (priority order: full)',
  ].join('\n');
  assert.strictEqual(gate(`${steps}\n${example}`), null);
  // The same block with the facts last but a step line after them: refused (nothing may follow the FACTS line).
  assert.match(gate(`${example}\n8 Decision: take`), /in no known form: "8 decision: take"/);
});

test('facts: round 9 - an unconfirmed claim refuses, room resolves to the approved setup, unknown values, the verdict count, the label symbol, distinct facts', () => {
  const VX = { name: 'vx', direction: 'long', stopPoints: 8, needR: 2, inTheWay: { name: 'IB high', R: 0.5 } };
  const home = tmpDir();
  // Two long setups (orb with room, vx short of room); news unknown.
  B.writeBriefing(home, briefing({ candidates: [ORB, VX], m3: { news: { inBlackout: null, error: 'blackouts unreadable' } } }));
  const NOW = new Date('2026-06-10T13:58:00.000Z');
  const ORB_LONG = { strategy: 'orb', side: 'long' };
  const VX_LONG = { strategy: 'vx', side: 'long' };
  const run = (text, extra = {}) => F.gateRefusal({ report: { text }, home, root: 'MNQ', now: NOW, order: ORB_LONG, ...extra });
  // The reviewer's repro: refused (room resolves to the vx order, which is short of room; news can't be confirmed).
  assert.match(run('VERDICT: APPROVE vx long\nFACTS: window rth; entries allowed; room long enough; news clear', { order: VX_LONG }), /contradicts: "room long enough" \(the briefing: vx: IB high at 0\.5R, it aims for 2R\)/);
  // Round 10's repro: the verdict says orb, the order is vx: the room fact is about the order's vx, never the verdict's text.
  assert.match(run('VERDICT: APPROVE - size 1, orb long\nFACTS: window rth; entries allowed; room long enough', { order: VX_LONG }), /contradicts: "room long enough" \(the briefing: vx: IB high/);
  assert.match(run('VERDICT: APPROVE - size 1, orb long\nFACTS: window rth; entries allowed; room orb long enough', { order: VX_LONG }), /room facts that can't be matched to this order \(setup:vx long\): "room orb long enough" \(it is about orb long, the order is vx long\)/);
  // A verdict naming the confluent setups no longer matters (round 10's false refusal): the order's setup decides.
  assert.strictEqual(run('VERDICT: APPROVE - size 1, orb long with vx confluent\nFACTS: window rth; entries allowed; room long enough'), null);
  // No setup tag on the order: any room fact can't be matched.
  assert.match(run('VERDICT: APPROVE orb long\nFACTS: window rth; entries allowed; room long enough', { order: { strategy: null, side: 'long' } }), /can't be matched to this order: "room long enough" \(the order names no setup/);
  assert.match(run('VERDICT: APPROVE vx long\nFACTS: window rth; entries allowed; news clear'), /can't confirm: "news clear" \(the news state is unknown \(blackouts unreadable\)\)/);
  // news unknown is true here, and doesn't count toward the two.
  assert.strictEqual(run('VERDICT: APPROVE orb long\nFACTS: window rth; entries allowed; room long enough; news unknown'), null);
  assert.match(run('VERDICT: APPROVE orb long\nFACTS: window rth; news unknown'), /approved with 1 checkable fact /);
  // ... and false where the briefing holds it.
  assert.match(run('VERDICT: APPROVE orb long\nFACTS: window rth; entries unknown'), /contradicts: "entries unknown" \(the briefing: the briefing holds it/);
  for (const item of ['window unknown', 'entries unknown', 'news unknown', 'trend long unknown', 'read long unknown', '15m unknown', '1h unknown', 'vwap unknown', 'value unknown', 'room long unknown', 'room orb long unknown']) {
    assert.notStrictEqual(F.parseClaim(item).type, 'unknown', item);
  }
  assert.strictEqual(run('VERDICT: APPROVE orb long\nFACTS: window rth; room long enough'), null);
  // Verdicts counted with the parser's own matcher over the whole report: across a line break too.
  assert.strictEqual(run('VERDICT: APPROVE orb long\nVERDICT:\nAPPROVE\nFACTS: window rth; entries allowed'), null, 'a split repeat that agrees');
  assert.match(run('VERDICT:\nVETO - x\nVERDICT: APPROVE orb long\nFACTS: window rth; entries allowed'), /a verdict line decides veto/);
  assert.match(run('VERDICT: APPROVE orb long\nVERDICT:\nSTAND ASIDE\nFACTS: window rth; entries allowed'), /a verdict line decides stand/);
  // The label's (SYM) must be this order's root, any case.
  assert.match(run('VERDICT: APPROVE orb long\nFACTS (MES): window rth; entries allowed'), /The FACTS line names MES, not this order's MNQ/);
  assert.strictEqual(run('VERDICT: APPROVE orb long\nFACTS (mnq): window rth; entries allowed'), null);
  assert.strictEqual(run('VERDICT: APPROVE orb long\nFACTS (MNQ): window rth; entries allowed'), null);
  // A qualified verdict line ("Final VERDICT") is one verdict line; next to another, two; a "(phase 2)" VETO counts too.
  assert.strictEqual(run('Final VERDICT: APPROVE orb long\nFACTS: window rth; entries allowed'), null);
  assert.strictEqual(run('VERDICT: APPROVE orb long\nFinal VERDICT: APPROVE\nFACTS: window rth; entries allowed'), null);
  assert.strictEqual(run('VERDICT: APPROVE orb long\nFinal VERDICT: APPROVE vx long\nFACTS: window rth; entries allowed'), null, 'APPROVE lines are one approval: the order decides the setup');
  assert.match(run('VERDICT: APPROVE orb long\nVERDICT (phase 2): VETO\nFACTS: window rth; entries allowed'), /a verdict line decides veto/);
  // A repeated identical VERDICT line (as a recorded phase-2 report did) is one verdict; differing ones are two.
  const recorded = [
    '2 Context: window opening drive, entries allowed, news clear, regime trend-up, account budget $40, attempt none',
    '5 Confluence: for 2, against 0, neutral 1: read aligned',
    '7 Risk: stop 40 ticks from order_plan, size 1, exit trail, room inTheWay past needR (risk $20.00)',
    '8 Decision: take - aligned continuation with room',
    'VERDICT: APPROVE - size 1, risk $20.00, orb long with the 1h trend, room to 2R',
    '',
    'Summary: all checks pass; the plan stands as written.',
    '',
    'VERDICT: APPROVE - size 1, risk $20.00, orb long with the 1h trend, room to 2R',
    'FACTS: window rth; entries allowed',
  ].join('\n');
  assert.strictEqual(run(recorded), null);
  assert.strictEqual(run(recorded.replace(/orb long with the 1h trend, room to 2R\nFACTS/, 'vx long with the 1h trend, room to 2R\nFACTS')), null);
  assert.strictEqual(run(recorded.replace(/size 1, risk \$20\.00, orb long with the 1h trend, room to 2R\nFACTS/, 'size 1, risk $20.00, orb short with the 1h trend, room to 2R\nFACTS')), null);
  // The recorded heading-style repeat (anonymised): "### VERDICT: **APPROVE** but with reservations", then the full line.
  assert.strictEqual(run('### VERDICT: **APPROVE** but with reservations\n\nThe plan holds; size stays 1.\n\nVERDICT: APPROVE - size 1, risk $40, orb long, room past the first level\nFACTS: window rth; entries allowed'), null);
  // A VERDICT line starts with the word: free text that quotes one is no second verdict.
  assert.strictEqual(run('VERDICT: APPROVE orb long\nas per the VERDICT: APPROVE line above, sized 1\nFACTS: window rth; entries allowed'), null);
  // Distinct facts by kind and the setup (or side) they resolve to: named or not, the same room fact counts once.
  assert.match(run('VERDICT: APPROVE orb long\nFACTS: room long enough; room orb long enough'), /approved with 1 checkable fact /);
  assert.match(run('VERDICT: APPROVE orb long\nFACTS: window rth; window opening drive'), /approved with 1 checkable fact /);
});

test('facts: room named or not, about the only setup on that side, is one fact', () => {
  const home = tmpDir();
  B.writeBriefing(home, briefing());
  const run = (text, order = { strategy: 'orb', side: 'long' }) => F.gateRefusal({ report: { text }, home, root: 'MNQ', now: new Date('2026-06-10T13:58:00.000Z'), order });
  assert.match(run('FACTS: room orb long enough; room long enough'), /approved with 1 checkable fact /);
  assert.match(run('FACTS: room short short; room keltner short short', { strategy: 'keltner', side: 'short' }), /approved with 1 checkable fact /);
  assert.match(run('FACTS: room orb long enough; room short short'), /can't be matched to this order \(setup:orb long\): "room short short"/, 'the other side is no fact about this order');
  // Two claims from one briefing field count once: the trend-rule line answers both sides.
  assert.match(run('FACTS: trend short allowed; trend long blocked'), /approved with 1 checkable fact /);
  assert.strictEqual(run('FACTS: trend short allowed; read short mixed'), null);
  assert.strictEqual(run('FACTS: read long counter; read short mixed'), null, 'each side\'s read is its own field');
  // Two setups on a side: the order's is the one; a room fact naming the other can't be matched.
  const two = tmpDir();
  B.writeBriefing(two, briefing({ candidates: [KELTNER, { ...BOS, inTheWay: { name: 'IB low', R: 0.5 } }] }));
  const twoRun = text => F.gateRefusal({ report: { text }, home: two, root: 'MNQ', now: new Date('2026-06-10T13:58:00.000Z'), order: { strategy: 'bos', side: 'short' } });
  assert.strictEqual(twoRun('FACTS: room bos short short; entries allowed'), null);
  assert.match(twoRun('FACTS: room bos short short; room keltner short short'), /can't be matched to this order \(setup:bos short\): "room keltner short short" \(it is about keltner short, the order is bos short\)/);
});

test('facts: the gate counts distinct checked claims, and refuses more than 20 items', () => {
  const home = tmpDir();
  B.writeBriefing(home, briefing());
  const NOW = new Date('2026-06-10T13:58:00.000Z');
  const run = text => F.gateRefusal({ report: { text }, home, root: 'MNQ', now: NOW });
  assert.match(run('FACTS: window opening drive; window rth; window opening-drive'), /approved with 1 checkable fact \(at least 2 needed/, 'two window claims are one');
  assert.match(run('FACTS: read short mixed; read short mixed'), /approved with 1 checkable fact /);
  assert.strictEqual(run('FACTS: window opening drive; trend short allowed'), null);
  assert.strictEqual(run('FACTS: 15m down; 1h down'), null, 'two frames are two facts');
  // More than 20 items: refused, so no false claim hides past the 20th.
  const many = Array.from({ length: 21 }, () => 'window opening drive').concat(['trend long allowed']);
  assert.match(run(`FACTS: ${many.join('; ')}`), /states 22 facts, more than 20: state the few your verdict rests on/);
  assert.strictEqual(F.checkFacts(`FACTS: ${many.join('; ')}`, briefing()).claims.at(-1).check, false, 'every item checked');
  // A pinned bar whose briefing is missing or corrupt: refused, even with FACTS: none.
  assert.match(F.gateRefusal({ report: { text: 'FACTS: none' }, home: tmpDir(), root: 'MNQ', cycleBars: { MNQ: AS_OF }, now: NOW }), /The bar briefing for this cycle's MNQ bar \(2026-06-10T13:54:00.000Z\) can't be read \(no bar briefing for MNQ\)/);
});

test('facts: the cycle log\'s record - every phase-2 report checked against its symbol\'s cycle bar; never throws', () => {
  const home = tmpDir();
  B.writeBriefing(home, briefing());
  const ev = (id, role, text) => [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Task', input: { subagent_type: role, prompt: 'p' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }),
  ];
  const output = [
    ...ev('p1', 'risk-manager', '## Risk state: account 7\nTradable: yes'),
    ...ev('p2', 'risk-manager', 'VERDICT: VETO - trend: stand aside\nFACTS: trend long blocked; read long aligned'),
    ...ev('a1', 'market-structure-analyst', 'FACTS: vwap above'),
  ].join('\n');
  const context = { symbols: [{ symbol: 'MNQ', bar: { t: AS_OF } }] };
  const r = F.cycleFactChecks({ home, output, context, now: new Date('2026-06-10T13:58:00.000Z') });
  assert.deepStrictEqual(r.counts, { reports: 1, claims: 2, true: 1, false: 1, unchecked: 0 });
  assert.deepStrictEqual([r.reports[0].verdict, r.reports[0].symbol, r.reports[0].status], ['VETO', 'MNQ', 'false']);
  // Another bar's briefing: unchecked, with why; two symbols and a report naming neither: unchecked.
  const later = F.cycleFactChecks({ home, output, context: { symbols: [{ symbol: 'MNQ', bar: { t: '2026-06-10T13:57:00.000Z' } }] } });
  assert.deepStrictEqual(later.counts, { reports: 1, claims: 2, true: 0, false: 0, unchecked: 2 });
  const two = F.cycleFactChecks({ home, output, context: { symbols: [{ symbol: 'MNQ', bar: { t: AS_OF } }, { symbol: 'MES', bar: { t: AS_OF } }] } });
  assert.strictEqual(two.reports[0].unavailable, 'the report names no single cycle symbol');
  const named = F.cycleFactChecks({ home, output: output.replace('stand aside', 'MNQ stand aside'), context: { symbols: [{ symbol: 'MNQ', bar: { t: AS_OF } }, { symbol: 'MES', bar: { t: AS_OF } }] } });
  assert.strictEqual(named.reports[0].symbol, 'MNQ');
  assert.deepStrictEqual(F.cycleFactChecks({ home, output: 'plain text', context: null }).counts, { reports: 0, claims: 0, true: 0, false: 0, unchecked: 0 });
  assert.ok(F.cycleFactChecks({ home, output: { toString() { throw new Error('x'); } } }).error);
});

test('cycleFactChecks: phase 2 the runner ran itself (its role record, context.rolesFile) is checked and logged as a transcript\'s is; no record, or another\'s, adds none', () => {
  const RR = require('../../scripts/lib/trading/runner-roles');
  const home = tmpDir();
  B.writeBriefing(home, briefing());
  const rolesFile = path.join(home, 'logs', 'cycle-roles.jsonl');
  const T = 1.7e12;
  RR.appendRoleRun(rolesFile, { role: 'risk-manager', start: T, end: T + 1, text: '## Risk state: account 7', lookups: [], ok: true });
  RR.appendRoleRun(rolesFile, { role: 'risk-manager', start: T + 10, end: T + 20, text: 'VERDICT: APPROVE - size 1\nFACTS: trend long blocked; read long aligned', lookups: [], ok: true });
  RR.appendRoleRun(rolesFile, { role: 'risk-manager', start: T + 30, end: T + 40, text: 'VERDICT: APPROVE - size 1\nFACTS: vwap above', lookups: [], ok: false });
  const context = { symbols: [{ symbol: 'MNQ', bar: { t: AS_OF } }], rolesFile };
  const r = F.cycleFactChecks({ home, output: '', context, now: new Date('2026-06-10T13:58:00.000Z') });
  assert.deepStrictEqual(r.counts, { reports: 1, claims: 2, true: 1, false: 1, unchecked: 0 }, 'the counted run only (a run that didn\'t count is no report)');
  assert.strictEqual(r.reports[0].verdict, 'APPROVE');
  assert.deepStrictEqual(F.cycleFactChecks({ home, output: '', context: { ...context, rolesFile: null } }).counts.reports, 0);
  assert.deepStrictEqual(F.cycleFactChecks({ home, output: '', context: { ...context, rolesFile: path.join(home, 'gone.jsonl') } }).counts.reports, 0);
});

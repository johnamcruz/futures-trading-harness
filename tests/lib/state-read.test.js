'use strict';

// The head trader's closed-form market-state read (trading/state-read.js): the STATE line it writes once per cycle,
// parsed, and scored field by field against the bar briefing's own labels (and its frames line against its own frame
// reads). A record and a score, never a refusal.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../../scripts/lib/trading/state-read');

/** A briefing with the labels the scorer reads (the shape briefing.js writes). */
function briefing({ h4 = 'up', h1 = 'up', m15 = 'up', dayType = 'trend up', regime = 'trend-up', asOf = '2026-03-02T15:00:00.000Z', breaks = {} } = {}) {
  return {
    asOf,
    sections: {
      m3: { data: { regime: { primary: regime }, today: { dayType }, trendRule: 'Trend rule: LONG allowed (prevailing 4h up); no short against it.', lastBreak: breaks.m3 ? { last: { direction: breaks.m3 } } : null } },
      m15: { data: { frame: { trend: m15 }, lastBreak: breaks.m15 ? { last: { direction: breaks.m15 } } : null } },
      h1: { data: { h4: { trend: h4 }, h1: { trend: h1 }, lastBreak: breaks.h1 ? { last: { direction: breaks.h1 } } : null } },
    },
  };
}
const results = s => Object.fromEntries(Object.entries(s.fields).map(([k, f]) => [k, f.result]));

test('state line: the canonical line reads into frames and agree', () => {
  const r = S.parseStateLine('PLAN:\n1 HTF: 4h up, 1h up, 15m range\nSTATE: 4h up | 1h up | 15m range | frames disagree\nCYCLE RESULT: no-trade - x');
  assert.strictEqual(r.status, 'read');
  assert.deepStrictEqual(r.read, { frames: { '4h': 'up', '1h': 'up', '15m': 'range' }, agree: 'no' });
  assert.deepStrictEqual(r.missing, []);
  assert.deepStrictEqual(r.bad, []);
  assert.strictEqual(r.lines, 1);
  assert.deepStrictEqual(S.parseState('STATE: 4h up | 1h up | 15m range | frames disagree'), r.read);
});

test('state line: no day field (the owner\'s decision, until the Day so far line\'s words): a day item is bad', () => {
  assert.deepStrictEqual(S.REGISTRY.filter(e => !e.derived).map(e => e.key), ['4h', '1h', '15m', 'frames']);
  const r = S.parseStateLine('STATE: 4h up | day trending');
  assert.deepStrictEqual([r.read, r.bad], [{ frames: { '4h': 'up' }, agree: null }, ['day trending']]);
});

test('state line: case, spacing, markdown marks, dashes and separators are tolerated; only the spelling changes', () => {
  const want = { frames: { '4h': 'down', '1h': 'transition', '15m': 'unknown' }, agree: 'yes' };
  for (const line of [
    'STATE: 4h down | 1h transition | 15m unknown | frames agree',
    '  state:4H Down|1H TRANSITION|15M unknown|Frames Agree  ',
    '- **STATE:** `4h down; 1h transition; 15m unknown; frames agree`',
    '> STATE :  4-hour down ,  1 hour transition , 15-min unknown , agree yes.',
    '| STATE: | 4h down | 1h transition | 15 min unknown | agree yes |',
    // En and em dashes between items are separators; any dash inside an item is a hyphen (U+2010-U+2015, U+2212).
    'STATE: 4h down – 1h transition — 15‑min unknown – frames agree',
    'STATE: 4‐hour down | 1‒hour transition | 15―min unknown | 15−min unknown | frames agree',
  ]) {
    const r = S.parseStateLine(line);
    assert.strictEqual(r.status, 'read', line);
    assert.deepStrictEqual(r.read, want, line);
    assert.deepStrictEqual(r.bad, [], line);
  }
  // A colon is required: a bare table cell "| STATE | 4h up |" is no state line.
  assert.strictEqual(S.parseStateLine('| STATE | 4h up |').status, 'none');
});

test('state line: a partial line reads what it states and lists what it left out', () => {
  const r = S.parseStateLine('STATE: 4h up | 1h down');
  assert.strictEqual(r.status, 'read');
  assert.deepStrictEqual(r.read, { frames: { '4h': 'up', '1h': 'down' }, agree: null });
  assert.deepStrictEqual(r.missing, ['15m', 'frames']);
});

test('state line: an item outside the closed vocabulary is bad, never guessed; free text is no read', () => {
  const r = S.parseStateLine('STATE: 4h up | 1h strongly up | 3m up | frames agree');
  assert.strictEqual(r.status, 'read');
  assert.deepStrictEqual(r.read.frames, { '4h': 'up' });
  assert.deepStrictEqual(r.bad, ['1h strongly up', '3m up']);
  for (const garbage of ['STATE: the market looks bullish to me', 'STATE:', 'STATE: up up up', 'STATE: 4h bullish | frames maybe', 'STATE: frames-own yes']) {
    const g = S.parseStateLine(garbage);
    assert.strictEqual(g.status, 'unparsable', garbage);
    assert.strictEqual(g.read, null, garbage);
    assert.strictEqual(S.parseState(garbage), null, garbage);
  }
  // An item is exactly a field and one of its words: a negation, a bracket or a second word hides another claim: bad.
  assert.deepStrictEqual(S.parseStateLine('STATE: 4h not up | 1h up (down) | 1h (up) | 15m up down | frames agree').bad, ['4h not up', '1h up (down)', '1h (up)', '15m up down']);
});

test('state line: none, prose that mentions the word, and lines that only look like it are no state line', () => {
  for (const t of ['', null, undefined, 'PLAN:\n1 HTF: 4h up\nCYCLE RESULT: no-trade - x', 'The state: the 4h is up.', 'I will write STATE: next time', 'STATEMENT: 4h up', 'ESTATE: 4h up']) {
    const r = S.parseStateLine(t);
    assert.strictEqual(r.status, 'none', String(t));
    assert.strictEqual(r.read, null);
  }
});

test('state line: the same read twice is one read; a line that strictly extends the other is the complete one; two different reads are conflicting', () => {
  const same = S.parseStateLine('STATE: 4h up | 1h up\nnotes\nSTATE: 4H UP | 1h up');
  assert.strictEqual(same.status, 'read');
  assert.strictEqual(same.lines, 2);
  // A shorter line that is a strict prefix of the other (a draft, then the full line; or the full line restated short).
  const full = { frames: { '4h': 'up', '1h': 'up', '15m': 'range' }, agree: 'no' };
  assert.deepStrictEqual(S.parseStateLine('STATE: 4h up | 1h up\nSTATE: 4h up | 1h up | 15m range | frames disagree').read, full);
  assert.deepStrictEqual(S.parseStateLine('STATE: 4h up | 1h up | 15m range | frames disagree\nSTATE: 4h up').read, full);
  // The same items, another order, or a shorter line that is no prefix: conflicting stays.
  assert.strictEqual(S.parseStateLine('STATE: 1h up\nSTATE: 4h up | 1h up').status, 'conflicting');
  const two = S.parseStateLine('STATE: 4h up | 1h up\nSTATE: 4h down | 1h up');
  assert.strictEqual(two.status, 'conflicting');
  assert.strictEqual(two.read, null);
  assert.strictEqual(S.parseState('STATE: 4h up\nSTATE: 4h down'), null);
  assert.strictEqual(S.parseStateLine('STATE: 4h up | 4h down | 1h up').status, 'conflicting');
  // Stated twice the same way inside a line: one item.
  assert.deepStrictEqual(S.parseStateLine('STATE: 4h up | 4h up').read.frames, { '4h': 'up' });
});

test('state score: each frame field matches or mismatches the briefing label', () => {
  const b = briefing({ h4: 'up', h1: 'down', m15: 'range' });
  const s = S.scoreState(S.parseState('STATE: 4h up | 1h up | 15m range'), b);
  assert.deepStrictEqual(results(s), { '4h': 'match', '1h': 'mismatch', '15m': 'match' });
  assert.deepStrictEqual(s.fields['1h'], { read: 'up', fact: 'down', field: 'h1.h1.trend', result: 'mismatch' });
  assert.deepStrictEqual(s.counts, { match: 2, mismatch: 1, unknown: 0 });
});

test('state score: what the briefing does not compute, or the model leaves unknown, is unknown, never a mismatch', () => {
  // The briefing's frame labels are up, down or range: a transition read can't be checked against them.
  const t = S.scoreState(S.parseState('STATE: 4h transition | 1h unknown | 15m down'), briefing({ m15: 'unknown' }));
  assert.strictEqual(t.fields['4h'].result, 'unknown');
  assert.match(t.fields['4h'].why, /no transition label/);
  assert.strictEqual(t.fields['1h'].result, 'unknown');
  assert.match(t.fields['1h'].why, /read unknown/);
  assert.strictEqual(t.fields['15m'].result, 'unknown');
  assert.match(t.fields['15m'].why, /no 15m trend/);
  assert.deepStrictEqual(t.counts, { match: 0, mismatch: 0, unknown: 3 });
  // A briefing without the section at all: unknown too.
  const none = S.scoreState(S.parseState('STATE: 4h up | frames agree'), { sections: {} });
  assert.deepStrictEqual([none.fields['4h'].result, none.fields.frames.result], ['unknown', 'unknown']);
  // No briefing: every label field unknown, with why.
  const nob = S.scoreState(S.parseState('STATE: 4h up'), null);
  assert.strictEqual(nob.fields['4h'].result, 'unknown');
  // No read: no fields.
  assert.deepStrictEqual(S.scoreState(null, briefing()), { fields: {}, counts: { match: 0, mismatch: 0, unknown: 0 } });
});

test('state score: frames against the three labels; an unknown label leaves it unknown unless the known ones already differ', () => {
  const agree = word => S.scoreState(S.parseState(`STATE: frames ${word}`), briefing({ h4: 'up', h1: 'up', m15: 'up' })).fields.frames;
  assert.deepStrictEqual([agree('agree').result, agree('disagree').result], ['match', 'mismatch']);
  assert.strictEqual(agree('agree').fact, 'yes');
  const differ = S.scoreState(S.parseState('STATE: frames agree'), briefing({ h4: 'up', h1: 'range', m15: 'up' })).fields.frames;
  assert.deepStrictEqual([differ.fact, differ.result], ['no', 'mismatch']);
  assert.strictEqual(S.scoreState(S.parseState('STATE: frames agree'), briefing({ h4: 'up', h1: 'up', m15: 'unknown' })).fields.frames.result, 'unknown');
  const known = S.scoreState(S.parseState('STATE: frames disagree'), briefing({ h4: 'up', h1: 'down', m15: 'unknown' })).fields.frames;
  assert.deepStrictEqual([known.fact, known.result], ['no', 'match']);
  assert.strictEqual(S.scoreState(S.parseState('STATE: frames unknown'), briefing()).fields.frames.result, 'unknown');
});

test('state score: frames-own scores the frames word against the model\'s own three frame reads, apart from the labels', () => {
  // Self-consistent: a transition read with frames disagree is no mismatch of its own line, whatever the labels say.
  const s = S.scoreState(S.parseState('STATE: 4h transition | 1h up | 15m up | frames disagree'), briefing({ h4: 'up', h1: 'up', m15: 'up' }));
  assert.deepStrictEqual([s.fields['frames-own'].result, s.fields['frames-own'].fact, s.fields.frames.result], ['match', 'no', 'mismatch']);
  assert.strictEqual(s.fields['frames-own'].field, 'the read\'s own 4h, 1h and 15m');
  const inconsistent = S.scoreState(S.parseState('STATE: 4h up | 1h up | 15m up | frames disagree'), null);
  assert.deepStrictEqual([inconsistent.fields['frames-own'].result, inconsistent.fields.frames.result], ['mismatch', 'unknown'], 'scored without a briefing too');
  assert.strictEqual(S.scoreState(S.parseState('STATE: 4h up | 1h up | 15m up | frames agree'), null).fields['frames-own'].result, 'match');
  // A frame unstated or unknown in the read: its own agreement can't be told.
  assert.strictEqual(S.scoreState(S.parseState('STATE: 4h up | 1h up | frames agree'), null).fields['frames-own'].result, 'unknown');
  assert.strictEqual(S.scoreState(S.parseState('STATE: 4h up | 1h unknown | 15m up | frames agree'), null).fields['frames-own'].result, 'unknown');
  // No frames word: no frames-own field.
  assert.ok(!('frames-own' in S.scoreState(S.parseState('STATE: 4h up | 1h up | 15m up'), null).fields));
});

test('state facts: the labels and their context as the code had them, recorded, never scored', () => {
  const f = S.stateFacts(briefing({ h1: 'up', breaks: { h1: 'down', m15: 'up', m3: 'down' } }));
  assert.deepStrictEqual(f, {
    frames: { '4h': 'up', '1h': 'up', '15m': 'up' }, dayType: 'trend up', regime: 'trend-up',
    trendRule: 'Trend rule: LONG allowed (prevailing 4h up); no short against it.', breaks: { '1h': 'down', '15m': 'up', '3m': 'down' },
    daySoFar: null, pullback: null,
  });
  assert.strictEqual(S.stateFacts(null), null);
});

test('state facts: the Day so far and Pullback lines\' words as the cycle bar\'s briefing had them (what the trade feedback tags an entry with)', () => {
  const with_ = (today, pullback) => {
    const b = briefing();
    Object.assign(b.sections.m3.data.today, today);
    if (pullback !== undefined) b.sections.m3.data.pullback = pullback;
    return S.stateFacts(b);
  };
  assert.strictEqual(with_({ soFar: { status: 'read', read: 'directional' } }).daySoFar, 'directional');
  assert.strictEqual(with_({ soFar: { status: 'read', read: 'rotational' } }).daySoFar, 'rotational');
  assert.strictEqual(with_({ soFar: { status: 'too early', bars: 3 } }).daySoFar, 'too early');
  assert.strictEqual(with_({ soFar: { status: 'unknown', reason: 'x' } }).daySoFar, null, 'unknown: no word');
  assert.strictEqual(with_({}).daySoFar, null, 'outside RTH: none');
  // The Pullback line: absent (the flat cycle's read found none) is "none"; not computed (another lane's briefing) null.
  assert.strictEqual(with_({}, null).pullback, 'none');
  assert.strictEqual(with_({}).pullback, null);
  const leg = { side: 'long', frame: '15m', leg: { origin: 100, extreme: 110, atr: 3 }, depth: 0.4, pastOrigin: false, stacked: false };
  assert.strictEqual(with_({}, leg).pullback, 'depth 40%');
  assert.strictEqual(with_({}, { ...leg, stacked: true }).pullback, 'depth 40%, breaks against stacked');
  assert.strictEqual(with_({}, { ...leg, pastOrigin: true, depth: 1.2 }).pullback, 'leg given back');
  assert.strictEqual(with_({}, { ...leg, leg: { ...leg.leg, atr: 0.5 } }).pullback, 'small leg');
  assert.strictEqual(with_({}, { ...leg, depth: null }).pullback, 'depth unknown');
});

test('state vocabulary: one registry entry per field, the parser and the scorer read only it', () => {
  assert.deepStrictEqual(S.REGISTRY.map(e => e.key), ['4h', '1h', '15m', 'frames', 'frames-own']);
  for (const e of S.REGISTRY) {
    assert.ok(Array.isArray(e.values) && e.values.includes('unknown'), e.key);
    assert.strictEqual(typeof e.fact, 'function', e.key);
  }
  // A registry with a field added reads and scores it without another change (the State, Day so far, Pullback reads later).
  const extra = { key: 'pullback', slot: 'pullback', values: ['pullback', 'reversal', 'unknown'], fact: () => ({ value: 'pullback', field: 'test' }) };
  const reg = [...S.REGISTRY, extra];
  const r = S.parseStateLine('STATE: 4h up | pullback reversal', reg);
  assert.deepStrictEqual(r.read.pullback, 'reversal');
  assert.strictEqual(S.scoreState(r.read, briefing(), reg).fields.pullback.result, 'mismatch');
});

test('cycle state read: the record a cycle log keeps; no line, a broken briefing and a throw are recorded, never raised', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-state-'));
  const b = briefing({ h1: 'down', asOf: '2026-03-02T15:00:00.000Z' });
  fs.mkdirSync(path.join(home, 'briefing'), { recursive: true });
  fs.writeFileSync(path.join(home, 'briefing', 'MNQ.json'), JSON.stringify(b));
  const context = { symbols: [{ symbol: 'MNQ', bar: { t: '2026-03-02T15:00:00.000Z' } }] };
  const rec = S.cycleStateRead({ home, text: 'STATE: 4h up | 1h up | 15m up | frames agree', context, now: new Date('2026-03-02T15:03:02Z') });
  assert.strictEqual(rec.status, 'read');
  assert.strictEqual(rec.symbol, 'MNQ');
  assert.strictEqual(rec.bar, '2026-03-02T15:00:00.000Z');
  assert.strictEqual(rec.briefing, null);
  assert.deepStrictEqual(results(rec), { '4h': 'match', '1h': 'mismatch', '15m': 'match', frames: 'mismatch', 'frames-own': 'match' });
  assert.deepStrictEqual(rec.counts, { match: 3, mismatch: 2, unknown: 0 });
  assert.deepStrictEqual(rec.facts.frames, { '4h': 'up', '1h': 'down', '15m': 'up' });
  // No line: recorded as such, with the facts the briefing had.
  const none = S.cycleStateRead({ home, text: 'CYCLE RESULT: no-trade - x', context, now: new Date('2026-03-02T15:03:02Z') });
  assert.deepStrictEqual([none.status, none.read, none.fields, none.counts], ['none', null, {}, { match: 0, mismatch: 0, unknown: 0 }]);
  assert.ok(none.facts);
  // Another bar's briefing: unscored (unknown), why recorded.
  const stale = S.cycleStateRead({ home, text: 'STATE: 4h up', context: { symbols: [{ symbol: 'MNQ', bar: { t: '2026-03-02T15:03:00.000Z' } }] }, now: new Date() });
  assert.match(stale.briefing, /not the cycle's/);
  assert.strictEqual(stale.fields['4h'].result, 'unknown');
  assert.match(stale.fields['4h'].why, /no bar briefing \(/);
  // No symbol, a bad home: never throws.
  assert.strictEqual(S.cycleStateRead({ home, text: 'STATE: 4h up', context: null }).fields['4h'].result, 'unknown');
  const broken = S.cycleStateRead({ home: { not: 'a path' }, text: 'STATE: 4h up', context });
  assert.ok(broken.status === 'read' || broken.error);
  assert.doesNotThrow(() => S.cycleStateRead({ home, text: { toString() { throw new Error('boom'); } }, context }));
  assert.ok(S.cycleStateRead({ home, text: { toString() { throw new Error('boom'); } }, context }).error);
});

test('class word: the closed words, frozen; the cite names, frozen, each one of the record\'s own facts (stateFacts)', () => {
  assert.deepStrictEqual(S.CLASS_WORDS, ['trend-up', 'trend-down', 'chop', 'unclear']);
  assert.deepStrictEqual(Object.keys(S.CITES), ['4h-trend', '1h-trend', '15m-trend', 'trend-rule', 'regime', 'day-type', 'day-so-far', 'pullback', '1h-break', '15m-break', '3m-break']);
  assert.ok(Object.isFrozen(S.CLASS_WORDS) && Object.isFrozen(S.CITES));
  // Each name points at a field the STATE record already keeps (stateFacts), and every such field has a name.
  const facts = S.stateFacts(briefing({ breaks: { h1: 'down', m15: 'up', m3: 'down' } }));
  const leaves = Object.entries(facts).flatMap(([k, v]) => (v && typeof v === 'object' ? Object.keys(v).map(x => `${k}.${x}`) : [k]));
  assert.deepStrictEqual(Object.values(S.CITES).sort(), leaves.sort());
});

test('class word: read by equality from the STATE line, recorded with the cites; the frames read is unchanged', () => {
  const r = S.parseStateLine('STATE: 4h up | 1h up | 15m range | frames disagree | class chop | cites 15m-trend, day-so-far');
  assert.deepStrictEqual([r.status, r.read, r.missing, r.bad], ['read', { frames: { '4h': 'up', '1h': 'up', '15m': 'range' }, agree: 'no' }, [], []]);
  assert.deepStrictEqual([r.classWord, r.classStatus, r.cites, r.citesDropped], ['chop', 'stated', ['15m-trend', 'day-so-far'], 0]);
  for (const w of S.CLASS_WORDS) assert.strictEqual(S.parseStateLine(`STATE: 4h up | class ${w}`).classWord, w, w);
  // Case and markdown marks as the other fields have them; nothing else.
  assert.strictEqual(S.parseStateLine('**STATE:** 4h up | Class `Trend-Up`').classWord, 'trend-up');
  // Commas everywhere: the items after `cites` are its names.
  const c = S.parseStateLine('STATE: 4h up, 1h up, 15m up, frames agree, class trend-up, cites 4h-trend, trend-rule');
  assert.deepStrictEqual([c.read.agree, c.classWord, c.cites, c.bad], ['yes', 'trend-up', ['4h-trend', 'trend-rule'], []]);
  // The cites before the class, commas everywhere: the class item ends the list, the class is kept.
  const before = S.parseStateLine('STATE: 4h up, cites regime, pullback, class chop, 1h up');
  assert.deepStrictEqual([before.classWord, before.cites, before.citesDropped, before.read.frames], ['chop', ['regime', 'pullback'], 0, { '4h': 'up', '1h': 'up' }]);
  // Spaces between names, a repeat: each name once, in order.
  assert.deepStrictEqual(S.parseStateLine('STATE: 4h up | cites regime  pullback, regime').cites, ['regime', 'pullback']);
  // The class without cites, the cites without the class.
  assert.deepStrictEqual(S.parseStateLine('STATE: 4h up | class unclear').cites, []);
  const only = S.parseStateLine('STATE: 4h up | cites regime');
  assert.deepStrictEqual([only.classWord, only.classStatus, only.cites], [null, 'unstated', ['regime']]);
  // The class alone is a read of its own (no frame stated).
  const alone = S.parseStateLine('STATE: class chop');
  assert.deepStrictEqual([alone.status, alone.classWord, alone.missing], ['read', 'chop', ['4h', '1h', '15m', 'frames']]);
});

test('class word: a word outside the four is no class, never mapped; a name outside the list is dropped and counted', () => {
  for (const w of ['bullish', 'trend', 'up', 'trend up', 'choppy', 'range', 'trending-up', 'trend-up.x']) {
    const r = S.parseStateLine(`STATE: 4h up | class ${w}`);
    assert.deepStrictEqual([r.classWord, r.classStatus], [null, 'unstated'], w);
    assert.ok(r.bad.length === 1, `${w}: a bad item`);
    assert.strictEqual(r.status, 'read', `${w}: the frames read stands`);
  }
  const r = S.parseStateLine('STATE: 4h up | class chop | cites vwap, regime, 1h-trend, the 15m trend');
  assert.deepStrictEqual([r.cites, r.citesDropped, r.bad], [['regime', '1h-trend'], 4, []]);
  // A bare `cites` label (or `cites:`) names nothing and writes no `none`: absent, never `none`.
  for (const bare of ['STATE: 4h up | cites', 'STATE: 4h up | cites:']) {
    const b = S.parseStateLine(bare);
    assert.deepStrictEqual([b.cites, b.citesDropped, b.citesStated, b.bad], [[], 0, 'absent', []], bare);
  }
  // A name and `none`: the name stands, names stated.
  const both = S.parseStateLine('STATE: 4h up | cites regime, none');
  assert.deepStrictEqual([both.cites, both.citesDropped, both.citesStated], [['regime'], 0, 'names']);
  // `none` and `n/a` are an empty list, not a dropped name, and recorded as stated nothing (citesStated none), apart from
  // a line that has no cites field (absent) and one that names any (names).
  for (const w of ['none', 'n/a', 'None']) {
    const e = S.parseStateLine(`STATE: 4h up | class chop | cites ${w}`);
    assert.deepStrictEqual([e.cites, e.citesDropped, e.bad, e.citesStated], [[], 0, [], 'none'], w);
  }
  const kept = S.parseStateLine('STATE: 4h up | cites none, regime');
  assert.deepStrictEqual([kept.cites, kept.citesDropped, kept.citesStated], [['regime'], 0, 'names']);
  assert.strictEqual(S.parseStateLine('STATE: 4h up | class chop').citesStated, 'absent');
  assert.strictEqual(S.parseStateLine('STATE: 4h up | cites vwap').citesStated, 'names', 'a name written, though dropped');
  assert.strictEqual(S.parseStateLine('CYCLE RESULT: no-trade - x').citesStated, 'absent');
});

test('class word: only an item that reads as a field or a class word ends the cites list; a field-like spelling is a dropped name', () => {
  const r = S.parseStateLine('STATE: 4h up | class trend-up | cites regime, 15m break, pullback');
  assert.deepStrictEqual([r.cites, r.citesDropped, r.bad, r.read.frames], [['regime', 'pullback'], 2, [], { '4h': 'up' }]);
  for (const spelling of ['1h break', '4 hour trend', '15m', 'frames', 'agree', 'class']) {
    const x = S.parseStateLine(`STATE: 4h up | cites regime, ${spelling}, day-so-far`);
    assert.deepStrictEqual([x.cites, x.bad], [['regime', 'day-so-far'], []], spelling);
    assert.ok(x.citesDropped >= 1, spelling);
  }
  // `class` with more than one word after it is no class item: names, dropped and counted.
  const longer = S.parseStateLine('STATE: 4h up | cites regime, class chop now');
  assert.deepStrictEqual([longer.cites, longer.citesDropped, longer.bad, longer.classWord], [['regime'], 3, [], null]);
  // A two-word `class <x>` ends the list: a class word, or a word outside the four as a bad item, never a dropped name.
  const bull = S.parseStateLine('STATE: 4h up | cites regime, class bullish');
  assert.deepStrictEqual([bull.cites, bull.citesDropped, bull.bad, bull.classWord, bull.citesStated], [['regime'], 0, ['class bullish'], null, 'names']);
  const chop = S.parseStateLine('STATE: 4h up | cites regime, class chop');
  assert.deepStrictEqual([chop.cites, chop.citesDropped, chop.bad, chop.classWord], [['regime'], 0, [], 'chop']);
  // A field right after a cite ends it: frames agree, agree yes.
  const f = S.parseStateLine('STATE: 4h up, 1h up, 15m up, cites regime, frames agree');
  assert.deepStrictEqual([f.read.agree, f.cites, f.citesDropped, f.missing], ['yes', ['regime'], 0, []]);
  const g = S.parseStateLine('STATE: 4h up, 1h down, cites pullback, agree no');
  assert.deepStrictEqual([g.read.agree, g.cites, g.citesDropped], ['no', ['pullback'], 0]);
});

test('class word: a field item ends the cites list, so a comma line with cites before the frames loses none of them', () => {
  const r = S.parseStateLine('STATE: 4h up, cites regime, 1h up, 15m up, frames agree');
  assert.deepStrictEqual([r.status, r.read, r.missing, r.bad, r.cites, r.citesDropped], ['read', { frames: { '4h': 'up', '1h': 'up', '15m': 'up' }, agree: 'yes' }, [], [], ['regime'], 0]);
  // The `agree` form and a spelled frame (`15-min`) end it too.
  const a = S.parseStateLine('STATE: cites pullback, 15-min up, agree no');
  assert.deepStrictEqual([a.read.frames, a.read.agree, a.cites], [{ '15m': 'up' }, 'no', ['pullback']]);
});

test('class word: a line with only cites is no read (unparsable, its items listed), as before the class word', () => {
  for (const [line, bad] of [['STATE: cites regime', ['cites regime']], ['STATE: cites vwap', ['cites vwap']], ['STATE: cites regime, vwap', ['cites regime', 'vwap']]]) {
    const r = S.parseStateLine(line);
    assert.deepStrictEqual([r.status, r.read, r.bad, r.classWord, r.cites, r.citesDropped], ['unparsable', null, bad, null, [], 0], line);
  }
  // Beside a read line, a cites-only line's items are listed as bad: a written cite leaves a trace; the read is the other line.
  const two = S.parseStateLine('STATE: 4h up | 1h up | class chop\nSTATE: cites regime, vwap');
  assert.deepStrictEqual([two.status, two.classWord, two.cites, two.bad], ['read', 'chop', [], ['cites regime', 'vwap']]);
  const conflict = S.parseStateLine('STATE: 4h up\nSTATE: 4h down\nSTATE: cites pullback');
  assert.deepStrictEqual([conflict.status, conflict.bad], ['conflicting', ['cites pullback']]);
});

test('class word: unstated when the line has none, and on no line, an unparsable or conflicting one; two lines differing only in the class conflict', () => {
  const unstated = r => [r.classWord, r.classStatus, r.cites, r.citesDropped];
  assert.deepStrictEqual(unstated(S.parseStateLine('STATE: 4h up | 1h up | 15m up | frames agree')), [null, 'unstated', [], 0]);
  assert.deepStrictEqual(unstated(S.parseStateLine('CYCLE RESULT: no-trade - x')), [null, 'unstated', [], 0]);
  assert.deepStrictEqual(unstated(S.parseStateLine('STATE: the trend is up, class chop maybe')), [null, 'unstated', [], 0]);
  // Prose that names a class is no class: only the STATE line's item counts.
  assert.deepStrictEqual(unstated(S.parseStateLine('The market is chop today.\nclass chop\nSTATE: 4h up')), [null, 'unstated', [], 0]);
  const two = S.parseStateLine('STATE: 4h up | class chop\nSTATE: 4h up | class trend-up');
  assert.deepStrictEqual([two.status, two.classWord], ['conflicting', null]);
  assert.strictEqual(S.parseStateLine('STATE: 4h up | class chop | class trend-up').status, 'conflicting');
  // The same line twice is one read; a draft without the class gives way to the complete line.
  assert.strictEqual(S.parseStateLine('STATE: 4h up | class chop\nSTATE: 4h up | class chop').classWord, 'chop');
  assert.deepStrictEqual(unstated(S.parseStateLine('STATE: 4h up | 1h up\nSTATE: 4h up | 1h up | class chop | cites regime')), ['chop', 'stated', ['regime'], 0]);
  // The class is never scored: no field, no count.
  const read = S.parseStateLine('STATE: 4h up | class chop | cites regime');
  assert.deepStrictEqual(Object.keys(S.scoreState(read.read, briefing()).fields), ['4h']);
});

test('class word (property, seeded): any order, separator or junk: the class is null or one of the four, the cites a duplicate-free subset of the names, and the frames read the same with or without them', () => {
  let seed = 20261111;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const pick = xs => xs[rand(xs.length)];
  const NAMES = Object.keys(S.CITES);
  const JUNK = ['vwap', 'the', 'bullish', 'trend', 'up', '4h', 'class', 'cites', 'choppy', 'x-y', 'Trend Up', '15-min'];
  for (let i = 0; i < 500; i += 1) {
    const frames = ['4h', '1h', '15m'].filter(() => rand(2)).map(k => `${k} ${pick(S.FRAME_VALUES)}`);
    if (rand(2)) frames.push(pick([`frames ${pick(['agree', 'disagree'])}`, `agree ${pick(['yes', 'no', 'unknown'])}`]));
    const cls = rand(3) ? [`class ${rand(4) ? pick(S.CLASS_WORDS) : pick(JUNK)}`] : [];
    const names = Array.from({ length: rand(4) }, () => (rand(3) ? pick(NAMES) : pick(JUNK)));
    const cites = rand(3) ? [`cites ${names.join(pick([', ', ' ', ',']))}`] : [];
    const items = [...frames, ...cls, ...cites].sort(() => rand(3) - 1);
    const sep = pick([' | ', ' ; ', ', ']);
    const line = `STATE: ${items.join(sep)}`;
    const r = S.parseStateLine(line);
    assert.ok(r.classWord === null || S.CLASS_WORDS.includes(r.classWord), line);
    assert.strictEqual(r.classStatus, r.classWord ? 'stated' : 'unstated', line);
    assert.ok(r.cites.every(n => NAMES.includes(n)) && new Set(r.cites).size === r.cites.length, line);
    // A stated class word is exactly the line's, when the line's class item is a valid one.
    if (cls.length && S.CLASS_WORDS.includes(cls[0].slice('class '.length))) assert.strictEqual(r.classWord, cls[0].slice('class '.length), line);
    // The frames read with the class and cites items removed is the same.
    if (frames.length) {
      const plain = S.parseStateLine(`STATE: ${frames.join(sep)}`);
      assert.deepStrictEqual(r.read && [r.read.frames, r.read.agree], [plain.read.frames, plain.read.agree], line);
    }
  }
});

test('cycle state read: the record carries the class word and cites as written; nothing fills an unstated class from the briefing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-state-'));
  // A briefing whose own words could name a class (regime trend-up, day type trend up): never read into the record.
  fs.mkdirSync(path.join(home, 'briefing'), { recursive: true });
  fs.writeFileSync(path.join(home, 'briefing', 'MNQ.json'), JSON.stringify(briefing({ regime: 'trend-up', dayType: 'trend up' })));
  const context = { symbols: [{ symbol: 'MNQ', bar: { t: '2026-03-02T15:00:00.000Z' } }] };
  const at = new Date('2026-03-02T15:03:02Z');
  const rec = S.cycleStateRead({ home, text: 'STATE: 4h up | 1h up | 15m up | frames agree | class chop | cites regime, vwap', context, now: at });
  assert.deepStrictEqual([rec.classWord, rec.classStatus, rec.cites, rec.citesDropped, rec.citesStated], ['chop', 'stated', ['regime'], 1, 'names']);
  assert.strictEqual(S.cycleStateRead({ home, text: 'STATE: 4h up | class chop | cites none', context, now: at }).citesStated, 'none');
  // The frames scored as before (frames-own included); the class word and cites never scored.
  assert.deepStrictEqual(Object.keys(rec.fields), ['4h', '1h', '15m', 'frames', 'frames-own']);
  assert.deepStrictEqual(rec.counts, { match: 5, mismatch: 0, unknown: 0 });
  for (const text of ['STATE: 4h up | 1h up | 15m up | frames agree', 'CYCLE RESULT: no-trade - x', 'STATE: nonsense']) {
    const r = S.cycleStateRead({ home, text, context, now: at });
    assert.deepStrictEqual([r.classWord, r.classStatus, r.cites, r.citesDropped, r.citesStated], [null, 'unstated', [], 0, 'absent'], text);
  }
});

test('state line: the trade-session skill documents the grammar the parser reads, in one place, as the head trader\'s own read', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'trade-session', 'SKILL.md'), 'utf8');
  const flat = skill.replace(/\s+/g, ' ');
  const m = /`(STATE: [^`]+)`/.exec(flat);
  assert.ok(m, 'the grammar');
  const frameWords = /`<f>` is ((?:`[a-z]+`(?:, | or )?)+)/.exec(flat);
  assert.ok(frameWords, 'the frame words');
  const words = [...frameWords[1].matchAll(/`([a-z]+)`/g)].map(x => x[1]);
  assert.deepStrictEqual(words, S.FRAME_VALUES);
  // The class words and the cite names, exactly the frozen lists, in order.
  const classWords = /`<c>`[^`]* is ((?:`[a-z-]+`(?:, | or )?)+)/.exec(flat);
  assert.ok(classWords, 'the class words');
  assert.deepStrictEqual([...classWords[1].matchAll(/`([a-z-]+)`/g)].map(x => x[1]), S.CLASS_WORDS);
  const citeNames = /`<names>`[^`]* from ((?:`[a-z0-9-]+`(?:, | or )?)+)/.exec(flat);
  assert.ok(citeNames, 'the cite names');
  const names = [...citeNames[1].matchAll(/`([a-z0-9-]+)`/g)].map(x => x[1]);
  assert.deepStrictEqual(names, Object.keys(S.CITES));
  // Every filled-in instance of the grammar reads in full: the frames, the class word, the cites.
  for (const f of words) {
    for (const a of ['agree', 'disagree']) {
      for (const c of S.CLASS_WORDS) {
        const line = m[1].replace(/<f>/g, f).replace(/frames <[^>]+>/, `frames ${a}`).replace('<c>', c).replace('<names>', names.join(', '));
        const r = S.parseStateLine(line);
        assert.deepStrictEqual([r.status, r.missing, r.bad, r.classWord, r.cites, r.citesDropped], ['read', [], [], c, names, 0], line);
      }
    }
  }
  // The model's own read, not the labels copied; read first, written last; recorded, no code decides from it, and no word of a score to aim at.
  assert.ok(flat.includes('your own read from the bars and facts, not the labels copied'));
  assert.ok(flat.includes('read it first, write it last; it is recorded; no code decides from it'));
  assert.ok(!flat.includes('changes no step'), 'the decision follows the read now (taught, below): the old sentence is gone');
  const start = flat.indexOf('Last line of the PLAN block');
  const para = flat.slice(start, flat.indexOf('No other words.', start));
  assert.ok(para.includes('`3m-break`'), 'the paragraph runs to its last name');
  // `none` is taught for a read nothing in the list supports, and the documented line with it reads as stated nothing.
  assert.ok(para.includes('`3m-break`; `none` when none supports it'), 'none taught');
  const withNone = S.parseStateLine(m[1].replace(/<f>/g, 'up').replace(/frames <[^>]+>/, 'frames agree').replace('<c>', 'unclear').replace('<names>', 'none'));
  assert.deepStrictEqual([withNone.status, withNone.bad, withNone.cites, withNone.citesDropped, withNone.citesStated], ['read', [], [], 0, 'none']);
  assert.doesNotMatch(para, /scor|check|graded|accura|\bT[1-5]\b|\bA-D\b|setup/i);
  // One grammar: no other skill or agent documents it (trader-process only shows the line in its PLAN template, below).
  for (const dir of ['skills', 'agents']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      const file = dir === 'skills' ? path.join(ROOT, dir, f, 'SKILL.md') : path.join(ROOT, dir, f);
      if (!fs.existsSync(file) || f === 'trade-session' || f === 'trader-process') continue;
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /^STATE:|`STATE:/m, file);
    }
  }
});

test('state line: the PLAN template and its example end with the STATE line (a model fills the template it copies), and the grammar stays in trade-session', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const tp = fs.readFileSync(path.join(ROOT, 'skills', 'trader-process', 'SKILL.md'), 'utf8');
  const [spec, examples] = tp.split('## Examples');
  // The template: the PLAN block's last line, after 9 Manage, a filled-in instance of the trade-session grammar.
  const tpl = /9 Manage:[^\n]*\n(STATE: [^\n]+)\n```/.exec(spec);
  assert.ok(tpl, 'the template ends with the STATE line');
  const filled = S.parseStateLine(tpl[1].replace(/<f>/g, 'range').replace(/frames <[^>]+>/, 'frames agree').replace('<c>', 'chop').replace('<names>', 'regime'));
  assert.deepStrictEqual([filled.status, filled.bad, filled.classWord, filled.cites], ['read', [], 'chop', ['regime']]);
  // The example block's line reads in full (a complete line, every field, the class word and its cites).
  const ex = /9 Manage:[^\n]*\n(STATE: [^\n]+)\n```/.exec(examples);
  assert.ok(ex, 'the example ends with the STATE line');
  const r = S.parseStateLine(ex[1]);
  assert.deepStrictEqual([r.status, r.missing, r.bad, r.classStatus, r.citesDropped], ['read', [], [], 'stated', 0]);
  assert.ok(r.cites.length > 0);
  // trade-session says where it goes (the PLAN's last line), still your own read, and records only.
  const flat = fs.readFileSync(path.join(ROOT, 'skills', 'trade-session', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(flat.includes('Last line of the PLAN block'), 'trade-session places it');
  assert.ok(flat.includes('read it first, write it last; it is recorded; no code decides from it'));
  // Every PLAN, an open trade's too (a managed cycle writes one, and 9 in 10 of them left the line out).
  assert.ok(flat.includes("every PLAN, an open trade's too"));
});

test('state line: the decision follows the model\'s own STATE read (taught, no code decides from it): a take on its side, chop, unclear or a trend class its own 4h and 1h do not show a pass', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\s+/g, ' ');
  const ts = read('skills/trade-session/SKILL.md');
  const start = ts.indexOf('**The decision follows your STATE read**');
  assert.ok(start > ts.indexOf('No other words.'), 'after the grammar, outside the paragraph that carries no word of a setup or a check');
  const para = ts.slice(start, ts.indexOf('- **The priority order**', start));
  for (const s of [
    // The head trader's alone; taught, never a gate: the gate and compose_check stay as they are
    // (tests/e2e/state-read-invariance-e2e.test.js).
    "(the head trader's own, the last line of its PLAN; taught: the gate and `compose_check` do not read it)",
    // The class follows the frames the model wrote: a trend class needs its 4h and 1h that way.
    "The class follows your frames: your 4h and 1h both one way → that trend class (a 15m pullback or range under them doesn't cancel it or make it `unclear`); one or both `range` → `chop` or `unclear`.",
    // A take agrees with the read: the class and the 4h and 1h on the setup's side (the never-counter-HTF rule, in its own words).
    'A take: `class` on its side (`trend-up` long, `trend-down` short), your 4h and 1h too (`up` long, `down` short).',
    // compose_check first (its record is what the pass is scored on), then a pass that names the read: the head trader's
    // own step 8, never called a decisive against (the scorecard's DECISIVE is a 1h CHoCH only).
    '`compose_check` still runs first (its record is the evidence the pass is scored on).',
    "Then `chop`, `unclear`, or a trend class your 4h and 1h don't show (`trend-down` with 4h and 1h `range`) → pass, naming that read (your step 8, not a decisive against).",
  ]) assert.ok(para.includes(s), s);
  assert.ok(para.indexOf('still runs first') < para.indexOf('→ pass, naming that read'), 'compose first, then the pass');
  assert.doesNotMatch(para.replace('not a decisive against', ''), /decisive/);
  // The other sentences stay true: pass only on a decisive against or the head trader's own read.
  assert.ok(ts.includes("pass only on a decisive against, or your own STATE read off the setup's side (above)."));
  // The 15m is no condition: a pullback entry has the 15m ranging or turning (the recorded trend-leg takes: 15m range,
  // transition); it is named once, only to say it doesn't cancel the 4h and 1h.
  assert.strictEqual(para.split('15m').length, 2);
  assert.ok(para.includes("(a 15m pullback or range under them doesn't cancel it or make it `unclear`)"));
  // No filled-in line here: the one example stays in trader-process (the class-word test below).
  assert.doesNotMatch(para, /`STATE:/);
  // Step 8 and the always-on decision rule point to it, addressed to the head trader alone.
  const tp = read('skills/trader-process/SKILL.md');
  assert.ok(tp.includes("**Decision.** Compose OK → take (a prop attempt: the full verdict size; else step 5 sizes it); refused → pass. The head trader alone: its own STATE read, the last line of its PLAN, off the setup's side → pass (`trade-session`, step 3). One reason."));
  assert.ok(tp.includes("only a decisive against, the head trader's own STATE read off the setup's side (step 8), the hard steps and the gate's end a plan early."));
  // The scorecard line says what the scorecard records (scripts/lib/replay/scorecard.js stateOffSide): plain, true.
  assert.ok(tp.includes("excessive abstention 8 (a pass on the head trader's own STATE read after an OK compose_check, named in its reason: unchecked, judged by hand)"));
  assert.ok(read('rules/trading/decision.md').includes("The head trader's own STATE read, the last line of its PLAN, off the setup's side (`trade-session`) → pass."));
  // Phase 2 checks what its file lists, never the STATE line: a missing read is no veto (no code forwards it).
  assert.ok(read('agents/risk-manager.md').includes("The head trader's own STATE read (the last line of its PLAN) is the head trader's own step 8, never a check of yours: check what this file lists, never the STATE line; a missing STATE read is no reason to veto."));
  // The side rule (the owner's never-counter-HTF rule, delegated 11-12: text only, the code's trend rule unchanged): the 4h
  // and the 1h both the side's way; one or both ranging, no trade. Then the head trader's OWN read (not the labels) decides.
  const htf = read('skills/htf-to-ltf/SKILL.md');
  assert.ok(htf.includes('**The side rule** (in an attempt): the 4h and the 1h both trending your way; else no trade (one or both ranging: no trade).'));
  assert.doesNotMatch(htf, /neither against|declared short: short only|`Trend declared\?` your way/);
  assert.ok(htf.includes("Then the head trader's own STATE read decides the take (`trade-session` step 3): its own 4h and 1h both range, or one of them not trending the side, is `chop` or `unclear` to it; both the side's way, a 15m range or pullback under them, is the side's trend class."));
  assert.ok(htf.includes('4h UP, 1h RANGE: no trade. 4h and 1h RANGE: no trade.'));
  assert.ok(htf.includes('Head trader: its own read 4h range, 1h range → class chop or unclear → pass.'));
  // The documented example (a full long take) satisfies the taught rule: class trend-up, 4h up, 1h up.
  const ex = /9 Manage:[^\n]*\n(STATE: [^\n]+)\n```/.exec(fs.readFileSync(path.join(ROOT, 'skills', 'trader-process', 'SKILL.md'), 'utf8').split('## Examples')[1]);
  const r = S.parseStateLine(ex[1]);
  assert.deepStrictEqual([r.read.frames['4h'], r.read.frames['1h'], r.classWord], ['up', 'up', 'trend-up']);
});

test('class word: one filled-in example in the skills and agents; its class word is not the regime word of its PLAN, it cites no regime, and it agrees with the decision of its PLAN', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const examples = [];
  for (const dir of ['skills', 'agents']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      const file = dir === 'skills' ? path.join(ROOT, dir, f, 'SKILL.md') : path.join(ROOT, dir, f);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      const text = fs.readFileSync(file, 'utf8');
      // Every line (with the fenced block it closes), and every backticked STATE line inside prose (an inline example).
      const lines = text.split('\n').map((line, i, all) => {
        const before = all.slice(0, i);
        const open = before.lastIndexOf('```text');
        return { line, block: open >= 0 && !before.slice(open + 1).some(l => l.startsWith('```')) ? before.slice(open + 1).join('\n') : '' };
      });
      const inline = [...text.replace(/\s+/g, ' ').matchAll(/`(STATE: [^`]+)`/g)].map(m => ({ line: m[1], block: '' }));
      for (const { line, block } of [...lines, ...inline]) {
        const r = S.parseStateLine(line);
        if (r.status === 'read' && r.classWord) examples.push({ file: path.relative(ROOT, file), line, block, r });
      }
    }
  }
  assert.strictEqual(examples.length, 1, examples.map(e => e.line).join('\n'));
  for (const { file, line, block, r } of examples) {
    const where = `${file}: ${line}`;
    // The class word is not the regime label copied: not the PLAN's regime word, not another word on the line, no regime cite.
    const regime = /\bregime ([a-z-]+)/.exec(block);
    assert.ok(regime, `${where}: the example sits in a PLAN with its regime`);
    // The same word in the regime's spelling: chop is a range, trend-up and trend-down are their own regime tags.
    assert.ok(!S.classIsRegime(r.classWord, regime[1]), `${where}: the class word is the regime word`);
    assert.ok(!line.replace(`class ${r.classWord}`, '').includes(r.classWord), `${where}: the class word repeats another word on the line`);
    assert.ok(!r.cites.includes('regime'), `${where}: the example cites the regime label`);
    // The read and the decision agree: a take is on the class word's side; unclear or chop is no full take.
    const side = (/^4 Setup: (long|short)/m.exec(block) || [])[1];
    const take = /^8 Decision: take - full/m.test(block);
    if (take) assert.strictEqual(r.classWord, side === 'long' ? 'trend-up' : 'trend-down', `${where}: a full ${side} take with class ${r.classWord}`);
  }
});

test('class word: classIsRegime reads a class word in the spelling of the regime (chop is range); AS_REGIME covers every class word but unclear with regime words', () => {
  assert.strictEqual(S.classIsRegime('chop', 'range'), true);
  assert.strictEqual(S.classIsRegime('trend-up', 'trend-up'), true);
  assert.strictEqual(S.classIsRegime('trend-down', 'trend-down'), true);
  assert.strictEqual(S.classIsRegime('trend-up', 'range'), false);
  assert.strictEqual(S.classIsRegime('chop', 'trend-up'), false);
  assert.strictEqual(S.classIsRegime('unclear', 'transition'), false);
  assert.strictEqual(S.classIsRegime(null, 'range'), false);
  assert.ok(Object.isFrozen(S.AS_REGIME));
  assert.deepStrictEqual(Object.keys(S.AS_REGIME).sort(), S.CLASS_WORDS.filter(w => w !== 'unclear').sort());
  const { PRIMARY } = require('../../scripts/lib/trading/regime');
  for (const v of Object.values(S.AS_REGIME)) assert.ok(PRIMARY.includes(v), v);
});

test('state read: the module decides nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'lib', 'trading', 'state-read.js'), 'utf8');
  // It reads the briefing and returns a record: no order tool, no write.
  assert.doesNotMatch(src, /writeFileSync|appendFileSync|renameSync|place_order|order_plan|compose_check/);
});

'use strict';

// The head trader's closed-form market-state read (trading/state-read.js): the STATE line it writes once per cycle,
// parsed, and scored field by field against the bar briefing's own labels. A record and a score, never a refusal.

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

test('state line: the canonical line reads into frames, day and agree', () => {
  const r = S.parseStateLine('PLAN:\n1 HTF: 4h up, 1h up, 15m range\nSTATE: 4h up | 1h up | 15m range | day trending | frames disagree\nCYCLE RESULT: no-trade - x');
  assert.strictEqual(r.status, 'read');
  assert.deepStrictEqual(r.read, { frames: { '4h': 'up', '1h': 'up', '15m': 'range' }, day: 'trending', agree: 'no' });
  assert.deepStrictEqual(r.missing, []);
  assert.deepStrictEqual(r.bad, []);
  assert.strictEqual(r.lines, 1);
  assert.deepStrictEqual(S.parseState('STATE: 4h up | 1h up | 15m range | day trending | frames disagree'), r.read);
});

test('state line: case, spacing, markdown marks and separators are tolerated; only the spelling changes', () => {
  const want = { frames: { '4h': 'down', '1h': 'transition', '15m': 'unknown' }, day: 'rotating', agree: 'yes' };
  for (const line of [
    'STATE: 4h down | 1h transition | 15m unknown | day rotating | frames agree',
    '  state:4H Down|1H TRANSITION|15M unknown|Day Rotating|Frames Agree  ',
    '- **STATE:** `4h down; 1h transition; 15m unknown; day rotating; frames agree`',
    '> STATE :  4-hour down ,  1 hour transition , 15-min unknown , day   rotating , agree yes.',
    '| STATE: | 4h down | 1h transition | 15 min unknown | day rotating | agree yes |',
  ]) {
    const r = S.parseStateLine(line);
    assert.strictEqual(r.status, 'read', line);
    assert.deepStrictEqual(r.read, want, line);
    assert.deepStrictEqual(r.bad, [], line);
  }
});

test('state line: a partial line reads what it states and lists what it left out', () => {
  const r = S.parseStateLine('STATE: 4h up | 1h down');
  assert.strictEqual(r.status, 'read');
  assert.deepStrictEqual(r.read, { frames: { '4h': 'up', '1h': 'down' }, day: null, agree: null });
  assert.deepStrictEqual(r.missing, ['15m', 'day', 'frames']);
});

test('state line: an item outside the closed vocabulary is bad, never guessed; free text is no read', () => {
  const r = S.parseStateLine('STATE: 4h up | 1h strongly up | 3m up | day trending | frames agree');
  assert.strictEqual(r.status, 'read');
  assert.deepStrictEqual(r.read.frames, { '4h': 'up' });
  assert.deepStrictEqual(r.bad, ['1h strongly up', '3m up']);
  for (const garbage of ['STATE: the market looks bullish to me', 'STATE:', 'STATE: up up up', 'STATE: 4h bullish | day choppy']) {
    const g = S.parseStateLine(garbage);
    assert.strictEqual(g.status, 'unparsable', garbage);
    assert.strictEqual(g.read, null, garbage);
    assert.strictEqual(S.parseState(garbage), null, garbage);
  }
  // An item is exactly a field and one of its words: a negation, a bracket or a second word hides another claim: bad.
  assert.deepStrictEqual(S.parseStateLine('STATE: 4h not up | 1h up (down) | 1h (up) | 15m up down | day trending').bad, ['4h not up', '1h up (down)', '1h (up)', '15m up down']);
});

test('state line: none, prose that mentions the word, and lines that only look like it are no state line', () => {
  for (const t of ['', null, undefined, 'PLAN:\n1 HTF: 4h up\nCYCLE RESULT: no-trade - x', 'The state: the 4h is up.', 'I will write STATE: next time', 'STATEMENT: 4h up', 'ESTATE: 4h up']) {
    const r = S.parseStateLine(t);
    assert.strictEqual(r.status, 'none', String(t));
    assert.strictEqual(r.read, null);
  }
});

test('state line: the same read twice is one read; two different reads are conflicting, no read; a frame stated twice two ways too', () => {
  const same = S.parseStateLine('STATE: 4h up | 1h up\nnotes\nSTATE: 4H UP | 1h up');
  assert.strictEqual(same.status, 'read');
  assert.strictEqual(same.lines, 2);
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
  assert.deepStrictEqual([s.fields['4h'].result, s.fields['1h'].result, s.fields['15m'].result], ['match', 'mismatch', 'match']);
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
  const none = S.scoreState(S.parseState('STATE: 4h up | day trending | frames agree'), { sections: {} });
  assert.deepStrictEqual(Object.values(none.fields).map(f => f.result), ['unknown', 'unknown', 'unknown']);
  // No briefing: every field unknown, with why.
  const nob = S.scoreState(S.parseState('STATE: 4h up'), null);
  assert.strictEqual(nob.fields['4h'].result, 'unknown');
  // No read: no fields.
  assert.deepStrictEqual(S.scoreState(null, briefing()), { fields: {}, counts: { match: 0, mismatch: 0, unknown: 0 } });
});

test('state score: the day field against the day type so far; before the initial balance it is unknown', () => {
  const cases = [['trend up', 'trending'], ['trend down', 'trending'], ['neutral', 'rotating'], ['inside the initial balance', 'rotating'], ['normal variation up', 'mixed'], ['normal variation down', 'mixed']];
  for (const [dayType, word] of cases) {
    const s = S.scoreState(S.parseState(`STATE: day ${word}`), briefing({ dayType }));
    assert.strictEqual(s.fields.day.result, 'match', dayType);
    assert.strictEqual(s.fields.day.fact, word, dayType);
    assert.strictEqual(s.fields.day.dayType, dayType);
    const other = ['trending', 'rotating', 'mixed'].find(w => w !== word);
    assert.strictEqual(S.scoreState(S.parseState(`STATE: day ${other}`), briefing({ dayType })).fields.day.result, 'mismatch', `${dayType} vs ${other}`);
  }
  for (const dayType of [null, 'something new']) {
    const s = S.scoreState(S.parseState('STATE: day trending'), briefing({ dayType }));
    assert.strictEqual(s.fields.day.result, 'unknown', String(dayType));
  }
  const noToday = briefing();
  delete noToday.sections.m3.data.today;
  assert.match(S.scoreState(S.parseState('STATE: day trending'), noToday).fields.day.why, /no day type/);
  assert.strictEqual(S.scoreState(S.parseState('STATE: day unknown'), briefing({ dayType: 'trend up' })).fields.day.result, 'unknown');
});

test('state score: frames agree from the three labels; an unknown label leaves it unknown unless the known ones already differ', () => {
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

test('state facts: the labels and their context as the code had them, recorded, never scored', () => {
  const f = S.stateFacts(briefing({ h1: 'up', breaks: { h1: 'down', m15: 'up', m3: 'down' } }));
  assert.deepStrictEqual(f, {
    frames: { '4h': 'up', '1h': 'up', '15m': 'up' }, dayType: 'trend up', regime: 'trend-up',
    trendRule: 'Trend rule: LONG allowed (prevailing 4h up); no short against it.', breaks: { '1h': 'down', '15m': 'up', '3m': 'down' },
  });
  assert.strictEqual(S.stateFacts(null), null);
});

test('state vocabulary: one registry entry per field, the parser and the scorer read only it', () => {
  assert.deepStrictEqual(S.REGISTRY.map(e => e.key), ['4h', '1h', '15m', 'day', 'frames']);
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
  const rec = S.cycleStateRead({ home, text: 'STATE: 4h up | 1h up | 15m up | day trending | frames agree', context, now: new Date('2026-03-02T15:03:02Z') });
  assert.strictEqual(rec.status, 'read');
  assert.strictEqual(rec.symbol, 'MNQ');
  assert.strictEqual(rec.bar, '2026-03-02T15:00:00.000Z');
  assert.strictEqual(rec.briefing, null);
  assert.deepStrictEqual(rec.counts, { match: 3, mismatch: 2, unknown: 0 });
  assert.strictEqual(rec.fields['1h'].result, 'mismatch');
  assert.deepStrictEqual(rec.facts.frames, { '4h': 'up', '1h': 'down', '15m': 'up' });
  // No line: recorded as such, with the facts the briefing had.
  const none = S.cycleStateRead({ home, text: 'CYCLE RESULT: no-trade - x', context, now: new Date('2026-03-02T15:03:02Z') });
  assert.deepStrictEqual([none.status, none.read, none.fields, none.counts], ['none', null, {}, { match: 0, mismatch: 0, unknown: 0 }]);
  assert.ok(none.facts);
  // Another bar's briefing: unscored (unknown), why recorded.
  const stale = S.cycleStateRead({ home, text: 'STATE: 4h up', context: { symbols: [{ symbol: 'MNQ', bar: { t: '2026-03-02T15:03:00.000Z' } }] }, now: new Date() });
  assert.match(stale.briefing, /not the cycle's/);
  assert.strictEqual(stale.fields['4h'].result, 'unknown');
  // No symbol, a bad home: never throws.
  assert.strictEqual(S.cycleStateRead({ home, text: 'STATE: 4h up', context: null }).fields['4h'].result, 'unknown');
  const broken = S.cycleStateRead({ home: { not: 'a path' }, text: 'STATE: 4h up', context });
  assert.ok(broken.status === 'read' || broken.error);
  assert.doesNotThrow(() => S.cycleStateRead({ home, text: { toString() { throw new Error('boom'); } }, context }));
  assert.ok(S.cycleStateRead({ home, text: { toString() { throw new Error('boom'); } }, context }).error);
});

test('state line: the trade-session skill documents the grammar the parser reads, in one place, as the head trader\'s own read', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'trade-session', 'SKILL.md'), 'utf8');
  const m = /```text\n(STATE: [^\n]+)\n```/.exec(skill);
  assert.ok(m, 'the grammar line');
  const frameWords = /`<f>`: ((?:`[a-z]+`(?:, | or )?)+)\./.exec(skill);
  assert.ok(frameWords, 'the frame words');
  const words = [...frameWords[1].matchAll(/`([a-z]+)`/g)].map(x => x[1]);
  assert.deepStrictEqual(words, S.FRAME_VALUES);
  const day = /day <([a-z|]+)>/.exec(m[1])[1].split('|');
  assert.deepStrictEqual(day, S.REGISTRY.find(e => e.key === 'day').values);
  // Every filled-in instance of the grammar reads in full.
  for (const f of words) {
    for (const d of day) {
      for (const a of ['agree', 'disagree']) {
        const line = m[1].replace(/<f>/g, f).replace(/day <[^>]+>/, `day ${d}`).replace(/frames <[^>]+>/, `frames ${a}`);
        const r = S.parseStateLine(line);
        assert.deepStrictEqual([r.status, r.missing, r.bad], ['read', [], []], line);
      }
    }
  }
  // The model's own read, not the label copied; recorded, never a step of its own.
  const flat = skill.replace(/\s+/g, ' ');
  assert.ok(flat.includes('your own read of each frame, not its label copied'));
  assert.ok(flat.includes('it is recorded and scored later and changes no step'));
  // One place: no other skill or agent documents the line.
  for (const dir of ['skills', 'agents']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      const file = dir === 'skills' ? path.join(ROOT, dir, f, 'SKILL.md') : path.join(ROOT, dir, f);
      if (!fs.existsSync(file) || f === 'trade-session') continue;
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /^STATE:|`STATE:`/m, file);
    }
  }
});

test('state read: the module decides nothing (no gate, order or runner module requires it)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'lib', 'trading', 'state-read.js'), 'utf8');
  // It reads the briefing and returns a record: no order tool, no write.
  assert.doesNotMatch(src, /writeFileSync|appendFileSync|renameSync|place_order|order_plan|compose_check/);
});

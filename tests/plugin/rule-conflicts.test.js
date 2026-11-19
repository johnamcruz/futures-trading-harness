'use strict';

// The conflict check (the conflict audit, 2026-11-19): an MTF arm's rendered text, the head system prompt and a cycle
// prompt with the mtf-entry skill, holds no unreconciled rule conflict. (1) The precedence paragraph is last in an MTF
// arm and absent in arm D. (2) Sentences that state an arm D refusal are pinned, shrink-only. (3) While a conflicting
// arm D sentence exists, its reconciling text is in the MTF prompt. (4) Term guards on the mtf-entry skill. Scoped to the
// MTF render; arm D text is judged by its own quiz.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const HP = require('../../scripts/lib/head-prompt');
const AT = require('../../scripts/lib/autotrader');
const ME = require('../../scripts/lib/trading/mtf-entry');
const PINS = require('./rule-conflicts.pins.json');

const REPLAY = { isReplay: () => true };
const at = new Date('2026-10-07T14:00:02Z');
const item = { symbol: 'MNQ', bar: { t: '2026-10-07T13:57:00.000Z', c: 21540 }, scan: [] };
const cfg = AT.validateConfig({ harness: 'claude', symbols: ['MNQ'], timeframe: 3 });
const modeOf = arm => ME.modeOf({ arm, exitMode: 'trail', minStage: 'potential' }, {}, REPLAY);
const SKILL = HP.skillBody(ROOT, 'mtf-entry');
const system = HP.claudeHeadText(ROOT);
const cycle = `${AT.prompts({ ...cfg, mtfMode: modeOf('B') }, at, ROOT).trade([item])}\n${SKILL}`;
const allSkills = fs.readdirSync(path.join(ROOT, 'skills')).map(n => HP.skillBody(ROOT, n)).join('\n');
const sentences = t => t.split(/(?<=[.;:])\s+|\n/);
const norm = t => t.replace(/\s+/g, ' ');

test('placement: an MTF arm ends with the precedence paragraph before the result line; arm D has none', () => {
  for (const arm of ['A', 'B', 'AB']) assert.ok(AT.prompts({ ...cfg, mtfMode: modeOf(arm) }, at, ROOT).trade([item]).endsWith(`${AT.MTF_PRECEDENCE}${AT.RESULT_LINE}`), arm);
  const d = AT.prompts(cfg, at, ROOT).trade([item]);
  assert.ok(d.endsWith(AT.RESULT_LINE) && !d.includes(AT.MTF_PRECEDENCE));
  assert.equal(AT.prompts({ ...cfg, mtfMode: modeOf('D') }, at, ROOT).trade([item]), d, 'arm D: byte-identical');
});

test('pins, shrink-only: sentences stating an arm D refusal in the MTF render', () => {
  const P = { NEVER_COUNTER_4H: /never counter/i, CLASS_REFUSAL: /\b(chop|unclear)\b[^.]{0,40}(sit out|no trend trade)/i, TURN_REQUIRED: /wait for the 15m turn/i };
  for (const [k, re] of Object.entries(P)) {
    const got = { system: sentences(system).filter(s => re.test(s)).length, cycle: sentences(cycle).filter(s => re.test(s)).length };
    assert.ok(got.system <= PINS[k].system && got.cycle <= PINS[k].cycle, `${k}: ${JSON.stringify(got)} over the pin ${JSON.stringify(PINS[k])} (a new sentence needs its arm named, or lower the pin)`);
  }
});

test('reconciled pairs: while an arm D rule stands, its reconciling text is in the MTF prompt', () => {
  const PAIRS = [
    { id: 'C1', a: /never counter/i, by: ['Arm D (default) rules are facts here, never refusals', 'never counter'] },
    { id: 'C2', a: /the side is the\s+Bias line's/i, by: ['Side: the 1h structure\'s.', 'For a candidate the side is the 1h structure\'s.'] },
    { id: 'C3', a: /\bchop\b[^.]{0,40}sit out/i, by: ['the class and class table', 'any class rule is arm D\'s'] },
    { id: 'C4', a: /wait for the 15m turn/i, by: ['the Pullback setup and 15m turn', 'the 15m-turn rule and the 3m-trigger rule do not apply'] },
    { id: 'C20', a: /never (enter )?against the 1h/i, by: ['Never enter against the 1h structure; its trend label is context.'] },
    { id: 'C21', a: /\bPOTENTIAL\b[^\n]{0,90}monitor/, by: ['bos-vs-choch\'s stage actions and `Entry:` describe the primary line'] },
  ];
  const mtf = norm(cycle);
  for (const p of PAIRS) {
    if (!p.a.test(`${system}\n${allSkills}`)) continue;
    for (const r of p.by) assert.ok(mtf.includes(norm(r)), `${p.id}: "${r}" missing from the MTF prompt`);
  }
});

test('term guards in the mtf-entry skill: no "stale"; a stage word beside weakening or reversal names the pullback; a ± carries a unit', () => {
  assert.doesNotMatch(SKILL, /\bstale\b/i);
  for (const s of sentences(norm(SKILL)).filter(x => /\b(WEAKENING|REVERSING|CONFIRMED REVERSAL)\b/.test(x) && /\b(weakening|reversal)\b/.test(x))) assert.match(s, /pullback/, s);
  for (const m of SKILL.matchAll(/±\s?\d[\d.]*(\s?\S+)?/g)) assert.match(m[1] || '', /(R|pts|ATR|%|x)/, m[0]);
});

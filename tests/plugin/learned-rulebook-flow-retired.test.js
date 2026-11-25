'use strict';

// docs/LEARNED-RULEBOOK.md: every flow strategy was retired on 2026-10-14 (strategies/retired.json), so R34 and every mention of the
// flow strategies is history, and says so: each paragraph that names R34 or a flow strategy carries a "retired" mark, or sits inside
// R34's own block (its heading says it).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'LEARNED-RULEBOOK.md'), 'utf8');
const RETIRED = require('../../strategies/retired.json');
const NAMES = ['ofi', 'ofi_absorption', 'prop_flow_1m', 'value_area'];

/** The paragraphs (blank-line separated) of `text` that name R34 or a flow strategy but carry no "retired" mark; the R34 block is exempt. */
function unmarked(text) {
  const start = text.indexOf('**R34. Flow strategies in scope**');
  const end = text.indexOf('**R36.');
  const mention = new RegExp(`R34\\b|flow strateg|\`(?:${NAMES.join('|')})\``);
  const out = [];
  let at = 0;
  for (const p of text.split('\n\n')) {
    const i = text.indexOf(p, at);
    at = i + p.length;
    if (i >= start && i < end) continue;
    if (mention.test(p) && !/retired/i.test(p)) out.push(p.trim().slice(0, 80));
  }
  return out;
}

test('the flow strategies named here are retired (strategies/retired.json)', () => {
  for (const n of NAMES) assert.ok(Object.hasOwn(RETIRED, n), n);
});

test('LEARNED-RULEBOOK: every mention of R34 or a flow strategy is marked retired, or sits in R34\'s own block', () => {
  assert.deepStrictEqual(unmarked(DOC), []);
});

test('the check catches an unmarked mention and passes a marked one', () => {
  const block = '**R34. Flow strategies in scope** (retired)\n\n- `ofi`: thresholds\n\n**R36. Open risk**';
  assert.deepStrictEqual(unmarked(`A fix to a flow strategy waits.\n\n${block}`), ['A fix to a flow strategy waits.']);
  assert.deepStrictEqual(unmarked(`A fix to a flow strategy (retired) waits.\n\n${block}`), []);
  assert.deepStrictEqual(unmarked(`The parameters (R34) are set on the tuning half.\n\n${block}`), ['The parameters (R34) are set on the tuning half.']);
  assert.deepStrictEqual(unmarked(`Uses \`value_area\` today.\n\n${block}`), ['Uses `value_area` today.']);
});

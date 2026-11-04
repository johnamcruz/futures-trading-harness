'use strict';

// The prepare-ahead skill (PR C): it teaches the prepare format and the confirm rule the runner's prepare and confirm
// prompts carry (scripts/lib/prepare-ahead.js, PR B2: FORMAT, confirmSuffix). The skill's wording is pinned here, whole
// sentences and each example's verdict, so a change of meaning shows; the last tests tie it to the runner's FORMAT and
// confirm wording (scripts/lib/prepare-ahead.js). It is
// delivered by skill_lookup only (the allow-list of skills-indexed.test.js), on no list, so what moves with prepare ahead
// off is exactly: its index line in the Claude head trader's index-mode file (the head-cycle golden) and its catalog line
// in workspace/AGENTS.md (opencode's and Codex's heads); every other prompt and golden is unchanged.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
const PA = require('../../scripts/lib/prepare-ahead');

const ROOT = path.resolve(__dirname, '..', '..');
const RAW = fs.readFileSync(path.join(ROOT, 'skills', 'prepare-ahead', 'SKILL.md'), 'utf8');
const BODY = RAW.replace(/\s+/g, ' ');

test('prepare-ahead skill: frontmatter, sections, a short description', () => {
  const { data } = parseFrontmatter(RAW);
  assert.strictEqual(data.name, 'prepare-ahead');
  assert.ok(String(data.description).length > 0 && String(data.description).length <= 160, 'description <= 160');
  for (const h of ['## When to Use', '## How It Works', '## Examples']) assert.ok(RAW.includes(h), h);
});

test('prepare-ahead skill: the rule first and bold, the confirm rule as the runner states it', () => {
  assert.ok(/## How It Works\s+\*\*The candle decides: confirm a scenario only if the closed candle meets its TAKE conditions; else pass\.\*\*/.test(RAW));
  // The runner's confirm message (confirmSuffix) and the skill say the same things.
  assert.ok(BODY.includes('The at-close facts decide, never the plan.'));
  assert.ok(BODY.includes('Confirming is compose_check with the reads as the at-close facts give them'));
});

test('prepare-ahead skill: the prepare format is the runner\'s FORMAT, exactly', () => {
  for (const line of [
    'SCENARIO k: <candidate id and its read, from "Possible at the next close"> → TAKE if <conditions on the closing candle> | PASS if <...>; reads: <the compose reads, each in quotes',
    'STAND DOWN if: <account, room, window, news, a level breaking>',
    'INVALID if: <what voids the plan before the close>',
    'End with `PLAN END`',
  ]) assert.ok(BODY.includes(line), line);
  assert.ok(BODY.includes('no compose_check, no order, no role'));
});

test('prepare-ahead skill: the cases (met, unmet, anchoring, opposite, refused side, outside the plan, the plan is no evidence)', () => {
  for (const s of [
    'Closed candle meets the scenario\'s TAKE conditions: confirm.',
    'Closed candle does not meet them: pass, with why in the CYCLE RESULT.',
    'A plan that said take is no reason to take.',
    'a plan that said pass is no reason to pass.',
    'The plan is never evidence',
    'A side the Bias line or the trend rule refuses is no trade, whatever the plan or the candle: pass.',
    'or something fired outside the plan: reason it from the facts, in full',
    'A STAND DOWN or INVALID condition true at the close: pass.',
    'It may be taken or passed;',
    '- The at-close facts decide, never the plan. The plan is never evidence: its reads, numbers and reasons prove nothing.',
    'Confirming is compose_check with the reads as the at-close facts give them (not as the plan wrote them), then as the cycle\'s prompt says.',
    'TAKE and PASS conditions: on the closing candle (its close, body, wick), so the at-close facts can settle them.',
    '- The prompt says "Prepare ahead": you write the plan for the next close, from closed bars only.',
    '- The prompt says "Your plan said: scenario k": the close has come; you confirm or pass.',
    'Reads: the briefing\'s read names, in quotes. Never invent a read.',
  ]) assert.ok(BODY.includes(s), s);
});

test('prepare-ahead skill: each example keeps its verdict', () => {
  for (const s of [
    'SCENARIO 1: P1 "15m rejection at VWAP" → TAKE if the 3m closes back above VWAP with a lower wick | PASS if it closes below VWAP; reads: "15m rejection at VWAP"; why: the level held`. The close is above VWAP with the lower wick: confirm, compose_check with the at-close reads.',
    'Same plan, the close is below VWAP: pass ("closed below VWAP, TAKE not met").',
    'Plan said take scenario 2, the closed candle has no wick and closed inside the range: pass. The plan is not evidence.',
    'Plan said pass scenario 1, the candle meets scenario 3\'s TAKE conditions: judge scenario 3 from the facts; take it if they hold.',
    'Plan listed a long, the Bias line says short only: no trade.',
  ]) assert.ok(BODY.includes(s), s);
});

test('prepare-ahead skill: no line trusts the plan, composes without compose_check, or orders directly', () => {
  for (const bad of [/plan('s)? (reads|is) (evidence|enough)/i, /without compose_check/i, /as planned/i, /place the order/i, /\bplace_order\b/i, /skip (the )?(gate|compose_check)/i, /trust the plan/i]) {
    const m = BODY.match(bad);
    assert.ok(!m, `the skill says: ${m && m[0]}`);
  }
  // Every mention of compose_check confirms through it or forbids it in a prepare.
  for (const m of BODY.matchAll(/[^.]*compose_check[^.]*\./g)) assert.ok(/no compose_check|Confirming is compose_check|compose_check with the at-close reads|then as the cycle|compose_check says otherwise/.test(m[0]), m[0]);
});

test('prepare-ahead skill: its format lines are the runner\'s FORMAT, and its bold rule is the rule the confirm carries', () => {
  assert.ok(Array.isArray(PA.FORMAT) && PA.FORMAT.length === 3);
  for (const line of PA.FORMAT) assert.ok(BODY.includes(line), `the skill lacks the runner's line: ${line}`);
  // The skill's bold rule sentence is in the confirm message and in the shadow confirm prompt, word for word.
  const rule = RAW.match(/## How It Works\s+\*\*(.+?)\*\*/)[1];
  assert.ok(PA.confirmSuffix({ scenario: { k: 1, line: 'L' }, unplanned: [] }).includes(rule), 'confirmSuffix');
  assert.ok(PA.confirmPrompt({ atCloseText: 'F', fired: [], scenario: { k: 1, line: 'L' }, next: { t: 'T', closedAt: 'C' } }).includes(rule), 'confirmPrompt');
  // The three phrases of the runner's confirm wording the skill mirrors.
  const suffix = PA.confirmSuffix({ scenario: { k: 1, line: 'L' }, unplanned: [] });
  const shadow = PA.confirmPrompt({ atCloseText: 'F', fired: [], scenario: { k: 1, line: 'L' }, next: { t: 'T', closedAt: 'C' } });
  assert.ok(suffix.includes('The at-close facts above decide, never the plan'), 'confirmSuffix: never the plan');
  assert.ok(suffix.includes('reads as these facts give them'), 'confirmSuffix: reads as these facts give them');
  assert.ok(shadow.includes('they decide, never the plan'), 'confirmPrompt: they decide, never the plan');
  assert.ok(BODY.includes('The at-close facts decide, never the plan.') && BODY.includes('the reads as the at-close facts give them'));
  // The confirm names no skill and orders no lookup, in any wording (it forks the prepare's session and carries the rule inline).
  for (const [what, text] of [['confirmSuffix', suffix], ['confirmPrompt', shadow]]) assert.ok(!/skill|look[ -]?up|read the|\bload\b/i.test(text.replace('Read-only', '')), `${what} orders no lookup`);
  // Nor does it name the skill in any wording ("Check the prepare-ahead rules first."): the static text carries no skill name.
  for (const [what, text] of [['confirmSuffix', suffix], ['confirmPrompt', shadow]]) assert.ok(!/prepare-ahead/i.test(text), `${what} names the skill`);
  // The runner\'s prepare prompt carries the same lines.
  assert.ok(PA.preparePrompt({ head: 'H', briefingText: 'B', next: { t: 'T', closedAt: 'C' } }).includes(PA.FORMAT.join('\n')));
});

// The sections whole (the reviewed text): a line added to How It Works or to the Examples, or any line changed, fails here until reviewed.
const HOW_IT_WORKS = "## How It Works\n\n**The candle decides: confirm a scenario only if the closed candle meets its TAKE conditions; else pass.**\n\nA side the Bias line or the trend rule refuses is no trade, whatever the plan or the candle: pass.\n\nPrepare (no compose_check, no order, no role this run):\n\n- Write one line per scenario, in this form:\n  `SCENARIO k: <candidate id and its read, from \"Possible at the next close\"> → TAKE if <conditions on the closing candle> | PASS if <...>; reads: <the compose reads, each in quotes, in the briefing's read names>; why: <one line>`.\n- Then `STAND DOWN if: <account, room, window, news, a level breaking>` and `INVALID if: <what voids the plan before the close>`. End with `PLAN END`.\n- Reads: the briefing's read names, in quotes. Never invent a read.\n- TAKE and PASS conditions: on the closing candle (its close, body, wick), so the at-close facts can settle them.\n\nConfirm (the close has come):\n\n- The at-close facts decide, never the plan. The plan is never evidence: its reads, numbers and reasons prove nothing.\n- Closed candle meets the scenario's TAKE conditions: confirm. Confirming is compose_check with the reads as the at-close facts give them (not as the plan wrote them), then as the cycle's prompt says. A met candle is a confirm, not a pass, unless a refused side, a STAND DOWN or INVALID condition, or compose_check says otherwise.\n- Closed candle does not meet them: pass, with why in the CYCLE RESULT. A plan that said take is no reason to take.\n- The candle meets a different listed scenario's TAKE conditions, or something fired outside the plan: reason it from the facts, in full, as a cycle does. It may be taken or passed; a plan that said pass is no reason to pass.\n- A STAND DOWN or INVALID condition true at the close: pass.\n\n";
const EXAMPLES = "## Examples\n\n- Plan: `SCENARIO 1: P1 \"15m rejection at VWAP\" → TAKE if the 3m closes back above VWAP with a lower wick | PASS if it closes below VWAP; reads: \"15m rejection at VWAP\"; why: the level held`. The close is above VWAP with the lower wick: confirm, compose_check with the at-close reads.\n- Same plan, the close is below VWAP: pass (\"closed below VWAP, TAKE not met\").\n- Plan said take scenario 2, the closed candle has no wick and closed inside the range: pass. The plan is not evidence.\n- Plan said pass scenario 1, the candle meets scenario 3's TAKE conditions: judge scenario 3 from the facts; take it if they hold.\n- Plan listed a long, the Bias line says short only: no trade.\n";

test('prepare-ahead skill: How It Works and Examples are pinned whole (an added or changed line fails)', () => {
  assert.strictEqual(RAW.slice(RAW.indexOf('## How It Works'), RAW.indexOf('## Examples')), HOW_IT_WORKS);
  assert.strictEqual(RAW.slice(RAW.indexOf('## Examples')), EXAMPLES);
});

test('prepare-ahead skill: the refused-side rule comes first, right after the bold rule', () => {
  assert.ok(/\*\*\n\nA side the Bias line or the trend rule refuses is no trade, whatever the plan or the candle: pass\.\n\nPrepare/.test(RAW));
  assert.ok(BODY.includes('A met candle is a confirm, not a pass, unless a refused side, a STAND DOWN or INVALID condition, or compose_check says otherwise.') && !/never a pass/.test(BODY), 'a met candle: a confirm unless something refuses; no absolute');
});

const WHEN_TO_USE = "## When to Use\n\n- The prompt says \"Prepare ahead\": you write the plan for the next close, from closed bars only.\n- The prompt says \"Your plan said: scenario k\": the close has come; you confirm or pass.\n\n";

test('prepare-ahead skill: When to Use is pinned whole (an added line fails)', () => {
  assert.strictEqual(RAW.slice(RAW.indexOf('## When to Use'), RAW.indexOf('## How It Works')), WHEN_TO_USE);
});

test('prepare-ahead skill: the met-candle sentence agrees with the refusals (no absolute "never a pass")', () => {
  assert.ok(!/never a pass/i.test(RAW));
  for (const refusal of ['refused side', 'STAND DOWN or INVALID condition', 'compose_check says otherwise']) assert.ok(BODY.includes(refusal), refusal);
});

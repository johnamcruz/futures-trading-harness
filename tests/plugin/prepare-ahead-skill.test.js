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
  assert.ok(BODY.includes('A met TAKE is a confirm: compose_check with the reads as the at-close facts give them'));
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

test('prepare-ahead skill: the cases (met, unmet, anchoring, opposite, refused side, outside the plan, the plan is no evidence, standing)', () => {
  for (const s of [
    "A met TAKE is a confirm: compose_check with the reads as the at-close facts give them (not as the plan wrote them), then as the cycle's prompt says.",
    "compose_check refusing is the pass; so is a STAND DOWN or INVALID condition true at the close.",
    "A pass is the CYCLE RESULT, with why.",
    "a plan that said take is no reason to take, and a plan that said pass is no reason to pass.",
    "- The at-close facts decide, never the plan. The plan is never evidence: its reads, numbers and reasons prove nothing;",
    "A side the Bias line or the trend rule refuses: pass, whatever the plan or the candle.",
    "- Another listed scenario's TAKE met, or something fired outside the plan: reason it from the facts, in full, as a cycle does.",
    "- The prompt says \"Prepare ahead\": you write the plan for the next close, from closed bars only.",
    "- The prompt says \"Your plan said: scenario k\": the close has come; you confirm or pass.",
    "- A standing scenario (its line fires \"whatever its range, volume and close\"): the setup is the reaction the briefing lists; no condition on the closing candle: TAKE if its reads compose at the close | PASS if compose_check refuses it.",
    "- A standing scenario: its TAKE needs nothing of the closing candle, whatever the plan wrote; read that candle as candle-reading does.",
  ]) assert.ok(BODY.includes(s), s);
  // Single responsibility: candle semantics, the trend rule and compose's refusals are their own skills'; the skill points
  // to them and restates none (the bold rule is the confirm message's too, on purpose: the confirm needs no lookup).
  for (const gone of [/its close, body, wick/, /Never invent a/, /TAKE and PASS conditions:/, /judge scenario 3/, /Closed candle meets the scenario's TAKE conditions: confirm\./, /Closed candle does not meet them/, /It may be taken or passed/, /\bdoji\b/, /long-wick|engulfing|acceptance|who took control/i, /never counter/i]) assert.ok(!gone.test(BODY), String(gone));
});

test('prepare-ahead skill: each example keeps its verdict', () => {
  for (const s of [
    "Plan: `SCENARIO 1: P1 \"15m rejected prior vah up\" → TAKE if the 15m closes back above the prior VAH | PASS if it closes below it; reads: \"15m rejected prior vah up\"; why: the level held`. The briefing lists \"15m rejected prior vah up\" at the close: confirm, compose_check with the at-close reads.",
    "Same plan, the 15m closes below the prior VAH: pass (\"TAKE not met\"), though the plan said take: the plan is not evidence.",
    "Standing scenario 2 (\"15m rejected prior poc up\"), whatever the closing 3m: confirm, compose_check with the at-close reads; refused (R:R): pass.",
    "Plan listed a long, the Bias line says short only: no trade.",
  ]) assert.ok(BODY.includes(s), s);
});

test('prepare-ahead skill: no line trusts the plan, composes without compose_check, or orders directly', () => {
  for (const bad of [/plan('s)? (reads|is) (evidence|enough)/i, /without compose_check/i, /as planned/i, /place the order/i, /\bplace_order\b/i, /skip (the )?(gate|compose_check)/i, /trust the plan/i]) {
    const m = BODY.match(bad);
    assert.ok(!m, `the skill says: ${m && m[0]}`);
  }
  // Every mention of compose_check confirms through it or forbids it in a prepare.
  for (const m of BODY.matchAll(/[^.]*compose_check[^.]*\./g)) assert.ok(/no compose_check|A met TAKE is a confirm: compose_check|compose_check with the at-close reads|PASS if compose_check refuses it|compose_check refusing is the pass/.test(m[0]), m[0]);
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
  // A standing scenario: the confirm's line and the skill say the same (the setup the listed reaction, its TAKE needing nothing
  // of the closing candle, compose_check the check), and the line, too, orders no lookup and names no skill.
  const standing = PA.confirmSuffix({ scenario: { k: 2, line: 'L' }, unplanned: [], kind: 'standing' });
  assert.ok(standing.includes('Scenario 2 is a standing setup: the setup is the reaction the briefing lists, its candle already closed, so its TAKE needs nothing of the closing candle; compose_check on the at-close reads is the check.'), standing);
  for (const phrase of ['the setup is the reaction the briefing lists', 'its TAKE needs nothing of the closing candle']) assert.ok(BODY.includes(phrase) && standing.includes(phrase), phrase);
  assert.ok(!/skill|look[ -]?up|read the|\bload\b|prepare-ahead/i.test(standing), 'the standing line orders no lookup, names no skill');
  // Several scenarios matched (PR C3), standing and not mixed, with something outside the plan, in both the confirm and
  // the shadow confirm: still no lookup, no skill named, the bold rule and the "on" phrases kept, and the standing phrases.
  // (The standing one with a computed trigger as next-close.js renders it, so its words are checked too.)
  // The runner's fixed TAKE/PASS for a standing scenario (STANDING_TAKE_PASS) is the skill's own, clause for clause.
  assert.ok(BODY.includes(PA.STANDING_TAKE_PASS.replace('TAKE: ', 'TAKE if ').replace('PASS: ', 'PASS if ')), PA.STANDING_TAKE_PASS);
  const fires = require('../../scripts/lib/trading/next-close').triggerText({ kind: 'standing', tf: '15m', trigger: { at: '2021-05-24T13:48:00.000Z', candle: { t: '2021-05-24T13:30:00.000Z', closedAt: '2021-05-24T13:45:00.000Z' }, until: '2021-05-24T14:00:00.000Z' } }, '3m');
  const matched = [{ scenario: { k: 1, line: 'L' }, kind: 'momentum' }, { scenario: { k: 2, id: 'P2', line: 'L', why: 'w' }, kind: 'standing', candidate: { id: 'P2', kind: 'standing', read: 'r', fires } }, { scenario: { k: 3, line: 'L' }, kind: 'reaction' }];
  const multi = PA.confirmSuffix({ matched, unplanned: ['x'] });
  const multiShadow = PA.confirmPrompt({ atCloseText: 'F', fired: ['x'], matched, next: { t: 'T', closedAt: 'C' } });
  const standingShadow = PA.confirmPrompt({ atCloseText: 'F', fired: [], scenario: { k: 2, line: 'L' }, kind: 'standing', next: { t: 'T', closedAt: 'C' } });
  for (const [what, text] of [['confirmSuffix (several)', multi], ['confirmPrompt (several)', multiShadow], ['confirmPrompt (standing)', standingShadow]]) {
    assert.ok(!/skill|look[ -]?up|read the|\bload\b|prepare-ahead/i.test(text.replace('Read-only', '')), `${what} orders no lookup, names no skill`);
    assert.ok(text.includes(rule), `${what}: the bold rule`);
    for (const phrase of ['the setup is the reaction the briefing lists', 'its TAKE needs nothing of the closing candle']) assert.ok(text.includes(phrase), `${what}: ${phrase}`);
  }
  assert.ok(multi.includes('The at-close facts above decide, never the plan') && multi.includes('reads as these facts give them'));
  assert.ok(multiShadow.includes('they decide, never the plan') && standingShadow.includes('they decide, never the plan'));
  // The runner\'s prepare prompt carries the same lines.
  assert.ok(PA.preparePrompt({ head: 'H', briefingText: 'B', next: { t: 'T', closedAt: 'C' } }).includes(PA.FORMAT.join('\n')));
});

// The sections whole (the reviewed text): a line added to How It Works or to the Examples, or any line changed, fails here until reviewed.
const HOW_IT_WORKS = "## How It Works\n\n**The candle decides: confirm a scenario only if the closed candle meets its TAKE conditions; else pass.**\n\nA side the Bias line or the trend rule refuses: pass, whatever the plan or the candle.\n\nPrepare (no compose_check, no order, no role this run):\n\n- Write one line per scenario, in this form:\n  `SCENARIO k: <candidate id and its read, from \"Possible at the next close\"> → TAKE if <conditions on the closing candle> | PASS if <...>; reads: <the compose reads, each in quotes, in the briefing's read names>; why: <one line>`.\n- Then `STAND DOWN if: <account, room, window, news, a level breaking>` and `INVALID if: <what voids the plan before the close>`. End with `PLAN END`.\n- A standing scenario (its line fires \"whatever its range, volume and close\"): the setup is the reaction the briefing lists; no condition on the closing candle: TAKE if its reads compose at the close | PASS if compose_check refuses it.\n\nConfirm (the close has come):\n\n- The at-close facts decide, never the plan. The plan is never evidence: its reads, numbers and reasons prove nothing; a plan that said take is no reason to take, and a plan that said pass is no reason to pass.\n- A met TAKE is a confirm: compose_check with the reads as the at-close facts give them (not as the plan wrote them), then as the cycle's prompt says. compose_check refusing is the pass; so is a STAND DOWN or INVALID condition true at the close. A pass is the CYCLE RESULT, with why.\n- A standing scenario: its TAKE needs nothing of the closing candle, whatever the plan wrote; read that candle as candle-reading does.\n- Another listed scenario's TAKE met, or something fired outside the plan: reason it from the facts, in full, as a cycle does.\n\n";
const EXAMPLES = "## Examples\n\n- Plan: `SCENARIO 1: P1 \"15m rejected prior vah up\" → TAKE if the 15m closes back above the prior VAH | PASS if it closes below it; reads: \"15m rejected prior vah up\"; why: the level held`. The briefing lists \"15m rejected prior vah up\" at the close: confirm, compose_check with the at-close reads.\n- Same plan, the 15m closes below the prior VAH: pass (\"TAKE not met\"), though the plan said take: the plan is not evidence.\n- Standing scenario 2 (\"15m rejected prior poc up\"), whatever the closing 3m: confirm, compose_check with the at-close reads; refused (R:R): pass.\n- Plan listed a long, the Bias line says short only: no trade.\n";

test('prepare-ahead skill: How It Works and Examples are pinned whole (an added or changed line fails)', () => {
  assert.strictEqual(RAW.slice(RAW.indexOf('## How It Works'), RAW.indexOf('## Examples')), HOW_IT_WORKS);
  assert.strictEqual(RAW.slice(RAW.indexOf('## Examples')), EXAMPLES);
});

test('prepare-ahead skill: the refused-side rule comes first, right after the bold rule', () => {
  assert.ok(/\*\*\n\nA side the Bias line or the trend rule refuses: pass, whatever the plan or the candle\.\n\nPrepare/.test(RAW));
});

const WHEN_TO_USE = "## When to Use\n\n- The prompt says \"Prepare ahead\": you write the plan for the next close, from closed bars only.\n- The prompt says \"Your plan said: scenario k\": the close has come; you confirm or pass.\n\n";

test('prepare-ahead skill: When to Use is pinned whole (an added line fails)', () => {
  assert.strictEqual(RAW.slice(RAW.indexOf('## When to Use'), RAW.indexOf('## How It Works')), WHEN_TO_USE);
});

test('prepare-ahead skill: a met TAKE is a confirm, and the refusals still pass (no absolute "never a pass")', () => {
  assert.ok(!/never a pass/i.test(RAW));
  for (const refusal of ['A side the Bias line or the trend rule refuses: pass', 'compose_check refusing is the pass', 'STAND DOWN or INVALID condition true at the close']) assert.ok(BODY.includes(refusal), refusal);
});

'use strict';

// The prepare-ahead skill (PR C): it teaches the prepare format and the confirm rule the runner's prepare and confirm
// prompts carry (scripts/lib/prepare-ahead.js, PR B2: FORMAT, confirmSuffix). The wording is pinned here, line by line, so
// a change to either side shows. It is delivered by skill_lookup only (the allow-list of skills-indexed.test.js): the
// head prompt, the cycle's prompts and every golden are unchanged with prepare ahead off.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');

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
    'The trend rule and the Bias line still refuse a side whatever the plan said: no trade on a refused side.',
    'or something fired outside the plan: reason it from the facts, in full',
    'A STAND DOWN or INVALID condition true at the close: pass.',
    'It may be taken or passed;',
    'Reads: the briefing\'s read names, in quotes. Never invent a read.',
  ]) assert.ok(BODY.includes(s), s);
});

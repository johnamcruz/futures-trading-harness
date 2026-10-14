'use strict';

// Scenario 2's facts (docs/COMPOSED-ENTRY.md section 8, PR 5) go into the briefing's data; no role prompt and no
// head-trader prompt may grow for them. The skills that teach these reads are edited in place, never longer: each
// stays within its bytes on main before PR 5 (the role prompts as of ca46d38f), and so do the prompts they are embedded in. A PR
// that shrinks one may lower its number here; none may raise it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { headPlan, headPrompt } = require('../../scripts/lib/head-prompt');

const ROOT = path.resolve(__dirname, '..', '..');

// The skills scenario 2's reads are taught in (bytes of SKILL.md, frontmatter included).
const SKILL_MAX = {
  'bar-briefing': 7353,
  'candle-reading': 3518,
  'fair-value-gaps': 3190,
  'bos-vs-choch': 3568,
  'top-down-entry': 2608,
};
// The head trader's own prompt (index mode) and each role's opencode prompt (workspace/opencode.json), in bytes.
const HEAD_MAX = 67313;
const ROLE_MAX = {
  'fth-head-trader': 67313,
  'market-structure-analyst': 43667,
  'news-calendar-analyst': 10523,
  'risk-manager': 74343,
  'strategy-researcher': 25662,
  'trade-executor': 30268,
  'trade-reviewer': 9195,
  'trend-momentum-analyst': 40995,
  'volume-liquidity-analyst': 33580,
};

test('scenario 2: the skills that teach its reads never grow', () => {
  for (const [name, max] of Object.entries(SKILL_MAX)) {
    const bytes = fs.statSync(path.join(ROOT, 'skills', name, 'SKILL.md')).size;
    assert.ok(bytes <= max, `${name}: ${bytes} bytes, over ${max}`);
  }
});

test('scenario 2: the head trader\'s prompt and every role\'s prompt never grow', () => {
  const head = Buffer.byteLength(headPrompt(headPlan(ROOT, 'index')));
  assert.ok(head <= HEAD_MAX, `head trader: ${head} bytes, over ${HEAD_MAX}`);
  const agents = JSON.parse(fs.readFileSync(path.join(ROOT, 'workspace', 'opencode.json'), 'utf8')).agent || {};
  for (const [name, max] of Object.entries(ROLE_MAX)) {
    assert.ok(agents[name], `${name} in workspace/opencode.json`);
    const bytes = Buffer.byteLength(agents[name].prompt || '');
    assert.ok(bytes <= max, `${name}: ${bytes} bytes, over ${max}`);
  }
});

'use strict';

// Every skill is indexed somewhere: a role's lists (role-skills, role-index), the head trader's load list
// (REQUIRED_FOR_ENTRY, trade-session step 0, the autonomous runner's prompts), a command shim, or the reasoned
// allow-list below of skills only a user or a maintenance tool reaches. skill_lookup's catalog
// (scripts/lib/harness-tools/skills.js) lists every skill on demand, so a role's prompt never carries the whole list;
// this keeps each skill reachable from the place that is meant to use it. The catalog and the index lines are the
// skills' descriptions, so each has one, and a short one.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
const { loadRoles } = require('../../scripts/lib/role-skills');
const { REQUIRED_FOR_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
const { prompts, validateConfig } = require('../../scripts/lib/autotrader');

const ROOT = path.resolve(__dirname, '..', '..');
const SKILLS = fs.readdirSync(path.join(ROOT, 'skills')).filter(n => fs.existsSync(path.join(ROOT, 'skills', n, 'SKILL.md'))).sort();
const description = name => String(parseFrontmatter(fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8')).data.description || '').replace(/\s+/g, ' ').trim();

// Skills no role, head-trader load list or command reaches, each with why. An entry another source covers fails.
const ALLOWED = {
  replay: 'the user starts and reads replays (it says so); no trading role or cycle runs one',
  'training-loop': 'the user starts the training loop, as replays; never inside an autonomous cycle',
  'design-self-review': 'the training loop\'s proposer reads it as its prompt (scripts/lib/train/proposer.js); never a trading role',
};

// Descriptions over the limit when the limit came in: each may only shrink, and goes once it fits.
const MAX_DESCRIPTION = 160;
const LONG_DESCRIPTIONS = {
  absorption: 292, 'autonomous-trading': 316, 'breakout-vs-fakeout': 290, 'candle-reading': 309, cisd: 339,
  'confluence-counting': 301, 'design-self-review': 319, 'end-of-day': 307, 'fib-retracement': 338, 'harness-tools': 546,
  invalidation: 249, 'levels-and-reactions': 317, 'liquidity-concepts': 287, 'market-snapshot': 332, 'market-structure': 251,
  'momentum-and-volume': 300, 'mtf-breakout': 357, 'mtf-rejection': 295, 'multi-timeframe-analysis': 592, 'position-sizing': 210,
  premarket: 297, 'prop-challenge-pacing': 471, 'pullback-vs-reversal': 328, replay: 480, 'session-timing': 247,
  'setup-expectancy': 279, 'strategy-authoring': 254, 'strategy-library': 276, 'trade-review': 255, 'trade-session': 278,
  'trading-agent-security': 312, 'training-loop': 481, 'trend-momentum-indicators': 234, 'trend-vs-range': 274,
  'vwap-volume-profile': 324,
};

/** The skills the autonomous runner's prompts name: "the <skill> skill" and the load list before deciding. */
function promptSkills() {
  const out = new Set();
  const now = new Date('2026-10-07T14:30:00Z');
  for (const harness of ['claude', 'codex', 'opencode', 'qwen']) {
    const p = prompts(validateConfig({ harness, premarketAt: '', timeframe: 3, account: '7' }), now, '/r');
    const texts = [p.premarket('MNQ'), p.trade([{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z', c: 1, file: '/b.json', contractId: 'MNQ' } }]), p.eod()];
    for (const t of texts) {
      for (const m of t.matchAll(/\bthe ([a-z0-9-]+) skill\b/g)) out.add(m[1]);
      for (const m of t.matchAll(/\b(?:load|Load the skills|Read the skills) ([a-z0-9-, ]+?) before deciding/g)) {
        for (const s of m[1].split(/,\s*(?:and\s+)?|\s+and\s+/)) out.add(s.trim());
      }
    }
  }
  return out;
}

/** Where each skill is indexed: Map skill -> [source]. */
function coverage() {
  const by = new Map();
  const add = (skill, source) => by.set(skill, [...(by.get(skill) || []), source]);
  for (const r of loadRoles(ROOT)) {
    for (const s of r.skills) add(s, `${r.name} role-skills`);
    for (const s of r.index) add(s, `${r.name} role-index`);
  }
  for (const s of REQUIRED_FOR_ENTRY) add(s, 'REQUIRED_FOR_ENTRY');
  const ts = fs.readFileSync(path.join(ROOT, 'skills', 'trade-session', 'SKILL.md'), 'utf8');
  const step0 = ts.split(/^### 0\. /m)[1];
  assert.ok(step0, 'trade-session has its step 0');
  for (const m of step0.split(/^### /m)[0].matchAll(/`([a-z0-9-]+)`/g)) add(m[1], 'trade-session step 0');
  for (const s of promptSkills()) add(s, 'the runner\'s prompts');
  for (const f of fs.readdirSync(path.join(ROOT, 'commands')).filter(n => n.endsWith('.md'))) {
    for (const m of fs.readFileSync(path.join(ROOT, 'commands', f), 'utf8').matchAll(/Use the `([a-z0-9-]+)` skill/g)) add(m[1], `commands/${f}`);
  }
  return by;
}

test('every skill is indexed: a role\'s lists, the head trader\'s load list, a command, or the allow-list', () => {
  const by = coverage();
  const orphans = SKILLS.filter(s => !by.has(s) && !Object.hasOwn(ALLOWED, s));
  assert.deepStrictEqual(orphans, [], 'add each to the role that needs it (its role-index, so prompts don\'t grow), or allow-list it with a reason');
  for (const s of by.keys()) assert.ok(SKILLS.includes(s), `"${s}" is named as a skill (${by.get(s).join(', ')}) but has no skills/${s}/SKILL.md`);
  // The sources are read, not empty: the head trader's list and the commands are seen.
  for (const s of ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'trader-process', 'autonomous-trading', 'premarket', 'end-of-day']) {
    assert.ok(by.has(s), `${s}: on the head trader's load list`);
  }
  assert.ok((by.get('setup-expectancy') || []).includes('commands/setup-scorecard.md'));
});

test('the allow-list: each entry is a skill, has its reason, and is still needed', () => {
  const by = coverage();
  for (const [skill, reason] of Object.entries(ALLOWED)) {
    assert.ok(SKILLS.includes(skill), `allow-listed "${skill}" is not a skill`);
    assert.ok(typeof reason === 'string' && reason.length >= 20, `${skill}: give the reason`);
    assert.ok(!by.has(skill), `${skill} is indexed (${(by.get(skill) || []).join(', ')}): take it off the allow-list`);
  }
});

test('descriptions: every skill has one, at most 160 characters (the long ones pinned, only shrinking)', () => {
  for (const s of SKILLS) {
    const d = description(s);
    assert.ok(d, `${s}: no description`);
    if (Object.hasOwn(LONG_DESCRIPTIONS, s)) {
      assert.ok(d.length > MAX_DESCRIPTION, `${s}: ${d.length} characters now fits; remove it from LONG_DESCRIPTIONS`);
      assert.ok(d.length <= LONG_DESCRIPTIONS[s], `${s}: ${d.length} characters, over its pinned ${LONG_DESCRIPTIONS[s]}: shorten it`);
    } else {
      assert.ok(d.length <= MAX_DESCRIPTION, `${s}: ${d.length} characters, over ${MAX_DESCRIPTION}`);
    }
  }
  for (const s of Object.keys(LONG_DESCRIPTIONS)) assert.ok(SKILLS.includes(s), `LONG_DESCRIPTIONS names no skill "${s}"`);
});

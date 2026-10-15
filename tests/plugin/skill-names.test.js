'use strict';

// Every skill a skill names in backticks exists: a backticked kebab-case name in a SKILL.md is a skill folder, an
// agent role, a regime tag, an order-gate check or a cycle result word (NOT_SKILLS below). A skill renamed, split or
// retired can't leave a pointer to nothing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SKILLS = fs.readdirSync(path.join(ROOT, 'skills')).filter(n => fs.existsSync(path.join(ROOT, 'skills', n, 'SKILL.md')));
const AGENTS = fs.readdirSync(path.join(ROOT, 'agents')).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
const { TAGS: REGIME_TAGS } = require('../../scripts/lib/trading/regime');
// Order-gate checks and the cycle's result words a skill names in backticks (never a skill).
const NOT_SKILLS = ['mtf-trend', 'order-consistency', 'replay-clock', 'retired-lane', 'trigger-fired', 'no-trade'];

test('every backticked kebab-case name in a skill is a skill (or a role, a regime tag, a gate check, a result word)', () => {
  const known = new Set([...SKILLS, ...AGENTS, ...REGIME_TAGS, ...NOT_SKILLS]);
  const missing = [];
  for (const s of SKILLS) {
    const text = fs.readFileSync(path.join(ROOT, 'skills', s, 'SKILL.md'), 'utf8');
    for (const [, name] of text.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)) if (!known.has(name)) missing.push(`skills/${s}: \`${name}\``);
  }
  assert.deepStrictEqual([...new Set(missing)], []);
});

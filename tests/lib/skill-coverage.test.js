'use strict';

// How every skill reaches the model (scripts/lib/skill-coverage.js): each one classified once; a new skill can't be
// added without deciding how it reaches the model, and no trading skill with a briefing fact is left as a workflow.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../../scripts/lib/skill-coverage');
const SS = require('../../scripts/lib/situational-skills');

const ROOT = path.resolve(__dirname, '..', '..');
const rows = C.classify(ROOT);

test('every skill is classified, exactly once', () => {
  const skills = fs.readdirSync(path.join(ROOT, 'skills')).filter(n => fs.existsSync(path.join(ROOT, 'skills', n, 'SKILL.md'))).sort();
  assert.deepStrictEqual(rows.map(r => r.skill), skills);
  assert.deepStrictEqual(rows.filter(r => !['a', 'b', 'c', 'd', 'e'].includes(r.class)).map(r => r.skill), [], 'unclassified: put it on the load list, in the situational table, on a role, or in WORKFLOW with its reason');
  for (const r of rows.filter(x => x.class === 'b')) assert.ok(SS.STAGES.includes(r.stage) && r.trigger, r.skill);
});

test('the workflow list: each entry a real skill nothing else reaches, with a reason; none a skill the briefing has a read for', () => {
  const byClass = Object.fromEntries(rows.map(r => [r.skill, r.class]));
  for (const [skill, reason] of Object.entries(C.WORKFLOW)) {
    assert.strictEqual(byClass[skill], 'd', `${skill}: in WORKFLOW but reaches the model as ${byClass[skill] || 'nothing (no such skill)'}: take it off the list`);
    assert.ok(typeof reason === 'string' && reason.length > 10, skill);
  }
  // A skill the crosswalk or the standard plan names for a briefing read is a trading skill: never a workflow.
  const { READ_SKILL } = require('../../scripts/lib/learning/curated-moments');
  const briefed = new Set([...Object.values(READ_SKILL).flatMap(o => Object.values(o)), ...Object.values(require('../../scripts/lib/learning/setup-library').SKILL)]);
  assert.deepStrictEqual(rows.filter(r => r.class === 'd' && briefed.has(r.skill)).map(r => r.skill), []);
});

test('the situational table names only fields a built briefing produces, and the CLI prints the table with its counts', () => {
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const B = require('../../scripts/lib/trading/briefing');
  const bars = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
  const m3 = B.buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: bars.slice(0, 400), minutes: 3 }).sections.m3.data;
  for (const e of SS.TABLE) for (const f of e.facts) assert.ok(f === 'account' || f in m3, `${e.id}: ${f}`);
  const text = C.tableText(rows);
  const c = C.counts(rows);
  assert.match(text, new RegExp(`^skills: ${rows.length}; a every-cycle load ${c.a}, b situational embed ${c.b}, c desk role only ${c.c}, d workflow / non-trading ${c.d}, e embedded elsewhere ${c.e}\\n`));
  const r = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'skill-coverage.js')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), text);
});

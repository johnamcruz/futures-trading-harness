'use strict';

/**
 * How every skill reaches the model (the owner: "We need to make sure we use all the skills correctly to provide
 * context to the model"). Each skill under skills/ is exactly one of, first match in this order:
 *
 *   a  load      the head trader's every-cycle load list (autotrader.js cycleLoaded: the gate's composed list and
 *                ALSO_LOAD), or the skill the cycle prompt says to follow (autonomous-trading)
 *   b  embed     a situational embed (situational-skills.js TABLE): its decision stage and trigger fact
 *   e  core      embedded elsewhere: the head prompt's CORE (head-prompt.js, index mode)
 *   c  role      a desk role's role-skills or role-index only (agents/*.md)
 *   d  workflow  a workflow or non-trading skill (end of day, training, the loop, broker and harness operations), with
 *                its reason (WORKFLOW below: a reasoned allow-list, as tests/plugin/skills-indexed.test.js keeps one)
 *
 * tests/lib/skill-coverage.test.js fails on a skill in none, a (d) entry the table or a role uses, or a (d) skill the
 * crosswalk names for a briefing read (learning/curated-moments.js READ_SKILL): a new skill can't be added without
 * deciding how it reaches the model.
 *
 *   WORKFLOW                    { skill: reason }
 *   classify(root)              [{ skill, class, stage?, trigger?, roles?, reason? }], by skill name
 *   counts(rows)                { a, b, c, d, e }
 *   tableText(rows)             the table as text (scripts/skill-coverage.js prints it)
 */

const fs = require('fs');
const path = require('path');

const WORKFLOW = Object.freeze({
  'broker-bar-fields': 'a broker server\'s extra bar fields: a reference for strategy authors and the broker interface',
  'design-self-review': 'the training loop\'s proposer prompt, never shown to the trader',
  'end-of-day': 'the end-of-day cycle\'s own skill: its prompt names it',
  'gate-refusals-skills': 'what a [skills-at-entry] refusal means: read from the refusal itself',
  'kill-switch': 'what a [kill-switch] or account-lock refusal means: read from the refusal itself',
  'lean-cycle': 'the lean cycle mode: the cycle prompt names it when the runner config sets it',
  'live-session-records': 'the live session\'s records: harness operations',
  'order-plan': 'reading order_plan\'s numbers: the trade-executor\'s tool output',
  'premarket': 'the premarket cycle\'s own skill: its prompt names it',
  'prop-evaluator': 'the prop evaluator CLI: a training and analysis tool',
  'replay': 'running a replay: training operations',
  'replay-labels': 'replay labels: training data',
  'replay-resume': 'resuming a replay: training operations',
  'replay-scorecard': 'the replay scorecard: training analysis',
  'runner-lanes': 'the runner\'s lanes: runner configuration',
  'runner-logs': 'the runner\'s logs: operations',
  'strategy-backtest': 'backtesting a strategy: an author\'s skill',
  'timeframe-sources': 'which file or tool holds a timeframe\'s bars: a data reference the briefing makes unneeded in a cycle',
  'training-loop': 'the training loop: training operations',
  'training-verdict': 'the training loop\'s verdicts: training operations',
  'user-commands': 'the user\'s slash commands: interactive use',
});

const list = root => fs.readdirSync(path.join(root, 'skills')).filter(n => fs.existsSync(path.join(root, 'skills', n, 'SKILL.md'))).sort();

function classify(root) {
  const { cycleLoaded } = require('./autotrader');
  const SS = require('./situational-skills');
  const { CORE } = require('./head-prompt');
  const roles = require('./role-skills').loadRoles(root);
  const loaded = new Set([...cycleLoaded({ harness: 'claude' }), 'autonomous-trading']);
  const embeds = new Map();
  for (const e of SS.TABLE) {
    for (const s of e.skills || (e.section ? [SS.SECTIONS[e.section].skill] : [])) if (!embeds.has(s)) embeds.set(s, { stage: e.stage, trigger: `${e.why} (${e.facts.join(', ')})` });
  }
  const byRole = new Map();
  for (const r of roles) for (const s of [...r.skills, ...r.index]) byRole.set(s, [...(byRole.get(s) || []), r.name]);
  return list(root).map(skill => {
    if (loaded.has(skill)) return { skill, class: 'a' };
    if (embeds.has(skill)) return { skill, class: 'b', ...embeds.get(skill) };
    if (CORE.includes(skill)) return { skill, class: 'e' };
    if (byRole.has(skill)) return { skill, class: 'c', roles: byRole.get(skill) };
    if (WORKFLOW[skill]) return { skill, class: 'd', reason: WORKFLOW[skill] };
    return { skill, class: null };
  });
}

const counts = rows => rows.reduce((o, r) => ({ ...o, [r.class || 'none']: (o[r.class || 'none'] || 0) + 1 }), {});

const NAMES = { a: 'every-cycle load', b: 'situational embed', c: 'desk role only', d: 'workflow / non-trading', e: 'embedded elsewhere', none: 'UNCLASSIFIED' };
function tableText(rows) {
  const c = counts(rows);
  const lines = [`skills: ${rows.length}; ${Object.keys(NAMES).filter(k => c[k]).map(k => `${k} ${NAMES[k]} ${c[k]}`).join(', ')}`, ''];
  const width = Math.max(...rows.map(r => r.skill.length));
  for (const r of rows) {
    const what = r.class === 'b' ? `${r.stage}: ${r.trigger}` : r.class === 'c' ? `roles: ${r.roles.join(', ')}` : r.class === 'd' ? r.reason : '';
    lines.push(`${r.class || '-'}  ${r.skill.padEnd(width)} ${what}`.trimEnd());
  }
  return lines.join('\n');
}

module.exports = { WORKFLOW, NAMES, classify, counts, tableText };

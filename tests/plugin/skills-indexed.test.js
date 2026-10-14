'use strict';

// Every skill is indexed somewhere: a role's lists (role-skills, role-index), the head trader's load list
// (REQUIRED_FOR_ENTRY, REQUIRED_AT_ENTRY, trade-session step 0, the autonomous runner's prompts), a command shim, or the reasoned
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
const { REQUIRED_FOR_ENTRY, REQUIRED_AT_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
const { prompts, validateConfig } = require('../../scripts/lib/autotrader');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SKILLS = fs.readdirSync(path.join(ROOT, 'skills')).filter(n => fs.existsSync(path.join(ROOT, 'skills', n, 'SKILL.md'))).sort();
const description = name => String(parseFrontmatter(fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8')).data.description || '').replace(/\s+/g, ' ').trim();

// Skills no role, head-trader load list or command reaches, each with why. An entry another source covers fails.
const ALLOWED = {
  replay: 'the user starts and reads replays (it says so); no trading role or cycle runs one',
  'training-loop': 'the user starts the training loop, as replays; never inside an autonomous cycle',
  'design-self-review': 'the training loop\'s proposer reads it as its prompt (scripts/lib/train/proposer.js); never a trading role',
  // The replay and training loop's pieces (#131): the user runs and reads them, as replay and training-loop.
  'replay-resume': 'resuming a replay is the user\'s (the replay skill points to it); no trading role or cycle runs one',
  'replay-labels': 'replay labels are the user\'s training input (the replay skill points to it); never read in a cycle',
  'replay-scorecard': 'scoring a replay is the user\'s (the replay skill points to it); never read in a cycle',
  'live-session-records': 'the user reads and scores a live day\'s records after it (user-run; the replay skills point to it)',
  'training-verdict': 'why the training loop kept or rejected an edit: the user reads it (the training-loop skill points to it)',
  // User-run and reference-only skills: referenced where they are needed, never loaded on a list (a list would embed or
  // index them in a prompt that doesn't need them every cycle).
  'user-commands': 'the scripts a person runs themselves (its description says so); no role or cycle runs them',
  'prop-evaluator': 'the policy evaluator is the user\'s command (prop-challenge-pacing points to it); no step of a role reads it',
  'strategy-backtest': 'backtests and bar-source comparisons are the user\'s or a maintenance task (strategy-authoring and strategy-rules point to it)',
  'order-plan': 'referenced from the risk manager\'s step 5 and position-sizing when reading order_plan\'s numbers; not loaded every call',
  'kill-switch': 'referenced from autonomous-trading (the head trader reads it every cycle) for a [kill-switch] or [account-lock] refusal; rare, so not loaded',
  'runner-lanes': 'referenced from autonomous-trading and trade-session when the prompt names lanes; not on the load list, so the cycle doesn\'t grow',
  'runner-logs': 'referenced from autonomous-trading when a cycle needs the runner\'s logs; not on the load list, so the cycle doesn\'t grow',
  // The multi-timeframe-analysis split's pieces the core points to (multi-timeframe-analysis-split.test.js keeps them
  // off the structure analyst's lists), and the top-down procedure the structure analyst looks up by name.
  'timeframe-sources': 'without a current briefing: where each timeframe\'s bars come from (multi-timeframe-analysis, trade-session and premarket point to it)',
  'mtf-bias-filter': 'the trend as a rules filter, for writing a strategy (multi-timeframe-analysis points to it); never read in a cycle',
  'top-down-entry': 'referenced, never embedded: the structure analyst\'s setup step names it and looks it up (basics-skills.test.js)',
  // The trade-session split's pieces (trade-session-split.test.js): the head trader reads each when the core's step names
  // it, never on the per-cycle load list (the cycle's load doesn't grow); setup-judgment and trade-plan are indexed by
  // REQUIRED_AT_ENTRY (the gate requires them before an entry).
  'role-round': 'trade-session step 2 points to it for every full cycle (the roles, cached reports, [roles-ran]); not on the load list',
  'lean-cycle': 'trade-session step 2 points to it when the prompt says lean; not on the load list',
  'manage-position': 'trade-session steps 1 and 3 point to it while a position is open; not on the load list',
  'leftover-orders': 'trade-session step 1 points to it when flat with working orders; not on the load list',
  'day-context': 'trade-session step 3 points to it for every decision (the premarket plan, the news, the day so far); not on the load list',
  'entry-outcome': 'trade-session step 6 points to it after an entry is placed; not on the load list',
  'gate-refusals-skills': 'the [skills-at-entry] refusal\'s row; the head trader finds it by its index line (workspace/AGENTS.md) when refused',
};

// Descriptions over the limit when the limit came in (skill-descriptions.pins.json: skill -> its length): each pin
// equals its description's length, may only shrink against the base branch, and goes once the description fits.
const MAX_DESCRIPTION = 160;
const PINS = path.join(__dirname, 'skill-descriptions.pins.json');
const LONG_DESCRIPTIONS = JSON.parse(fs.readFileSync(PINS, 'utf8'));

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
  for (const s of REQUIRED_AT_ENTRY) add(s, 'REQUIRED_AT_ENTRY');
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
      assert.ok(d.length > MAX_DESCRIPTION, `${s}: ${d.length} characters now fits; remove it from skill-descriptions.pins.json`);
      // Exactly its length: a pin follows its description down, so the text can never grow back to an old pin.
      assert.strictEqual(d.length, LONG_DESCRIPTIONS[s], `${s}: ${d.length} characters, pinned at ${LONG_DESCRIPTIONS[s]}: a shorter one lowers its pin to ${d.length}; a longer one is refused`);
    } else {
      assert.ok(d.length <= MAX_DESCRIPTION, `${s}: ${d.length} characters, over ${MAX_DESCRIPTION}`);
    }
  }
  for (const s of Object.keys(LONG_DESCRIPTIONS)) assert.ok(SKILLS.includes(s), `skill-descriptions.pins.json names no skill "${s}"`);
});

/**
 * The pins at `git merge-base HEAD origin/main` (as no-platform-specifics.test.js reads its own). Null only when the
 * base has no skills-indexed test (the change that brings it); throws (fails closed) when the base can't be read,
 * or has the test but not the pins (a rename or a deletion would otherwise switch the check off).
 */
function basePins(ref = 'origin/main') {
  const git = args => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const mb = git(['merge-base', 'HEAD', ref]);
  if (mb.status !== 0) throw new Error(`the base branch can't be read (git merge-base HEAD ${ref}): fetch ${ref} (CI: fetch-depth: 0)`);
  const base = mb.stdout.trim();
  const tree = git(['ls-tree', '-r', '--name-only', base, 'tests/plugin/']);
  if (tree.status !== 0) throw new Error(`the base's tests/plugin/ can't be listed: ${tree.stderr.trim()}`);
  const names = tree.stdout.split('\n');
  if (!names.includes('tests/plugin/skills-indexed.test.js')) return null;
  if (!names.includes('tests/plugin/skill-descriptions.pins.json')) throw new Error(`the base ${base.slice(0, 12)} has the test but no skill-descriptions.pins.json: can't check the pins only shrink`);
  const shown = git(['show', `${base}:tests/plugin/skill-descriptions.pins.json`]);
  if (shown.status !== 0) throw new Error(`the base's pins can't be read: ${shown.stderr.trim()}`);
  return JSON.parse(shown.stdout);
}

/** Problems with the pins against the base's: a skill the base didn't pin, or a pin raised. */
function pinsAgainstBase(pins, base) {
  if (base === null) return [];
  return Object.entries(pins).flatMap(([k, n]) => (!Object.hasOwn(base, k) ? [`${k}: not pinned on the base branch: the pins may only shrink`]
    : !(n <= base[k]) ? [`${k}: pinned at ${n}, over the base's ${base[k]}: the pins may only shrink`] : []));
}

test('the description pins only shrink against the base branch (git merge-base HEAD origin/main); an unreadable base fails closed', () => {
  assert.deepStrictEqual(pinsAgainstBase(LONG_DESCRIPTIONS, basePins()), []);
  assert.deepStrictEqual(pinsAgainstBase({ a: 200 }, null), [], 'the change that brings the pins');
  assert.deepStrictEqual(pinsAgainstBase({ a: 200, b: 170 }, { a: 200, b: 180, c: 300 }), [], 'equal, lower, or gone');
  assert.match(pinsAgainstBase({ a: 201 }, { a: 200 }).join(), /a: pinned at 201, over the base's 200/);
  assert.match(pinsAgainstBase({ a: '999' }, { a: 200 }).join(), /a: pinned at 999/);
  assert.match(pinsAgainstBase({ d: 170 }, { a: 200 }).join(), /d: not pinned on the base branch/);
  assert.throws(() => basePins('no-such-ref-for-this-test'), /the base branch can't be read/);
});

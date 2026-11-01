#!/usr/bin/env node
'use strict';

/**
 * The goal regression's CLI, tier 1 (scripts/lib/eval/goal-check.js; docs/TRAINING.md, "The goal regression"):
 *
 *   node scripts/goal-check.js run [--real]              the metrics against the baseline: the table
 *   node scripts/goal-check.js baseline --write [--real] write the baseline, only when no gated metric is worse than the
 *                                                        current one's (blows not above, the rest not below): it only rises
 *   ... baseline --write --new-fixture --why "<why>"     a first baseline for a new fixture, the change recorded
 *   ... baseline --write --reset --why "<why>"           the owner-approved reset of the same fixture's baseline (lower
 *                                                        allowed, never a blow more), recorded in it: accepted once,
 *                                                        and only when pinned in goal-check's APPROVED_RESETS
 *
 * The committed CI slice by default (tests/fixtures/goal: its baseline committed); --real, the local goal:real fixture
 * (fetched through the replay broker, its baseline under the harness home). Exit 1 on a regression or a refused baseline.
 */

const fs = require('fs');
const path = require('path');
const GC = require('./lib/eval/goal-check');

const ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: goal-check.js run [--real] | baseline --write [--real] [--new-fixture | --reset] --why "<why>"';

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!['run', 'baseline'].includes(cmd)) throw new Error(USAGE);
  const set = GC.fixtureSet(rest.includes('--real') ? 'real' : 'ci');
  if (set.missing) { process.stdout.write(`skipped: ${set.missing}\n`); return 0; }
  const t0 = Date.now();
  const full = GC.evaluate(set.doc, { root: ROOT, env: {}, synth: set.synth });
  const now = GC.summary(full);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const base = fs.existsSync(set.baselineFile) ? JSON.parse(fs.readFileSync(set.baselineFile, 'utf8')) : null;
  const tol = require('./lib/tunables').training().goalRegression.tolerance;
  if (cmd === 'run') {
    if (!base) { process.stdout.write(`no baseline yet (${set.baselineFile}): goal-check.js baseline --write\n${JSON.stringify(now, null, 2)}\n`); return 0; }
    if (base.fixture !== now.fixture) throw new Error(`the baseline is of another fixture (${base.fixture}, the fixture is ${now.fixture}): write a new one with baseline --write --new-fixture --why "<why>"`);
    const rows = GC.compare(base, now, tol);
    const bad = GC.regressions(rows);
    process.stdout.write(`${GC.renderTable(rows)}\n\n${bad.length ? `FAIL: ${bad.length} goal metric(s) worse than main beyond the tolerance` : 'ok: no goal metric worse than main'} (${secs} s)\n`);
    return bad.length ? 1 : 0;
  }
  if (!rest.includes('--write')) throw new Error(USAGE);
  const fresh = rest.includes('--new-fixture');
  const why = rest.includes('--why') && !/^--/.test(rest[rest.indexOf('--why') + 1] || '--') ? rest[rest.indexOf('--why') + 1] : null;
  if (rest.includes('--reset')) {
    if (fresh) throw new Error('--reset keeps the fixture: --new-fixture and --reset don\'t go together');
    const head = require('child_process').spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    const reset = GC.resetBaseline(base, now, { why, at: new Date().toISOString().slice(0, 10), commit: head.status === 0 ? head.stdout.trim() : null });
    const next = { ...reset, writtenBy: 'scripts/goal-check.js baseline --write --reset' };
    fs.writeFileSync(set.baselineFile, `${JSON.stringify(next, null, 2)}\n`);
    process.stdout.write(`${set.baselineFile} reset (${secs} s): ${next.reset.why}\n`);
    return 0;
  }
  if (base && base.fixture !== now.fixture && !(fresh && why && why.trim())) throw new Error('the fixture changed: --new-fixture --why "<why>" writes its first baseline, the change recorded for the review');
  const same = base && base.fixture === now.fixture;
  const change = !same && base ? { fixtureChange: { from: base.fixture, why } } : {};
  // Tier 2's baseline is of the slice alone (its own fixture hash): kept while the slice is the same.
  const tier2 = !same && base && base.tier2 && base.tier2.fixture === set.doc.hash ? { tier2: base.tier2 } : {};
  const next = { ...(same ? base : tier2), ...now, ...change, writtenBy: 'scripts/goal-check.js baseline --write' };
  const problems = GC.riseProblems(base, next, { blowPathList: full.halves.S ? full.halves.S.list : null });
  if (problems.length) throw new Error(`refused: a baseline only rises:\n${problems.join('\n')}`);
  fs.mkdirSync(path.dirname(set.baselineFile), { recursive: true });
  fs.writeFileSync(set.baselineFile, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`${set.baselineFile} written (${secs} s)\n`);
  return 0;
}

try { process.exitCode = main(process.argv.slice(2)); } catch (err) { process.stderr.write(`${err.message}\n`); process.exitCode = 1; }

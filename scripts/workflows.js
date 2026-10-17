#!/usr/bin/env node
'use strict';

/**
 * The workflow documents (workflows/<name>/WORKFLOW.md, orchestrate/workflows.js).
 *
 *   node scripts/workflows.js validate   each workflow, valid or with its problems; exit 1 if any is invalid
 *   node scripts/workflows.js list       each workflow and its phases
 */

const path = require('path');
const { loadWorkflows } = require('./lib/orchestrate/workflows');

const ROOT = path.resolve(__dirname, '..');

function run(argv, { root = ROOT, out = s => process.stdout.write(s) } = {}) {
  const [op] = argv;
  const all = loadWorkflows(root);
  if (op === 'validate') {
    for (const w of all) out(w.valid ? `OK   ${w.name}\n` : `FAIL ${w.name}: ${w.errors.join('; ')}\n`);
    if (!all.length) out('no workflows\n');
    return all.every(w => w.valid) ? 0 : 1;
  }
  if (op === 'list') {
    for (const w of all.filter(x => x.valid)) out(`${w.name}: ${w.workflow.phases.map(p => `${p.name} [${p.parallel.join(', ')}]`).join(' -> ')}\n`);
    return 0;
  }
  out('usage: workflows.js validate | list\n');
  return 2;
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));

module.exports = { run };

#!/usr/bin/env node
/**
 * Regenerate the Codex, Qwen, opencode, and workspace files from agents/, commands/,
 * rules/, and skills/.
 *
 *   node scripts/sync-harness.js          write
 *   node scripts/sync-harness.js --check  exit 1 if anything is stale (CI)
 *
 * FTH_ROLE_SKILLS (index, the default; full on request) picks how opencode's role prompts carry their skills
 * (scripts/lib/role-skills.js). The committed files are index: a checkout set to full is for a paired replay
 * or a run that asks for it, and its --check compares against that mode.
 */

'use strict';

const path = require('path');
const { syncHarness } = require('./lib/harness-sync');
const { modeOf } = require('./lib/role-skills');

const check = process.argv.includes('--check');
const stale = syncHarness(path.resolve(__dirname, '..'), { check, mode: modeOf(process.env) });
if (stale.length === 0) {
  process.stdout.write('harness files are up to date\n');
} else if (check) {
  process.stderr.write(`stale generated files (run node scripts/sync-harness.js):\n${stale.map(s => `  ${s}`).join('\n')}\n`);
  process.exit(1);
} else {
  process.stdout.write(`updated:\n${stale.map(s => `  ${s}`).join('\n')}\n`);
}

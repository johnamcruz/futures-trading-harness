#!/usr/bin/env node
/**
 * Copy rules/trading/*.md into Claude Code's rules folder so they load in
 * every session (plugins can't ship always-on rules).
 *
 *   node scripts/install-rules.js            -> ~/.claude/rules/trading/
 *   node scripts/install-rules.js --project  -> ./.claude/rules/trading/
 *   node scripts/install-rules.js --dest <dir>
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SOURCE = path.resolve(__dirname, '..', 'rules', 'trading');

function resolveDest(argv, { cwd = process.cwd(), home = os.homedir() } = {}) {
  const i = argv.indexOf('--dest');
  if (i !== -1) {
    if (!argv[i + 1]) throw new Error('--dest needs a directory');
    return path.resolve(cwd, argv[i + 1]);
  }
  if (argv.includes('--project')) return path.join(cwd, '.claude', 'rules', 'trading');
  return path.join(home, '.claude', 'rules', 'trading');
}

function installRules(dest, source = SOURCE) {
  fs.mkdirSync(dest, { recursive: true });
  const files = fs.readdirSync(source).filter(f => f.endsWith('.md')).sort();
  for (const f of files) fs.copyFileSync(path.join(source, f), path.join(dest, f));
  return files;
}

if (require.main === module) {
  try {
    const dest = resolveDest(process.argv.slice(2));
    const files = installRules(dest);
    process.stdout.write(`Installed ${files.length} rule files to ${dest}\n`);
  } catch (err) {
    process.stderr.write(`[install-rules] ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { resolveDest, installRules };

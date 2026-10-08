#!/usr/bin/env node
'use strict';

/**
 * Refuse to let credentials into the repository.
 *
 *   node scripts/check-secrets.js            every tracked file (CI)
 *   node scripts/check-secrets.js --staged   what is staged for the next commit (the pre-commit hook)
 *   node scripts/check-secrets.js --install-hook   install that pre-commit hook in .git/hooks
 *
 * Exits 1 with each finding (file, line, why; never the value) when an env
 * file or a credential value is found. See scripts/lib/secret-scan.js.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { scanFiles } = require('./lib/secret-scan');

const ROOT = path.resolve(__dirname, '..');
const git = args => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function installHook() {
  const dir = git(['rev-parse', '--git-path', 'hooks']).trim();
  const hooks = path.resolve(ROOT, dir);
  fs.mkdirSync(hooks, { recursive: true });
  const file = path.join(hooks, 'pre-commit');
  const line = 'node "$(git rev-parse --show-toplevel)/scripts/check-secrets.js" --staged || exit 1';
  const body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '#!/bin/sh\n';
  if (!body.includes('check-secrets.js')) fs.writeFileSync(file, `${body.trimEnd()}\n${line}\n`, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  process.stdout.write(`[check-secrets] pre-commit hook installed: ${file}\n`);
  return 0;
}

function main(argv) {
  if (argv.includes('--install-hook')) return installHook();
  const staged = argv.includes('--staged');
  const files = (staged ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']) : git(['ls-files'])).split('\n').filter(Boolean);
  const read = file => {
    try {
      return staged ? git(['show', `:${file}`]) : fs.readFileSync(path.join(ROOT, file), 'utf8');
    } catch (_err) {
      return null;
    }
  };
  const findings = scanFiles(files, read);
  if (!findings.length) {
    process.stdout.write(`[check-secrets] ${files.length} ${staged ? 'staged' : 'tracked'} file(s): no credentials\n`);
    return 0;
  }
  for (const f of findings) process.stderr.write(`[check-secrets] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.reason}\n`);
  process.stderr.write(`[check-secrets] ${findings.length} finding(s): remove them${staged ? ' from the commit (git restore --staged <file>)' : ''}. Credentials belong in ~/.futures-trading-harness/.env (see .env.example).\n`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));

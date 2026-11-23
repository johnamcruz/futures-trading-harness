#!/usr/bin/env node
'use strict';

/**
 * CI's change scope (scripts/lib/ci-scope.js): `node scripts/ci-scope.js --base <sha>` prints `docs_only=true` or
 * `docs_only=false` (renames are listed as a delete and an add, so a file moved into docs/ still counts; appends it to $GITHUB_OUTPUT), true only when every path changed since the base is a
 * document. It never fails: any doubt prints false, and the workflow runs everything.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const { scopeOf } = require('./lib/ci-scope');

const i = process.argv.indexOf('--base');
const base = i >= 0 ? process.argv[i + 1] : '';
const { docsOnly } = scopeOf(b => execFileSync('git', ['diff', '--name-only', '--no-renames', b, 'HEAD'], { encoding: 'utf8' }), base);
const line = `docs_only=${docsOnly}`;
console.log(line);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);

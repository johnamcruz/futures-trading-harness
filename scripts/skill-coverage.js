#!/usr/bin/env node
'use strict';

/**
 * How every skill reaches the model: the every-cycle load list, a situational embed (its stage and trigger), the head
 * prompt's CORE, a desk role only, or a workflow skill with its reason (scripts/lib/skill-coverage.js).
 *
 *   node scripts/skill-coverage.js      prints the table and its counts; exits 1 when a skill is unclassified
 */

const path = require('path');
const C = require('./lib/skill-coverage');

const rows = C.classify(path.resolve(__dirname, '..'));
process.stdout.write(`${C.tableText(rows)}\n`);
process.exitCode = rows.some(r => !r.class) ? 1 : 0;

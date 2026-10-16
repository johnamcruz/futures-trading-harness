#!/usr/bin/env node
/**
 * Regenerates tests/plugin/no-tunable-literals.pins.json from the scanner (scripts/lib/tunable-pins.js): the per-file
 * literal counts, the mechanics that still match code, the scanner's hash, and `scan` (raised when the scanner changed).
 * The constants list is never added to: a name the scan finds and the list lacks is printed, and goes to config.
 *
 *   node scripts/regen-tunable-pins.js           write the pins file
 *   node scripts/regen-tunable-pins.js --check   write nothing; exit 1 when the file is not what the scanner gives
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { regen } = require('./lib/tunable-pins');

const REPO = path.resolve(__dirname, '..');
const FILE = path.join(REPO, 'tests', 'plugin', 'no-tunable-literals.pins.json');

function main(argv) {
  const check = argv.includes('--check');
  const old = fs.readFileSync(FILE, 'utf8');
  const { pins, notes } = regen(REPO, JSON.parse(old));
  const text = `${JSON.stringify(pins, null, 1)}\n`;
  for (const n of notes) process.stdout.write(`${n}\n`);
  if (text === old) { process.stdout.write('the pins are what the scanner gives\n'); return 0; }
  if (check) { process.stderr.write('the pins differ from the scanner: run node scripts/regen-tunable-pins.js\n'); return 1; }
  fs.writeFileSync(FILE, text);
  process.stdout.write(`wrote ${path.relative(REPO, FILE)}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));

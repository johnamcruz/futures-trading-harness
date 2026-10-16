'use strict';

/**
 * The pins behind tests/plugin/no-tunable-literals.test.js (tests/plugin/no-tunable-literals.pins.json), regenerated from
 * the scanner (tests/plugin/tunable-scan.js) instead of edited by hand.
 *
 *   scanHash(repo)             the sha256 of the scanner's source: pinned as `scanHash` beside `scan`
 *   counts(repo, mechanics)    { constants: {file: [names]}, literals: {file: count} } the scanner counts now
 *   regen(repo, pins)          { pins, notes }: the pins with `literals` set to the counts now, `mechanics` cut to the
 *                              listed forms that still match code (their reasons kept: a new form needs a person's
 *                              reason), `scanHash` set, and `scan` raised by one when the scanner changed since the
 *                              pinned hash (none pinned yet: left as is). `constants` only lose names the code no longer states; a name the code
 *                              states and the list lacks is a note (move it to config), never added.
 *
 * `scan` is the scanner's version: a higher one than the base branch's lets the counts and mechanics start over (the
 * scanner sees more), so the test requires them to equal the scanner's counts now, and requires `scan` to rise whenever
 * the scanner's hash differs from the base's. The constants list is shrink-only and is never reset.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCANNER = path.join('tests', 'plugin', 'tunable-scan.js');
const loadScan = repo => require(path.join(repo, SCANNER));

function scanHash(repo) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, SCANNER), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
}

function counts(repo, mechanics = []) {
  const S = loadScan(repo);
  const constants = {};
  const literals = {};
  for (const f of S.scriptFiles(repo)) {
    const text = fs.readFileSync(path.join(repo, f), 'utf8');
    const names = [...new Set(S.constantsIn(text).map(c => c.name))];
    if (names.length) constants[f] = names.sort();
    const n = S.literalCount(text, { mechanics });
    if (n) literals[f] = n;
  }
  return { constants, literals };
}

function regen(repo, pins) {
  const S = loadScan(repo);
  const notes = [];
  const files = S.scriptFiles(repo).map(f => S.codeOnly(fs.readFileSync(path.join(repo, f), 'utf8')));
  const mechanics = {};
  for (const [form, why] of Object.entries(pins.mechanics || {})) {
    if (files.some(code => new RegExp(form).test(code))) mechanics[form] = why;
    else notes.push(`mechanics: ${form} matches no code: removed`);
  }
  const now = counts(repo, Object.keys(mechanics));
  const constants = {};
  for (const [f, listed] of Object.entries(pins.constants || {})) {
    for (const [name, why] of Object.entries(listed)) {
      if ((now.constants[f] || []).includes(name)) (constants[f] = constants[f] || {})[name] = why;
      else notes.push(`constants: ${f}: ${name} is no longer a literal: removed`);
    }
  }
  for (const [f, names] of Object.entries(now.constants)) {
    for (const n of names) if (!(constants[f] && constants[f][n])) notes.push(`constants: ${f}: ${n} states a numeric literal and is not listed: move it to config (never added here)`);
  }
  const hash = scanHash(repo);
  const scan = Number(pins.scan || 1) + (pins.scanHash === undefined || pins.scanHash === hash ? 0 : 1);
  if (scan !== Number(pins.scan || 1)) notes.push(`scan: the scanner changed: scan ${pins.scan || 1} -> ${scan}`);
  const out = { scan, scanHash: hash, about: pins.about, constants, mechanics, literals: now.literals };
  if (out.about === undefined) delete out.about;
  return { pins: out, notes };
}

module.exports = { scanHash, counts, regen, SCANNER };

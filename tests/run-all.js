#!/usr/bin/env node
'use strict';

// Runs every *.test.js under tests/ with the built-in node:test runner, inside one temporary root
// for the run (tests/temp-root.js): removed when the run ends, kept with KEEP_TEST_TMP=1.
const fs = require('fs');
const path = require('path');
const { runTests } = require('./temp-root');

function collect(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return collect(p);
    return d.name.endsWith('.test.js') ? [p] : [];
  });
}

const files = collect(__dirname).sort();
runTests(files).then(({ status }) => process.exit(status));

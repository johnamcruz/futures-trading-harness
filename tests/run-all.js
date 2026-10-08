#!/usr/bin/env node
'use strict';

// Runs every *.test.js under tests/ with the built-in node:test runner.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function collect(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return collect(p);
    return d.name.endsWith('.test.js') ? [p] : [];
  });
}

const files = collect(__dirname).sort();
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);

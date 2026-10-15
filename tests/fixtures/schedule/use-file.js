'use strict';

// Test only (node --require): the committed config/schedule.json reads as the file FTH_TEST_SCHEDULE_SOURCE names,
// so a child process runs every caller against another schedule (tests/plugin/schedule-callers.test.js). The
// harness itself has no way to swap its schedule but editing the committed file.
const fs = require('fs');
const path = require('path');

const target = path.resolve(__dirname, '..', '..', '..', 'config', 'schedule.json');
const source = process.env.FTH_TEST_SCHEDULE_SOURCE;
const read = fs.readFileSync;
fs.readFileSync = function readFileSync(p, ...rest) {
  if (source && typeof p === 'string' && path.resolve(p) === target) return read.call(fs, source, ...rest);
  return read.call(fs, p, ...rest);
};

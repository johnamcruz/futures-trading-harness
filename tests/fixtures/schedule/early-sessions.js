'use strict';

// Test only: this process reads the committed config/schedule.json with data.sessionsFrom moved back to data.start
// (use-file.js), for tests of the training loop's mechanics on fixture bars that lie inside the committed warm-up
// (tests/fixtures/trend-moves: 2021-05-03..07, before data.sessionsFrom 2021-05-24). Require it first, before
// anything loads the schedule. The warm-up rule itself is tested on the committed schedule (tests/lib/schedule.test.js,
// tests/lib/train-curriculum.test.js).
const fs = require('fs');
const os = require('os');
const path = require('path');

const committed = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'config', 'schedule.json'), 'utf8'));
committed.data.sessionsFrom = committed.data.start;
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fth-early-sessions-')), 'schedule.json');
fs.writeFileSync(file, JSON.stringify(committed));
process.env.FTH_TEST_SCHEDULE_SOURCE = file;
require('./use-file');

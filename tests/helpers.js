'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 2026-10-07 10:00 America/New_York (a Wednesday, outside default no-entry windows). */
const NOW = new Date('2026-10-07T14:00:00Z');
const CONTRACT = 'CON.F.US.MNQ.Z26';

function minutesAgo(n, now = NOW) {
  return new Date(now.getTime() - n * 60000).toISOString();
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fth-test-'));
}

function writeJournal(dir, entries) {
  const file = path.join(dir, 'journal.jsonl');
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  return file;
}

function plan(minAgo = 10, extra = {}) {
  return { ts: minutesAgo(minAgo), kind: 'plan', contractId: CONTRACT, text: 'ORB long above 21500, stop 21480', ...extra };
}

function placed(minAgo, text = 'setup:orb long, stop 21480', success = true) {
  return { ts: minutesAgo(minAgo), kind: 'order_placed', contractId: CONTRACT, text, data: { result: { success } } };
}

function review(minAgo, result) {
  return { ts: minutesAgo(minAgo), kind: 'review', text: `closed ${result}`, tags: [`result:${result}`, 'setup:orb'] };
}

function entryOrder(extra = {}) {
  return {
    accountId: 1,
    contractId: CONTRACT,
    side: 'buy',
    type: 'market',
    size: 1,
    stopLossBracket: { ticks: 40, type: 'stop' },
    rationale: 'setup:orb break above OR high 21500, stop 21480, target 21540, risk $40',
    ...extra,
  };
}

module.exports = { NOW, CONTRACT, minutesAgo, tmpDir, writeJournal, plan, placed, review, entryOrder };

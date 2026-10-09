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

/**
 * A harness home with a multi-timeframe record (mtf-state.js) and a signal
 * record (signal-state.js) for MNQ, so the gate's trend rule and trigger check
 * have a read. Default: every frame up, orb fired long, closed at closedAt.
 */
function trendHome(home = tmpDir(), { biases = { 240: 1, 60: 1, 15: 1 }, closedAt = '2026-10-07T13:57:00.000Z', symbol = 'MNQ', fired = [{ name: 'orb', direction: 'long' }] } = {}) {
  fs.mkdirSync(path.join(home, 'mtf'), { recursive: true });
  fs.writeFileSync(path.join(home, 'mtf', `${symbol}.json`), JSON.stringify({ symbol, asOf: closedAt, closedAt, biases }));
  // And the signal record (signal-state.js): which rules strategies fired on that bar.
  fs.mkdirSync(path.join(home, 'signals'), { recursive: true });
  fs.writeFileSync(path.join(home, 'signals', `${symbol}-3m.json`), JSON.stringify({ symbol, timeframe: '3m', asOf: closedAt, closedAt, candidates: fired }));
  return home;
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
  const o = {
    accountId: 1,
    contractId: CONTRACT,
    side: 'buy',
    type: 'market',
    size: 1,
    stopLossBracket: { ticks: 40, type: 'stop' },
    rationale: 'setup:orb break above OR high 21500, stop 21480, target 21540, risk $40',
    ...extra,
  };
  // Exits and protective stops carry no brackets (the gate refuses them).
  if (/^\s*\[(exit|protect)\]/i.test(o.rationale) && !('stopLossBracket' in extra)) delete o.stopLossBracket;
  return o;
}

module.exports = { NOW, CONTRACT, minutesAgo, tmpDir, trendHome, writeJournal, plan, placed, review, entryOrder };

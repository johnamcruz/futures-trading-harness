'use strict';

/**
 * Fixtures for the training preflight (scripts/lib/learning/preflight.js): one-minute bars from the parity 3m bars
 * (each 3m bar as three 1m bars, closing at its close), moved by whole weeks so that the parity Monday
 * (2026-04-27) lands on the Monday a test's run starts on; and a replay config for such a run.
 */

const fs = require('fs');
const path = require('path');

const PARITY = path.join(__dirname, 'parity', 'NQ-3m.csv');
const PARITY_MONDAY = Date.parse('2026-04-27T00:00:00Z');
const WEEK = 7 * 86400000;

/** Write one-minute bars covering the week of `monday` ('YYYY-MM-DD', a Monday) to `file`; returns the file. */
function writeMinuteBars(file, monday) {
  const shift = Math.round((Date.parse(`${monday}T00:00:00Z`) - PARITY_MONDAY) / WEEK) * WEEK;
  const lines = fs.readFileSync(PARITY, 'utf8').trim().split('\n').slice(1);
  const out = ['datetime,open,high,low,close,volume'];
  for (const line of lines) {
    const [t, o, h, l, c, v] = line.split(',');
    const ms = Date.parse(t.replace(' ', 'T').replace('+00:00', 'Z')) + shift;
    for (let i = 0; i < 3; i += 1) {
      const at = new Date(ms + i * 60000).toISOString().replace('T', ' ').replace('.000Z', '+00:00');
      out.push([at, i ? c : o, h, l, c, Math.round(Number(v) / 3)].join(','));
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${out.join('\n')}\n`);
  return file;
}

/** A runner config whose first lane trades 3m bars, with a 1m data lane (the 5m facts' bars). */
const AUTOTRADER = Object.freeze({
  harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3,
  lanes: [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'data' }],
});

/** A setup-focused practice block (learning/setup-moments.js). */
const PRACTICE = Object.freeze({ mode: 'setup-focus', setupTf: 15, quietSample: 0.15, seed: 1, levels: 'key', reactions: ['rejected', 'broke'] });

module.exports = { writeMinuteBars, AUTOTRADER, PRACTICE, PARITY_MONDAY };

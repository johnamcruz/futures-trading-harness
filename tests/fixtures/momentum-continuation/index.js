'use strict';

/**
 * The momentum_continuation scan's real-bar set: NQ 3m bars (back-adjusted CSV prices) from 2021-04-29 22:00 UTC to
 * the 2021-05-24 10:57 ET bar, the history the trend rule's three-week window reads before the census sessions it pins.
 * Data only:
 *
 *   bars.json.gz   { symbol: 'MNQ', minutes: 3, m3: [[t, o, h, l, c, v]] }
 *   CENSUS         the S2 census's candidates (the owner-approved momentum-continuation census, 2026-10-28) on its last
 *                  five sessions, 2021-05-17 to 2021-05-24: [bar open, side], every one the census flagged there
 *
 *   load()         the bars, normalized (memoized)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { normalizeBars } = require('../../../scripts/lib/trading/indicators');

let cache = null;
function load() {
  if (!cache) {
    const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'bars.json.gz'))).toString());
    cache = normalizeBars(raw.m3.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })));
  }
  return cache;
}

const CENSUS = Object.freeze([
  ['2021-05-17T13:39', 'short'], ['2021-05-17T13:42', 'short'], ['2021-05-17T13:48', 'short'], ['2021-05-17T13:51', 'short'],
  ['2021-05-17T14:00', 'short'], ['2021-05-17T14:06', 'short'], ['2021-05-18T13:36', 'long'], ['2021-05-18T13:45', 'long'],
  ['2021-05-18T13:51', 'long'], ['2021-05-18T15:45', 'long'], ['2021-05-19T13:39', 'short'], ['2021-05-19T13:45', 'short'],
  ['2021-05-19T13:51', 'short'], ['2021-05-19T14:00', 'short'], ['2021-05-20T13:42', 'short'], ['2021-05-20T13:51', 'short'],
  ['2021-05-20T14:00', 'long'], ['2021-05-20T15:24', 'long'], ['2021-05-20T15:27', 'long'], ['2021-05-20T15:39', 'long'],
  ['2021-05-21T13:45', 'long'], ['2021-05-21T13:48', 'long'], ['2021-05-21T13:51', 'long'], ['2021-05-21T13:54', 'long'],
  ['2021-05-21T13:57', 'long'], ['2021-05-21T14:09', 'long'], ['2021-05-21T14:21', 'long'], ['2021-05-21T15:30', 'long'],
  ['2021-05-24T13:36', 'long'], ['2021-05-24T13:39', 'long'], ['2021-05-24T13:48', 'long'], ['2021-05-24T14:00', 'long'],
  ['2021-05-24T14:12', 'long'], ['2021-05-24T14:15', 'long'],
].map(([t, side]) => Object.freeze([`${t}:00.000Z`, side])));

module.exports = { load, CENSUS };

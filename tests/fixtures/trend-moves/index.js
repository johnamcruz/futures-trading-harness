'use strict';

/**
 * The trend-move set (version 1): twelve NY-session trend legs of 0.4% or more on MNQ 3m bars (09:30-12:00 ET, the
 * first four sessions of a stage-2 combine replay, 2021-05-03 to 2021-05-06), kept as a fixed regression and diagnosis
 * set, never a tuning target: no skill, message or code path may name its dates, prices or levels (the scan in
 * tests/e2e/trend-moves-e2e.test.js). Data only, model-neutral:
 *
 *   bars.json.gz   { symbol, minutes, m3: [[t, o, h, l, c, v]], m1: [...] }: the 3m bars the replay served (from its
 *                  first trading day's start, the history its runner had) and the 1m bars over the same span (the
 *                  5m facts are built from them, as the runner's 1m lane did)
 *   legs.json      { version, symbol, legs: [{ id, day, side, start, extreme, from, to, points, moments, plans }] }:
 *                  each leg's start and extreme bars and prices; moments: the decision bars from its start to its
 *                  halfway point, with the entry window, the trend rule for the leg's side and whether a valid plan
 *                  the leg's way existed there (compose-hints.js repairOf from no reads, the window open, the trend rule
 *                  allowing the side); plans: the model's refused compose_check calls the leg's way in that span, from
 *                  two replays (reads and the check's problems as recorded)
 *
 *   load()                  { bars, legs }
 *   briefingAt(barT)        the runner's bar briefing at that 3m bar, rebuilt by buildBriefing from the bars closed by
 *                           its close (memoized)
 * The follow-up for training (PPC) is a census over practice-train with a date split; this set stays the 12 legs.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildBriefing } = require('../../../scripts/lib/trading/briefing');
const { defaultRoundSteps } = require('../../../scripts/lib/trading/round-numbers');

const DIR = __dirname;
let cache = null;

function load() {
  if (cache) return cache;
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, 'bars.json.gz'))).toString());
  const bar = ([t, o, h, l, c, v]) => ({ t, o, h, l, c, v });
  const bars = { symbol: raw.symbol, minutes: raw.minutes, m3: raw.m3.map(bar), m1: raw.m1.map(bar) };
  cache = { bars, legs: JSON.parse(fs.readFileSync(path.join(DIR, 'legs.json'), 'utf8')), briefings: new Map() };
  return cache;
}

function briefingAt(barT) {
  const { bars, briefings } = load();
  if (briefings.has(barT)) return briefings.get(barT);
  const i = bars.m3.findIndex(b => b.t === barT);
  if (i < 0) throw new Error(`no 3m bar at ${barT} in the trend-move set`);
  const close = Date.parse(barT) + bars.minutes * 60000;
  const fine = bars.m1.filter(b => Date.parse(b.t) + 60000 <= close);
  const b = buildBriefing({ symbol: bars.symbol, contractId: bars.symbol, bars: bars.m3.slice(0, i + 1), minutes: bars.minutes, fineBars: fine, roundSteps: defaultRoundSteps(), now: new Date(close) });
  briefings.set(barT, b);
  return b;
}

module.exports = { load, briefingAt };

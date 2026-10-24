'use strict';

/**
 * The trend-leg census (the owner: "we only need 200 but we use the same randomized trend data"): every trend leg of a
 * scan's bars (replay/trend-capture.js legsOf, the capture report's detector) over practice-train, each with its first
 * with-leg setup moment when the scan has one (curated-lists.js labelLegs, legFirsts), in ONE seeded shuffle order
 * stored in the document (its seed recorded), hashed. Built once, in the user's experience folder like the curated
 * documents, never committed. Every consumer draws the next batch in that order: the curated practice build takes
 * batch k (`build --census <doc> --batch <k>`: one hashed list document per batch, old pins untouched), and the
 * learning loop reads batches with a date filter. Outcomes stay in the moments, as in the curated documents: only the
 * choice of practice moments reads them, never a prompt (a run pins its windows alone).
 *
 *   buildCensus(moments, { legs, detector }, { use, seed, sources })   the document: { v, kind, use, seed, detector,
 *                                            legs: n, withMoment: n, order: [{ id, day, side, start, end, points,
 *                                            moment | null }], fingerprint }
 *   batch(doc, k, { from, to, size, withMoment })   the k-th batch (0-based) of `size` (config/replay.json
 *                                            trendCapture.censusBatch) in the census order, of the entries whose session
 *                                            day is in [from, to) (ISO dates; none: all) and, by default, that have a
 *                                            moment: disjoint batches that together cover the pool
 *   writeCensus(dir, doc), readCensus(file)  leg-census-<use>-<fingerprint>.json (the whole fingerprint) (read: its fingerprint checked)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KIND = 'leg-census';

const BATCH = require('../tunables').replay().trendCapture.censusBatch; // config/replay.json
const hashOf = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest('hex');
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

function fingerprintOf(doc) {
  const { fingerprint: _f, builtAt: _b, ...rest } = doc;
  return hashOf(JSON.stringify(rest));
}

/** The census document (see the header): the legs in the seed's shuffle order, each with its first with-leg moment. */
function buildCensus(moments, { legs, detector }, { use, seed, sources = [], now = new Date() } = {}) {
  if (!Number.isSafeInteger(seed)) throw new Error('leg census refused: seed is an integer (the shuffle\'s, recorded)');
  if (!Array.isArray(legs)) throw new Error('leg census refused: legs from the detector (curated-lists.js legsFor)');
  const C = require('./curated-lists');
  const labelled = C.labelLegs((Array.isArray(moments) ? moments : []).filter(m => isObj(m) && m.use === use), legs);
  const first = new Map(C.legFirsts(labelled).map(m => [m.leg.id, m]));
  const order = legs.map(g => {
    const id = `${g.day}|${g.side}|${g.start}`;
    return { id, day: g.day, side: g.side, start: g.start, end: g.end, points: g.points, moment: first.get(id) || null };
  }).sort((a, b) => (hashOf(seed, a.id) < hashOf(seed, b.id) ? -1 : 1));
  const doc = {
    v: 1, kind: KIND, builtAt: now.toISOString(), use, seed, detector, legs: order.length, withMoment: order.filter(x => x.moment).length,
    sources: sources.map(s => ({ file: s.file ? path.basename(s.file) : null, sha256: s.sha256 || null })), order,
  };
  return { ...doc, fingerprint: fingerprintOf(doc) };
}

/** The k-th batch of the census order (see the header). */
function batch(doc, k, { from = null, to = null, size = BATCH, withMoment = true } = {}) {
  if (!isObj(doc) || doc.kind !== KIND || !Array.isArray(doc.order)) throw new Error('not a leg census');
  if (!(Number.isInteger(k) && k >= 0)) throw new Error('batch: a whole number from 0');
  const pool = doc.order.filter(x => (!withMoment || x.moment) && (!from || x.day >= from) && (!to || x.day < to));
  return pool.slice(k * size, (k + 1) * size);
}

function writeCensus(dir, doc) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${KIND}-${doc.use}-${doc.fingerprint}.json`);
  fs.writeFileSync(file, `${JSON.stringify(doc)}\n`);
  return file;
}

function readCensus(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isObj(doc) || doc.kind !== KIND || fingerprintOf(doc) !== doc.fingerprint) throw new Error(`${path.basename(file)}: not a leg census, or changed since it was built (its fingerprint)`);
  return doc;
}

module.exports = { KIND, buildCensus, batch, writeCensus, readCensus };

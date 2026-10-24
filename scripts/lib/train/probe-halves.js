'use strict';

/**
 * The probe round's halves as runs of their own (Propose-Probe-Compose, docs/TRAINING.md): the curated list the probes
 * replay, split by session date into the probe half and the confirm half (screen.js halfOf, the loop's seed), each
 * written as a curated lists document of its own (learning/curated-lists.js: the source's lists and mix, only the half's
 * moments, fingerprinted again, with `half` naming the source and the split). Each side then replays only the half it is
 * judged on: the champion each half once, every edit the probe half only, the combined change the confirm half only. Both
 * sides of a pairing replay the same half document, so they step the same bars; and no edit's run ever holds a confirm
 * moment.
 *
 *   halfDoc(doc, which, seed)                 the source document's half: its lists and mix filtered, fingerprinted
 *   halfReplay({ replay, which, seed, dir, root })   { replay, days, moments, fingerprint }: the probe replay config on
 *                                             the half's document (written under dir), its session dates and moment count
 */

const path = require('path');
const { readLists, writeLists, fingerprintOf } = require('../learning/curated-lists');
const { halfOf } = require('./screen');
const { expandHome } = require('../paths');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

function halfDoc(doc, which, seed) {
  if (!['probe', 'confirm'].includes(which)) throw new Error(`halfDoc: probe or confirm, not ${which}`);
  if (!isObj(doc) || !isObj(doc.lists)) throw new Error('halfDoc: a curated lists document');
  const inHalf = m => isObj(m) && typeof m.day === 'string' && halfOf(m.day, seed) === which;
  const lists = Object.fromEntries(Object.entries(doc.lists).map(([name, ms]) => [name, (ms || []).filter(inHalf)]));
  const kept = new Set(Object.values(lists).flat().map(m => m.id));
  const { fingerprint: _f, builtAt: _b, ...rest } = doc;
  const out = { ...rest, lists, mix: (doc.mix || []).filter(id => kept.has(id)), half: { of: doc.fingerprint, which, seed, by: 'session date' } };
  return { ...out, builtAt: doc.builtAt, fingerprint: fingerprintOf(out) };
}

/** The moments a run of the list replays: the mix's, or one list's. */
function picked(doc, list) {
  if (list !== 'mix') return doc.lists[list] || [];
  const ids = new Set(doc.mix || []);
  return Object.values(doc.lists).flat().filter(m => ids.has(m.id));
}

function halfReplay({ replay, which, seed, dir, root = process.cwd() }) {
  const cl = replay && replay.curatedList;
  if (!isObj(cl) || typeof cl.file !== 'string') throw new Error('probe.replay.curatedList: the curated practice list the probes replay');
  const file = path.resolve(root, expandHome(cl.file));
  const doc = halfDoc(readLists(file), which, seed);
  const list = cl.list === undefined ? 'mix' : cl.list;
  const moments = picked(doc, list);
  const days = [...new Set(moments.map(m => m.day))].sort();
  // A half with no moments is never written (a curated run refuses an empty list): the round is inconclusive.
  const out = moments.length ? writeLists(dir, doc) : null;
  return { replay: out ? { ...replay, curatedList: { ...cl, file: out } } : null, days, moments: moments.length, fingerprint: doc.fingerprint };
}

module.exports = { halfDoc, halfReplay };

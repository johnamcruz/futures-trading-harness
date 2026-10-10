'use strict';

/**
 * Order calls whose outcome isn't known yet, kept on disk so the knowledge
 * outlives the process that sent them. The gateway writes a marker before it
 * forwards a place_order and removes it when the broker answers. A marker that
 * is still there means the broker may hold an order nobody was told about: the
 * reply timed out, or the gateway (a new one starts with every agent cycle)
 * exited first.
 *
 * Each place_order goes out with a customTag (the client's, or one the gateway
 * adds: the interface's tag is unique per account), so a marker is resolved
 * from the broker's own order list: an order carrying the tag means it was
 * placed; none after the grace period means it never was.
 *
 * One file per marker (<FTH_HOME>/pending-orders/<tag>.json): the gateways of
 * the runner and of each agent cycle share the directory and never rewrite
 * each other's markers.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { harnessHome } = require('../paths');

const TAG = /^[A-Za-z0-9_.:-]{1,100}$/;
const GRACE_MS = 120000;

const markerDir = env => path.join(harnessHome(env), 'pending-orders');
const fileFor = (env, tag) => path.join(markerDir(env), `${encodeURIComponent(tag)}.json`);

/** A fresh tag for an order the client sent without one. */
function newTag() {
  return `fth-${crypto.randomBytes(8).toString('hex')}`;
}

/** The tag a place_order goes out with: the client's own when it gave a usable one. */
function tagFor(args) {
  const own = args && typeof args.customTag === 'string' ? args.customTag : '';
  return TAG.test(own) ? own : newTag();
}

function writeMarker(env, marker) {
  const dir = markerDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const file = fileFor(env, marker.tag);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(marker)}\n`);
  fs.renameSync(tmp, file);
}

function removeMarker(env, tag) {
  try {
    fs.unlinkSync(fileFor(env, tag));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Every marker on disk. One that can't be read comes back as
 * { tag, file, unreadable: true }: it may be any order on any account, so
 * entries stay blocked until someone looks at it.
 */
function readMarkers(env) {
  let names;
  try {
    names = fs.readdirSync(markerDir(env));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names.filter(n => n.endsWith('.json'))) {
    const file = path.join(markerDir(env), name);
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!m || typeof m.tag !== 'string' || !Number.isFinite(Date.parse(m.sentAt))) throw new Error('malformed');
      out.push({ ...m, file });
    } catch (err) {
      if (err.code === 'ENOENT') continue; // resolved by another gateway meanwhile
      out.push({ tag: decodeURIComponent(name.slice(0, -5)), file, unreadable: true });
    }
  }
  return out;
}

/** Markers that concern an account (unreadable ones concern every account). */
function markersFor(markers, accountId) {
  return markers.filter(m => m.unreadable || String(m.accountId) === String(accountId));
}

/**
 * Sort markers by what the broker's orders (search_orders) say:
 * placed (an order carries the tag), gone (none does, and the grace period
 * has passed since it was sent), or still unknown.
 */
function resolveMarkers(markers, orders, now, graceMs = GRACE_MS) {
  const byTag = new Map((Array.isArray(orders) ? orders : []).filter(o => o && o.customTag).map(o => [String(o.customTag), o]));
  const placed = [];
  const gone = [];
  const unknown = [];
  for (const m of markers) {
    if (m.unreadable) unknown.push(m);
    else if (byTag.has(m.tag)) placed.push({ marker: m, order: byTag.get(m.tag) });
    else if (now.getTime() - Date.parse(m.sentAt) >= graceMs) gone.push(m);
    else unknown.push(m);
  }
  return { placed, gone, unknown };
}

/**
 * Ledger entries (see account-gate pendingState) for markers whose order may
 * still change the position: an exit or a stop checks against the account as
 * it would be if they filled, so two of them can't flip it.
 */
function markerLedger(markers, now) {
  return markers
    .filter(m => !m.unreadable && Number.isFinite(m.observedNet) && Number(m.size) > 0)
    .map(m => ({
      contractId: m.contractId, sign: String(m.side).toLowerCase() === 'buy' ? 1 : -1, size: Number(m.size),
      netBefore: m.observedNet, rootNetBefore: Number.isFinite(m.observedRootNet) ? m.observedRootNet : m.observedNet, at: now.getTime(), orderId: null,
    }));
}

/** The order-pending message for markers still unknown. */
function pendingMessage(unknown, now, graceMs = GRACE_MS) {
  const parts = unknown.map(m => (m.unreadable
    ? `an unreadable record ${m.file} (check the broker's orders, then delete it)`
    : `${m.side || ''} ${m.size || ''} ${m.contractId || ''} sent ${Math.round((now.getTime() - Date.parse(m.sentAt)) / 1000)} s ago (customTag ${m.tag})`.replace(/\s+/g, ' ').trim()));
  return `The outcome of ${parts.length === 1 ? 'an order' : `${parts.length} orders`} is unknown: ${parts.join('; ')}. `
    + 'The broker may hold a position or a working order this account check can\'t see yet. New entries wait until the order shows in '
    + `the broker's orders, or ${Math.round(graceMs / 60000)} min pass without it. Exits, stop moves and cancels still go through.`;
}

module.exports = { GRACE_MS, markerDir, newTag, tagFor, writeMarker, removeMarker, readMarkers, markersFor, resolveMarkers, markerLedger, pendingMessage };

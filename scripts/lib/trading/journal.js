'use strict';

/**
 * Read-only access to the broker MCP server's trading journal (JSONL), at the
 * path in the broker config (broker/config.js). The server is the only
 * writer; hooks only read it.
 */

const fs = require('fs');

const MAX_TAIL_BYTES = 8 * 1024 * 1024;

function resolveJournalPath(env = process.env) {
  return require('../broker/config').activeBroker(env).journalPath;
}

/**
 * Read the newest entries. Large journals are tailed so a hook stays fast;
 * the first (possibly partial) line of a tail is dropped. Malformed lines are skipped.
 * A missing journal returns []. Other read errors throw so callers can fail closed.
 */
function readJournal(journalPath, opts = {}) {
  return readJournalWindow(journalPath, opts).entries;
}

/** Like readJournal, plus `truncated: true` when older bytes were skipped. */
function readJournalWindow(journalPath, { maxBytes = MAX_TAIL_BYTES } = {}) {
  let fd;
  try {
    fd = fs.openSync(journalPath, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return { entries: [], truncated: false };
    throw err;
  }
  try {
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    let lines = buffer.toString('utf8').split('\n');
    if (length < size) lines = lines.slice(1);
    const entries = lines.filter(Boolean).flatMap(line => {
      try {
        const entry = JSON.parse(line);
        return entry && typeof entry === 'object' && typeof entry.kind === 'string' ? [entry] : [];
      } catch (_err) {
        return [];
      }
    });
    return { entries, truncated: length < size };
  } finally {
    fs.closeSync(fd);
  }
}

function entryTime(entry) {
  const t = Date.parse(entry && entry.ts);
  return Number.isFinite(t) ? t : NaN;
}

function entriesSince(entries, since) {
  const cutoff = since.getTime();
  return entries.filter(e => entryTime(e) >= cutoff);
}

function hasTag(entry, tag) {
  return Array.isArray(entry.tags) && entry.tags.some(t => String(t).toLowerCase() === tag);
}

/** Result of a review entry from its `result:*` tag: 'win' | 'loss' | 'scratch' | null. */
function reviewResult(entry) {
  if (entry.kind !== 'review') return null;
  for (const r of ['loss', 'win', 'scratch']) {
    if (hasTag(entry, `result:${r}`)) return r;
  }
  return null;
}

/**
 * The root of a contract: from a standard name (MNQ, NQ:2026-03 -> NQ); for a
 * broker id the server itself wrote (its journal entries), from the contract
 * translator's lookups for the selected broker (local file, no lookup).
 * Anything else comes back upper-cased, so it matches no strategy's instruments.
 */
function contractRoot(contractId) {
  const { parseStandardName, standardRoot } = require('../broker/translator');
  const std = parseStandardName(contractId);
  if (std) return std.root;
  try {
    const { activeBroker, contractsCacheFile } = require('../broker/config');
    const root = standardRoot(contractId, contractsCacheFile(activeBroker(process.env).name, process.env));
    if (root) return root;
  } catch (_err) {
    // no broker config: no translator lookups to read
  }
  return String(contractId || '').toUpperCase();
}

/**
 * True when an entry's contract may be on `root`: its root is `root`, or it is
 * a broker id the translator's lookups don't name (an empty cache, another
 * harness home, entries from before the translator). Gate counts that must not
 * miss an entry (entries without a review, a used verdict) use this, so an id
 * they can't name counts against every root: they fail closed.
 */
function mayBeRoot(contractId, root) {
  if (!contractId) return true;
  const r = contractRoot(contractId);
  if (r === root) return true;
  const { parseStandardName } = require('../broker/translator');
  return !parseStandardName(contractId) && r === String(contractId).toUpperCase();
}

/** The month part of a standard name ('2026-03'), or '' for the front month. */
function contractMonthTag(contractId) {
  const std = require('../broker/translator').parseStandardName(contractId);
  return std && std.month ? std.month : '';
}

module.exports = {
  resolveJournalPath,
  readJournal,
  readJournalWindow,
  entryTime,
  entriesSince,
  hasTag,
  reviewResult,
  contractRoot,
  mayBeRoot,
  contractMonthTag,
};

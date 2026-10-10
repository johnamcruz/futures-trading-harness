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

// The translator's lookups for the selected broker, re-read only when the file changes.
let named = { file: null, mtimeMs: -1, cache: null };
function translatorCache() {
  const fs = require('fs');
  const { activeBroker, contractsCacheFile } = require('../broker/config');
  const file = contractsCacheFile(activeBroker(process.env).name, process.env);
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (_err) {
    mtimeMs = 0;
  }
  if (named.file !== file || named.mtimeMs !== mtimeMs) named = { file, mtimeMs, cache: require('../broker/translator').readCache(file) };
  return named.cache;
}

/**
 * { root, named } for a contract id. A broker id the translator has looked up
 * (the server's own journal entries) takes its root from those lookups, first:
 * a broker's ids may look like names (MNQZ5). Else a standard name (MNQ,
 * NQ:2026-03 -> NQ). Else the id upper-cased with named false: nothing knows
 * its contract.
 */
function resolveContract(contractId) {
  const id = String(contractId || '');
  try {
    const known = translatorCache().ids[id];
    if (known) return { root: known.root, named: true };
  } catch (_err) {
    // no broker config: no translator lookups to read
  }
  const std = require('../broker/translator').parseStandardName(id);
  if (std) return { root: std.root, named: true };
  return { root: id.toUpperCase(), named: false };
}

/** The root of a contract (see resolveContract); an unnamed id comes back upper-cased, matching no strategy's instruments. */
function contractRoot(contractId) {
  return resolveContract(contractId).root;
}

/**
 * True when an entry's contract may be on `root`: its root is `root`, or it is
 * a broker id nothing names (an empty translator cache, another harness home,
 * entries from before the translator). Gate counts that must not miss an entry
 * (entries without a review, a used verdict) use this, so an id they can't
 * name counts on every root: they fail closed. A review under such an id
 * counts on every root too, so reviewing the entry as journal_read shows it
 * clears it.
 */
function mayBeRoot(contractId, root) {
  if (!contractId) return true;
  const c = resolveContract(contractId);
  return !c.named || c.root === root;
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

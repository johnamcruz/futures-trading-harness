'use strict';

/**
 * Read-only access to the projectx-mcp trading journal (JSONL).
 * The MCP server is the only writer; hooks only read it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { backtestMode, harnessHome } = require('../paths');

const DEFAULT_JOURNAL_PATH = path.join(os.homedir(), '.projectx-mcp', 'journal.jsonl');
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveJournalPath(env = process.env) {
  // A backtest keeps its journal with the rest of its isolated state; the
  // gateway points projectx-mcp at the same file.
  if (backtestMode(env)) return path.join(harnessHome(env), 'journal.jsonl');
  const configured = String(env.PROJECTX_JOURNAL_PATH || '').trim();
  return configured ? expandHome(configured) : DEFAULT_JOURNAL_PATH;
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
 * Root symbol from a ProjectX contract id: CON.F.US.MNQ.Z25 -> MNQ.
 * Returns the input upper-cased when it doesn't look like a contract id.
 */
function contractRoot(contractId) {
  const parts = String(contractId || '').split('.');
  return (parts.length >= 5 ? parts[parts.length - 2] : String(contractId || '')).toUpperCase();
}

module.exports = {
  DEFAULT_JOURNAL_PATH,
  resolveJournalPath,
  readJournal,
  readJournalWindow,
  entryTime,
  entriesSince,
  hasTag,
  reviewResult,
  contractRoot,
};

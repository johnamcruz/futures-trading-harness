'use strict';

/**
 * What a change touches, for CI: a change to documents only (Markdown under docs/, README.md and
 * CONTRIBUTING.md) skips the goal regression's tier 2 (the live path played with the mock policy, which reads
 * no document), while the tests, lint, sync check, strategies and secrets still run on every change. Anything
 * else, nothing, or any doubt (no base, a git error) is not docs only: the full run is the safe side.
 */

const DOCUMENT = /^(?:docs\/[^\s]+\.md|README\.md|CONTRIBUTING\.md)$/;

/** True only for a non-empty list in which every path is a document . */
function docsOnly(files) {
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every(f => typeof f === 'string' && DOCUMENT.test(f));
}

const NO_BASE = /^0*$/;

/** The scope of base..HEAD: `diff(base)` returns the changed paths, one per line. Never throws. */
function scopeOf(diff, base) {
  if (typeof base !== 'string' || NO_BASE.test(base)) return { docsOnly: false, files: [] };
  try {
    const files = String(diff(base)).split('\n').map(s => s.trim()).filter(Boolean);
    return { docsOnly: docsOnly(files), files };
  } catch (e) {
    return { docsOnly: false, files: [] };
  }
}

module.exports = { docsOnly, scopeOf };

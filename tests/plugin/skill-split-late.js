'use strict';

// Edits made to a split's homes after the split, applied to its allow-list (tests/plugin/*-split.test.js and the
// rename and retire tests that compare a frozen fixture with today's skills). A late edit { from, to, reason } says a
// unit of today's skill (`from`: an old unit kept byte for byte, or an allow-list entry's `now`) was changed to `to`
// (a unit, a list of units, or null: dropped), and why. The coverage test then holds the skill to the edited text:
// the old unit, or the entry it came through, must now be `to`, exactly. A late edit whose `from` is in neither the
// old units nor any entry's `now` is stale and fails, so the list only shrinks.

/**
 * The allow-list with the late edits applied: entries whose `now` a late edit names get its `to`; an old unit a late
 * edit names that had no entry gets one. Returns { allowed, stale } (stale: the late edits that matched nothing).
 */
function withLate(allowed, late, beforeUnits) {
  const out = allowed.map(a => ({ ...a }));
  const used = new Set();
  const apply = (a, l) => {
    used.add(l);
    if (l.to === null) { delete a.now; a.copies = 0; } else a.now = l.to;
    a.reason = `${a.reason}; then ${l.reason}`;
  };
  for (const l of late) {
    for (const a of out) {
      const nows = [a.now || []].flat();
      const k = nows.indexOf(l.from);
      if (k < 0) continue;
      if (nows.length === 1) apply(a, l);
      else {
        used.add(l);
        const next = [...nows.slice(0, k), ...(l.to === null ? [] : [l.to].flat()), ...nows.slice(k + 1)];
        a.now = next;
        a.reason = `${a.reason}; then ${l.reason}`;
      }
    }
    if (!used.has(l) && beforeUnits.includes(l.from) && !out.some(a => a.old === l.from)) {
      const a = { old: l.from, reason: 'kept until' };
      apply(a, l);
      out.push(a);
    }
  }
  return { allowed: out, stale: late.filter(l => !used.has(l)) };
}

module.exports = { withLate };

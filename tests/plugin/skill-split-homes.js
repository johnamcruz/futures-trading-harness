'use strict';

// A skill split's home check (tests/plugin/*-split.test.js): each new home holds exactly the old skill's units in its
// own ranges (inclusive indexes into the old skill's units), so a unit can't move to another home unnoticed; and the
// ranges cover every old unit once. Also the frozen fixture of a skill whose lines the platform scan pins: those lines
// can't be copied into a fixture (tests/plugin/no-platform-specifics.test.js), so the fixture holds a marker for each
// and the old text is rebuilt from the lines as the skill still has them, then pinned whole by its sha256.

const crypto = require('crypto');
const { units, count, STRUCTURE } = require('./skill-split');
const S = require('./platform-scan');

const MARKER = '[a line the platform scan pins: kept verbatim in the skill itself]';

/** A line the platform scan would report: a firm, account, platform or model name, or a firm's time. */
const pinnedLine = line => {
  const n = S.normalize(line);
  return S.FORBIDDEN.test(n) || S.MODEL_SIZE.test(n) || S.FIRM_TIME.test(n);
};

/**
 * The old skill, rebuilt: each marker in `fixture` replaced, in order, by the next pinned line of `skillText`. Throws
 * when the counts differ; the caller pins the result's sha256, so a pinned line changed or reordered fails there.
 */
function rebuild(fixture, skillText) {
  const pinned = skillText.split('\n').filter(pinnedLine);
  const markers = fixture.split('\n').filter(l => l === MARKER).length;
  if (pinned.length !== markers) throw new Error(`${markers} markers, ${pinned.length} pinned lines in the skill`);
  let i = 0;
  return fixture.split('\n').map(l => (l === MARKER ? pinned[i++] : l)).join('\n');
}

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

/**
 * Units in the wrong home: `ranges` maps each home (named by `names`) to its [first, last] old unit indexes. Every old
 * unit is in exactly one range; each home's units that came from the old skill (an allow-list entry's `now` standing in
 * for its `old`) are exactly the units of its ranges, as a multiset. Units the allow-list gives `copies` are left to
 * the coverage check. [] when every unit is in its own home.
 */
function homeErrors(beforeText, homeTexts, names, ranges, allowed = []) {
  const old = units(beforeText);
  const bad = [];
  const owner = new Array(old.length).fill(-1);
  names.forEach((n, h) => {
    for (const [a, b] of ranges[n] || []) {
      if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && a <= b && b < old.length)) { bad.push(`${n}: bad range [${a}, ${b}]`); continue; }
      for (let i = a; i <= b; i += 1) {
        if (owner[i] >= 0) bad.push(`unit ${i} in the ranges of ${names[owner[i]]} and ${n}`);
        owner[i] = h;
      }
    }
  });
  owner.forEach((h, i) => { if (h < 0) bad.push(`unit ${i} in no home's range: ${JSON.stringify(old[i])}`); });
  const nowToOld = new Map(allowed.flatMap(a => [a.now || []].flat().map(x => [x, a.old])));
  const skip = new Set([...STRUCTURE, ...allowed.filter(a => a.copies !== undefined).map(a => a.old)]);
  const oldSet = new Set(old);
  homeTexts.forEach((text, h) => {
    const want = count(old.filter((u, i) => owner[i] === h && !skip.has(u)));
    const got = count(units(text).map(u => nowToOld.get(u) || u).filter(u => oldSet.has(u) && !skip.has(u)));
    for (const u of new Set([...want.keys(), ...got.keys()])) {
      if ((want.get(u) || 0) !== (got.get(u) || 0)) bad.push(`${names[h]}: ${JSON.stringify(u)} ${got.get(u) || 0} times, its range has it ${want.get(u) || 0}`);
    }
  });
  return bad;
}

module.exports = { MARKER, pinnedLine, rebuild, sha256, homeErrors };

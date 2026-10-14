'use strict';

// A skill split's order check (tests/plugin/*-split.test.js): in each new home, the units that came from the old skill
// keep their old relative order. The units are skill-split.js's; the check is the strategy-library split's.

const { units, STRUCTURE } = require('./skill-split');

/**
 * Units out of their old order: in each home (named by `names`), the units from the old text (a changed one, an
 * allow-list entry's `now`, standing in for its `old`) keep their old relative order. [] when every home keeps it.
 */
function orderErrors(beforeText, homeTexts, names, allowed = []) {
  const old = units(beforeText);
  const nowToOld = new Map(allowed.flatMap(a => [a.now || []].flat().map(n => [n, a.old])));
  const bad = [];
  homeTexts.forEach((text, h) => {
    const used = new Map();
    let last = -1;
    let lastUnit = '';
    for (const u0 of units(text)) {
      const u = nowToOld.get(u0) || u0;
      if (STRUCTURE.includes(u)) continue;
      const from = used.has(u) ? used.get(u) + 1 : 0;
      const at = old.indexOf(u, from);
      if (at < 0) continue; // new text, not from the old skill
      used.set(u, at);
      if (at < last) bad.push(`${names[h]}: ${JSON.stringify(u)} now comes after ${JSON.stringify(lastUnit)}; it came before it`);
      last = at;
      lastUnit = u;
    }
  });
  return bad;
}

module.exports = { orderErrors };

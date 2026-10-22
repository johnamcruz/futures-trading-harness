'use strict';

// The comparison behind a skill split's coverage test (tests/plugin/*-split.test.js): a skill's units (a sentence, a
// table cell, a code line), and what differs between the old skill and its new homes beyond a reasoned allow-list.
// The same units as tests/plugin/broker-mcp-split.test.js, which keeps its own copy.

/**
 * A skill's units: its body (no frontmatter) in blocks (a heading, a list item, a table row, a paragraph, a code
 * line), whitespace normalised, list and heading markers dropped; table rows split into cells; prose into sentences.
 */
function units(md) {
  const body = md.replace(/^---\n[^]*?\n---\n/, '');
  const blocks = [];
  let cur = null;
  let fence = false;
  for (const line of body.split('\n')) {
    if (/^```/.test(line)) { fence = !fence; cur = null; continue; }
    if (fence) { if (line.trim()) blocks.push(line); cur = null; continue; }
    if (!line.trim()) { cur = null; continue; }
    if (cur === null || /^(#{1,6} |- |\d+\. |\|)/.test(line)) { cur = [line]; blocks.push(cur); } else cur.push(line);
  }
  const out = [];
  for (const b of blocks) {
    const text = (Array.isArray(b) ? b.join(' ') : b).replace(/\s+/g, ' ').trim();
    if (!Array.isArray(b)) { out.push(text); continue; } // a code line, whole
    if (text.startsWith('|')) {
      for (const cell of text.replace(/^\|\s*|\s*\|$/g, '').split(/\s+\|\s+/)) if (!/^[-|: ]+$/.test(cell)) out.push(cell);
      continue;
    }
    const prose = text.replace(/^#{1,6} /, '').replace(/^(?:- |\d+\. )/, '');
    for (const s of prose.split(/(?<=[.!?])\s+(?=[A-Z`*[("])/)) if (s) out.push(s);
  }
  return out;
}

const count = list => list.reduce((m, u) => m.set(u, (m.get(u) || 0) + 1), new Map());

// The skill format's own section headings: every skill has them (CLAUDE.md, skill format).
const STRUCTURE = ['When to Use', 'How It Works', 'Examples'];

/**
 * What differs between the old text and the new homes, beyond the allowed exceptions: [] when nothing does. Each
 * unit of the old text must be in the homes exactly as many times as before; an exception { old, now?, copies?,
 * reason } names a unit that changed (`now`: its new text, each in exactly one home) or is in `copies` homes (0 when
 * it was dropped). An exception that no longer differs fails too, so the list can only shrink.
 */
function differences(beforeText, homeTexts, allowed, { structure = true } = {}) {
  const before = count(units(beforeText));
  const after = count(homeTexts.flatMap(units));
  const byOld = new Map(allowed.map(a => [a.old, a]));
  const bad = [];
  for (const [u, n] of before) {
    if (STRUCTURE.includes(u)) continue;
    const a = byOld.get(u);
    const want = a ? (a.copies || 0) : n;
    if ((after.get(u) || 0) !== want) bad.push(`${JSON.stringify(u)}: ${n} before, ${after.get(u) || 0} after${a ? ` (allowed: ${want})` : ''}`);
  }
  for (const a of allowed) {
    if (!before.has(a.old)) bad.push(`allow-list entry not in the old text: ${a.old}`);
    // nowCopies: an old unit that appeared more than once, each copy changed the same way (default 1).
    const k = a.nowCopies || 1;
    for (const now of [a.now || []].flat()) if (after.get(now) !== k) bad.push(`changed sentence in ${after.get(now) || 0} homes, not ${k}: ${now}`);
  }
  if (structure) for (const h of STRUCTURE) if (after.get(h) !== homeTexts.length) bad.push(`"${h}" heading: ${after.get(h) || 0}, not one per skill`);
  return bad;
}

module.exports = { units, count, differences, STRUCTURE };

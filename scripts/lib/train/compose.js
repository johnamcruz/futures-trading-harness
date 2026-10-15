'use strict';

/**
 * Compose (Propose-Probe-Compose, docs/TRAINING.md): code, never a model, combines every skill edit that passed the
 * probe screen (train/screen.js) into one change. Edits go in by their paired gain on their own target, the largest
 * first (the gain: fixed minus broken, as a share of the target's paired decisions; ties: more fixed net, then id):
 *
 * - an edit whose text touches a line an edit already in touches (the same file, overlapping line ranges in the
 *   champion's text) is left out: the conflict is reported, the larger gain kept;
 * - an edit that would make the combined change invalid (proposal.js validateProposal: a `find` no longer found once,
 *   more than MAX_EDITS edits, a diff over MAX_CHANGED) or break the owner's style (probe-edit.js styleErrors: a
 *   skill over its byte cap) is left out, with why;
 * - the rest is one proposal: its targets the parts' together, its edits the parts' in that order.
 *
 * The combined change is then probed once more on the same moments (screen.js composedScreen), so its parts must not
 * cancel, and only then goes through the full keep rule (train/model-verifier.js) like any proposal. Nothing here
 * merges, pushes or edits a document outside the candidate's tree.
 *
 *   gainOf(part)                       the part's paired gain on its target
 *   linesOf(proposal, root)            [{ file, from, to }]: each edit's lines in the champion's text
 *   compose(parts, { root })           { proposal | null, parts, conflicts, dropped }
 *   compositionLines(c)                the pull request body's section on the composition
 */

const fs = require('fs');
const path = require('path');
const { validateProposal, FAILURES } = require('./proposal');
const { styleErrors } = require('./probe-edit');

const MAX_EXPECTS = 300;
const MAX_WHY = 1000;

function gainOf(part) {
  const t = part.measures && part.measures.target;
  if (!t || !t.pairs) return 0;
  return Math.round(((t.b - t.c) / t.pairs) * 10000) / 10000;
}

function linesOf(proposal, root) {
  const texts = new Map();
  return (proposal.edits || []).map(e => {
    if (!texts.has(e.file)) {
      let text = '';
      try { text = fs.readFileSync(path.join(root, e.file), 'utf8'); } catch (_err) { /* the proposal's own check refuses it */ }
      texts.set(e.file, text);
    }
    const text = texts.get(e.file);
    const at = text.indexOf(e.find);
    const from = at < 0 ? -1 : text.slice(0, at).split('\n').length;
    return { file: e.file, from, to: at < 0 ? -1 : from + e.find.split('\n').length - 1 };
  });
}

const overlap = (a, b) => a.file === b.file && a.from >= 0 && b.from >= 0 && a.from <= b.to && b.from <= a.to;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

function combined(parts) {
  const targets = FAILURES.filter(f => parts.some(p => p.proposal.targets.includes(f)));
  return {
    targets,
    expects: clip(`the probed edits together: ${parts.map(p => p.proposal.expects).join('; ')}`, MAX_EXPECTS),
    why: clip(`composed by code from ${parts.length} edit(s) that passed the probe screen: ${parts.map(p => `${p.id} (${p.tag.skill}, ${p.tag.kind}, finding ${p.finding.id} ${p.finding.kind})`).join('; ')}`, MAX_WHY),
    edits: parts.flatMap(p => p.proposal.edits.map(e => ({ file: e.file, find: e.find, replace: e.replace }))),
  };
}

function compose(parts, { root }) {
  const order = [...parts].sort((a, b) => gainOf(b) - gainOf(a) || ((b.measures.target.b - b.measures.target.c) - (a.measures.target.b - a.measures.target.c)) || String(a.id).localeCompare(String(b.id)));
  const accepted = [];
  const conflicts = [];
  const dropped = [];
  for (const p of order) {
    const lines = linesOf(p.proposal, root);
    let clash = null;
    for (const a of accepted) {
      const hit = a.lines.find(x => lines.some(y => overlap(x, y)));
      if (hit) { clash = { a, hit }; break; }
    }
    if (clash) {
      conflicts.push({ kept: clash.a.part.id, dropped: p.id, file: clash.hit.file, lines: `${clash.hit.from}-${clash.hit.to}`, gains: [gainOf(clash.a.part), gainOf(p)] });
      continue;
    }
    const trial = combined([...accepted.map(x => x.part), p]);
    const errors = [...validateProposal(trial, { root }), ...styleErrors(trial, { root })];
    if (errors.length) {
      dropped.push({ id: p.id, gain: gainOf(p), why: errors });
      continue;
    }
    accepted.push({ part: p, lines });
  }
  const chosen = accepted.map(x => x.part);
  return {
    proposal: chosen.length ? combined(chosen) : null,
    parts: chosen.map(p => ({ id: p.id, skill: p.tag.skill, kind: p.tag.kind, finding: p.finding, gain: gainOf(p), target: p.measures.target })),
    conflicts, dropped,
  };
}

function compositionLines(c) {
  if (!c) return [];
  return [
    '', '### Propose-Probe-Compose', '',
    `Composed by code from ${c.parts.length} probed edit(s) that passed the screen (train/screen.js), each probed alone on the same curated practice-train moments and seed as the champion, then together (${c.composed ? `${c.composed.verdict}` : 'not re-probed'}).`, '',
    '| part | skill | kind | finding | target fixed/broken (pairs) | gain |', '| --- | --- | --- | --- | --- | ---: |',
    ...c.parts.map(p => `| ${p.id} | ${p.skill} | ${p.kind} | ${p.finding.id} ${p.finding.kind} | ${p.target.b}/${p.target.c} (${p.target.pairs}) | ${p.gain} |`),
    ...(c.conflicts.length ? ['', 'Conflicts (the same lines; the larger paired gain kept):', ...c.conflicts.map(x => `- ${x.dropped} left out for ${x.kept}: ${x.file} lines ${x.lines} (gains ${x.gains.join(' vs ')})`)] : []),
    ...(c.dropped.length ? ['', 'Left out (the combined change would not apply or would break a cap):', ...c.dropped.map(x => `- ${x.id}: ${x.why.join('; ')}`)] : []),
    '', 'The screen only filters noise. This change is kept, if at all, by the keep rule above, never by the screen.',
  ];
}

module.exports = { gainOf, linesOf, compose, compositionLines };

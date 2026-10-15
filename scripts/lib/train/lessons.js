'use strict';

/**
 * The lessons record (Propose-Probe-Compose, docs/TRAINING.md): what probing skill edits has shown, written by code,
 * append-only (<loop dir>/lessons.jsonl). One line per probed edit (and one per combined change): the skill it
 * changed, its kind, the finding it addressed, the paired measures, the screen's verdict (helped, no effect, hurt) and
 * n, the paired decisions its target was judged on.
 *
 * A combined change that went to the keep rule gets one more line, its verdict (appendKeep: kept, rejected,
 * inconclusive, ...), since the loop's tuning windows lie in practice-train too: a screen's `helped` the keep rule
 * rejected shows as such, on the combined change and on each of its parts.
 *
 * Practice-train only: an entry's windows must each lie in practice-train (learning/splits.js), or it is refused, and
 * a line that doesn't is never summarized. No validate, test or final outcome is ever in it (held-out judging is the
 * loop's own step, never written here).
 *
 * The proposer reads a short summary next round (summarize: capped in lines and characters), as evidence with its
 * sample sizes, never as a rule. A model never writes to it and never judges from it.
 *
 *   FILE, MAX_LINES, MAX_CHARS
 *   appendLesson(file, entry)          one line; refuses an entry without its fields or outside practice-train
 *   appendKeep(file, { proposalId, iteration, keep, windows })   the keep rule's verdict on a combined change
 *   readLessons(file)                  [entry]
 *   practiceOnly(windows)              true when every window lies in practice-train
 *   summarize(entries, { maxLines, maxChars })   the proposer's text
 */

const fs = require('fs');
const path = require('path');
const { rolesBetween } = require('../learning/splits');
const { windowRange } = require('./config');
const { VERDICTS } = require('./screen');
const { KINDS } = require('./probe-edit');

const FILE = 'lessons.jsonl';
const MAX_LINES = require('../tunables').training().lessons.maxLines; // config/training.json lessons
const MAX_CHARS = require('../tunables').training().lessons.maxChars;

function practiceOnly(windows) {
  if (!Array.isArray(windows) || !windows.length) return false;
  return windows.every(w => {
    try {
      const { start, end } = windowRange(w);
      const roles = rolesBetween(start, end);
      return roles.length === 1 && roles[0] === 'practice-train';
    } catch (_err) {
      return false;
    }
  });
}

function appendLesson(file, entry) {
  const e = entry || {};
  const errors = [];
  if (typeof e.proposalId !== 'string' || !Number.isInteger(e.iteration)) errors.push('proposalId and iteration');
  if (!VERDICTS.includes(e.verdict)) errors.push(`verdict: one of ${VERDICTS.join(', ')}`);
  if (!(e.composed === true || (typeof e.skill === 'string' && KINDS.includes(e.kind)))) errors.push(`skill and kind (${KINDS.join(', ')})`);
  if (!Number.isInteger(e.n) || e.n < 0) errors.push('n: the paired decisions its target was judged on');
  if (!practiceOnly(e.windows)) errors.push('windows: practice-train only (a lesson never holds validate, test or final outcomes)');
  if (errors.length) throw new Error(`a lesson names ${errors.join('; ')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify({ v: 1, at: new Date().toISOString(), ...e })}\n`);
}

function appendKeep(file, entry) {
  const e = entry || {};
  const errors = [];
  if (typeof e.proposalId !== 'string' || !Number.isInteger(e.iteration)) errors.push('proposalId and iteration');
  if (typeof e.keep !== 'string' || !e.keep) errors.push('keep: the keep rule\'s verdict');
  if (!practiceOnly(e.windows)) errors.push('windows: practice-train only (the keep rule\'s tuning windows; never held out)');
  if (errors.length) throw new Error(`a keep line names ${errors.join('; ')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify({ v: 1, at: new Date().toISOString(), composed: true, proposalId: e.proposalId, iteration: e.iteration, keep: e.keep, windows: e.windows })}\n`);
}

function readLessons(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return text.split('\n').filter(l => l.trim()).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (err) {
      throw new Error(`${file}: line ${i + 1} is unreadable; the lessons record is append-only, fix it by hand`, { cause: err });
    }
  });
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

function summarize(entries, { maxLines = MAX_LINES, maxChars = MAX_CHARS } = {}) {
  const list = (entries || []).filter(e => e && practiceOnly(e.windows));
  // The keep rule's verdicts, on each combined change and on each of its parts (by iteration and id).
  const keeps = new Map();
  for (const k of list.filter(e => typeof e.keep === 'string')) keeps.set(`${k.iteration}|${k.proposalId}`, k.keep);
  for (const c of list.filter(e => e.composed && typeof e.keep !== 'string' && Array.isArray(e.partIds))) {
    const v = keeps.get(`${c.iteration}|${c.proposalId}`);
    if (v) for (const id of c.partIds) if (!keeps.has(`${c.iteration}|part:${id}`)) keeps.set(`${c.iteration}|part:${id}`, v);
  }
  const usable = list.filter(e => typeof e.keep !== 'string' && VERDICTS.includes(e.verdict) && Number.isInteger(e.n) && e.n > 0);
  if (!usable.length) return 'none yet';
  const groups = new Map();
  usable.forEach((e, i) => {
    const key = e.composed ? `combined changes (${e.parts || '?'} parts)` : `${e.skill}, ${e.kind}${e.findingKind ? ` (${e.findingKind})` : ''}`;
    const g = groups.get(key) || { key, helped: 0, 'no effect': 0, hurt: 0, ns: [], last: 0, keep: new Map() };
    g[e.verdict] += 1;
    g.ns.push(e.n);
    g.last = i;
    const v = keeps.get(`${e.iteration}|${e.composed ? '' : 'part:'}${e.proposalId}`);
    if (v) g.keep.set(v, (g.keep.get(v) || 0) + 1);
    groups.set(key, g);
  });
  const lines = [...groups.values()]
    .sort((a, b) => b.ns.length - a.ns.length || b.last - a.last || a.key.localeCompare(b.key))
    .slice(0, maxLines)
    .map(g => {
      const ns = g.ns.length > 6 ? `${g.ns.slice(-6).join(', ')} and ${g.ns.length - 6} earlier` : g.ns.join(', ');
      const keep = g.keep.size ? `; then the keep rule: ${[...g.keep].sort((a, b) => a[0].localeCompare(b[0])).map(([v, c]) => `${v} ${c}`).join(', ')}` : '';
      return `- ${g.key}: helped ${g.helped} of ${g.ns.length}, no effect ${g['no effect']}, hurt ${g.hurt} (n per probe: ${ns})${keep}`;
    });
  const head = 'Evidence only, from practice-train probes; n is the paired decisions each probe was judged on, and a small n shows little. A probe that helped can still fail the keep rule.';
  let out = [head, ...lines].join('\n');
  if (groups.size > lines.length) out += `\n- ${groups.size - lines.length} more group(s) not shown`;
  return clip(out, maxChars);
}

module.exports = { FILE, MAX_LINES, MAX_CHARS, appendLesson, appendKeep, readLessons, practiceOnly, summarize };

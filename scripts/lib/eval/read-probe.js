'use strict';

/**
 * The read probe: the moment probe's mode for a change to what the model is SHOWN (a briefing patch, the State line)
 * and for whether it READS the market's state, measured in minutes on recorded cycles before any replay. The old arm is
 * the recorded prompt; the new one the same prompt patched (briefing-patch.js; optionally a skill tree's blocks, as the
 * outcome probe swaps them). Each answer is scored for its reads (read-score.js) and its decision word, and the counts
 * are data: no pass or fail on the decision (a State line is a fact to weigh, never a rule).
 *
 *   change   cycles with a recorded 1h or 15m disagreement (label against its own last break or strong last candle):
 *            does the model name the conflict more often under the new arm, and how often does its decision change
 *   hold     cycles where the frames agree (none disagrees or is unknown, at least one agrees; the same days): the
 *            new arm must not make the model invent a conflict (a namesConflict here is a false one)
 *
 * Nothing here calls a model: `ask` is injected (scripts/moment-probe.js spawns claude with moment-probe's probeArgs).
 *
 *   momentForRead(log, { id, set }, { system?, systemNew? }) -> { id, set, prompt, system, systemNew, model, recorded,
 *                                         labels }  `system` overrides the recorded --append-system-prompt-file
 *                                         (required without one); `systemNew`, the new arm's own (null: the same)
 *   armOf(m, { patches?, stateLine?, bodyOf? }) -> { prompt, changed, line, resealed, unsealed }  the new arm
 *                                         (stateLine(m): the line or null); a patched block's footer sha256 recomputed
 *   probeReads({ moments, arm, ask, k })  -> { rows, summary }  every arm built first: a patch that fails on any
 *                                         moment fails the run before a model is called; each arm scored against the
 *                                         line it was shown; a row's readbackUnknown: the frames its line reads unknown
 *   summarizeReads(rows)                  -> per set: moments, untestable, readbackUnknown, calibrated, comparable,
 *                                         decisionChanged, old, new
 *   readTable({ rows, summary }, { systemNew? }) -> the readable table, its arms' systems on its first line
 *   momentsFromCycles(cycles, { statesOf, sameDays? }) -> [{ id, set, cycle, frames, readbackUnknown? }]  flat cycles in
 *                                         the entry window; ids end in the cycle file's UTC HHMMSS
 *   collectCycles(homes, days?)           -> [{ run, day, file, path, log }]  each home's logs/cycles/DAY/*-trade.json
 */

const fs = require('fs');
const path = require('path');
const { swapSkills, outcomeOf, enters, majorityOutcome, PROBE_SUFFIX } = require('./moment-probe');
const { applyPatches, stateLinePatch, frameLabels, reseal } = require('./briefing-patch');
const { FRAMES, readOf } = require('./read-score');

const SETS = ['change', 'hold'];
const norm = o => (enters(o) ? 'planned' : o);

function momentForRead(log, { id, set }, { system = null, systemNew = null } = {}) {
  if (!SETS.includes(set)) throw new Error(`moment ${id}: set: one of ${SETS.join(', ')}`);
  if (!log || typeof log.prompt !== 'string' || !log.prompt) throw new Error(`moment ${id}: the cycle log holds no prompt`);
  const argv = Array.isArray(log.argv) ? log.argv : [];
  const at = flag => { const i = argv.indexOf(flag); return i >= 0 && typeof argv[i + 1] === 'string' ? argv[i + 1] : null; };
  const sys = system || at('--append-system-prompt-file');
  if (!sys) throw new Error(`moment ${id}: its recorded argv names no system prompt file (--append-system-prompt-file): give one with --system`);
  const o = outcomeOf(log.result);
  return { id, set, prompt: log.prompt + PROBE_SUFFIX, system: sys, systemNew: systemNew || null, model: at('--model'), recorded: o ? norm(o) : null, labels: frameLabels(log.prompt) };
}

function armOf(m, { patches = [], stateLine = null, bodyOf = null } = {}) {
  let prompt = m.prompt;
  const changed = [];
  if (bodyOf) {
    const s = swapSkills(prompt, bodyOf);
    prompt = s.prompt;
    changed.push(...s.swapped.map(n => `skill ${n}`));
  }
  const line = stateLine ? stateLine(m) || null : null;
  const r = applyPatches(prompt, [...patches, ...(line ? [stateLinePatch(line)] : [])]);
  // A patched block's footer seal recomputed, so the shown sha256 matches the shown text.
  const sealed = reseal(m.prompt, r.prompt);
  // What the new arm was shown, for the scorer: the State line, else the patches' own text (words copied from it are not own words).
  const texts = patches.map(p => p.text).filter(t => typeof t === 'string' && t);
  const shown = line || (r.changed.length && texts.length ? texts.join('\n') : null);
  return { prompt: sealed.prompt, changed: [...changed, ...r.changed], line: shown, resealed: sealed.resealed, unsealed: sealed.unsealed };
}

/** The frames a State line reads unknown (the read-back had no candle or break to read: live would). */
const unknownFrames = line => [...String(line || '').matchAll(/\b(\d+[mh]) (?:(?:up|down): )?unknown\b/g)].map(x => x[1]);

const KEYS = ['namesConflict', 'opposingFact', 'ownConflict', 'transitionOnly', 'calledLabelStale', 'echoesState', 'planned', 'no-trade', 'other', 'none'];

/** One arm's counts over its asks (a failed ask is an error, never scored). */
function tally(reads, errors) {
  const t = { asks: reads.length + errors, answered: reads.length, errors };
  for (const k of KEYS) t[k] = 0;
  for (const r of reads) {
    for (const k of ['namesConflict', 'opposingFact', 'ownConflict', 'calledLabelStale', 'echoesState']) t[k] += r[k] ? 1 : 0;
    t.transitionOnly += r.conflictWords && !r.opposingFact ? 1 : 0;
    t[r.decision === null ? 'none' : r.decision === 'planned' || r.decision === 'no-trade' ? r.decision : 'other'] += 1;
  }
  return t;
}

async function probeReads({ moments, arm, ask, k = 1 }) {
  const ids = moments.map(m => String(m.id));
  if (new Set(ids).size !== ids.length) throw new Error('moments: duplicate id (each moment needs its own)');
  const failed = [];
  const arms = moments.map(m => { try { return arm(m); } catch (e) { failed.push(`${m.id}: ${e.message}`); return null; } });
  if (failed.length) throw new Error(`the new arm cannot be built (nothing asked):\n${failed.join('\n')}`);
  const rows = [];
  for (const [i, m] of moments.entries()) {
    const a = arms[i];
    if (!a.changed.length) { rows.push({ id: m.id, set: m.set, recorded: m.recorded, changed: [], verdict: 'untestable' }); continue; }
    const errors = [];
    // Each arm scored against the line IT was shown: the old arm saw none.
    const run = async (prompt, name, line) => {
      const reads = [];
      let bad = 0;
      await Promise.all(Array.from({ length: k }, async () => {
        try { reads.push(readOf((await ask(prompt, { id: m.id, arm: name })).text, { labels: m.labels, line })); } catch (e) { bad += 1; errors.push(String((e && e.message) || e).split('\n')[0]); }
      }));
      return { reads, bad };
    };
    const o = await run(m.prompt, 'old', null);
    const n = await run(a.prompt, 'new', a.line);
    const oldDecision = majorityOutcome([...o.reads.map(r => r.decision), ...Array(o.bad).fill(null)]);
    const newDecision = majorityOutcome([...n.reads.map(r => r.decision), ...Array(n.bad).fill(null)]);
    rows.push({ id: m.id, set: m.set, recorded: m.recorded, changed: a.changed, ...(a.line ? { line: a.line } : {}), readbackUnknown: unknownFrames(a.line),
      ...(a.unsealed && a.unsealed.length ? { unsealed: a.unsealed } : {}),
      old: tally(o.reads, o.bad), new: tally(n.reads, n.bad), oldDecision, newDecision,
      calibrated: m.recorded ? oldDecision === m.recorded : null,
      decisionChanged: oldDecision !== null && newDecision !== null ? oldDecision !== newDecision : null,
      ...(errors.length ? { errors: [...new Set(errors)] } : {}) });
  }
  return { rows, summary: summarizeReads(rows) };
}

function summarizeReads(rows) {
  const sum = list => list.reduce((s, t) => Object.fromEntries(Object.keys(t).map(key => [key, (s[key] || 0) + t[key]])), {});
  const out = {};
  for (const set of SETS) {
    const all = rows.filter(r => r.set === set);
    const asked = all.filter(r => r.verdict !== 'untestable');
    out[set] = { moments: all.length, untestable: all.length - asked.length, readbackUnknown: asked.filter(r => r.readbackUnknown.length).length,
      calibrated: asked.filter(r => r.calibrated === true).length,
      comparable: asked.filter(r => r.decisionChanged !== null).length, decisionChanged: asked.filter(r => r.decisionChanged === true).length,
      old: sum(asked.map(r => r.old)), new: sum(asked.map(r => r.new)) };
  }
  return out;
}

/** Columns padded to their widest cell, two spaces apart. */
function columns(table) {
  const widths = table[0].map((_, i) => Math.max(...table.map(r => String(r[i]).length)));
  return table.map(r => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(widths[i]))).join('  ').trimEnd());
}

function readTable({ rows, summary }, { systemNew = null } = {}) {
  const frac = (t, key) => `${t[key]}/${t.answered}`;
  const both = (r, key) => `${frac(r.old, key)} > ${frac(r.new, key)}`;
  const head = ['set', 'id (UTC file time)', 'recorded', 'old', 'new', 'fact old>new', 'own old>new', 'words-only new', 'echo new', 'stale old>new', 'read-back unknown', 'changed'];
  const body = rows.map(r => (r.verdict === 'untestable'
    ? [r.set, r.id, r.recorded || '-', 'untestable', '-', '-', '-', '-', '-', '-', '-', '-']
    : [r.set, r.id, r.recorded || '-', r.oldDecision || '-', r.newDecision || '-', both(r, 'opposingFact'), both(r, 'ownConflict'),
      frac(r.new, 'transitionOnly'), frac(r.new, 'echoesState'), both(r, 'calledLabelStale'), r.readbackUnknown.join(',') || '-', r.changed.join(',')]));
  const out = [systemNew
    ? `arms: old = the recorded prompt, new = the patched prompt; new system prompt file ${systemNew} on the new arm: the line confounded with its skill text (never compare with a same-system run's table)`
    : 'arms: old = the recorded prompt, new = the patched prompt; the same system prompt file on both (the patch alone differs)', ...columns([head, ...body]), ''];
  for (const set of SETS) {
    const s = summary[set];
    if (!s.moments) { out.push(`${set}: no moments`); continue; }
    const o = s.old;
    const n = s.new;
    const f = (t, key) => `${t[key] || 0}/${t.answered || 0}`;
    out.push(`${set}: ${s.moments} moments (${s.untestable} untestable, ${s.readbackUnknown} with a read-back unknown), calibrated ${s.calibrated}, decision changed ${s.decisionChanged} of ${s.comparable}; `
      + `opposingFact ${f(o, 'opposingFact')} -> ${f(n, 'opposingFact')}; own words ${f(o, 'ownConflict')} -> ${f(n, 'ownConflict')} (words only ${f(n, 'transitionOnly')}, echo ${f(n, 'echoesState')}); `
      + `calledLabelStale ${f(o, 'calledLabelStale')} -> ${f(n, 'calledLabelStale')}; planned ${o.planned || 0} -> ${n.planned || 0}, no-trade ${o['no-trade'] || 0} -> ${n['no-trade'] || 0}`);
  }
  out.push('fact: a fact against a frame\'s label in the model\'s own words (the headline, the same on both arms); own: fact, or transition/disagree words on the old arm (with a line shown, words alone may be the line\'s: words-only). hold: any of these is a false conflict (the frames agree).');
  out.push('read-back unknown: a frame the recorded text cannot read (an omitted 4h candle) that the live line would. ids end in the cycle file\'s UTC HHMMSS; the briefing\'s times are ET.');
  return `${out.join('\n')}\n`;
}

// ---- the moments file from run homes

const FLAT = ['planned', 'no-trade'];
const windowEntriesOf = prompt => { const m = /^ {2}windowEntries: (\S+)$/m.exec(String(prompt || '')); return m ? m[1] : null; };

function momentsFromCycles(cycles, { statesOf, sameDays = true }) {
  const out = [];
  for (const c of cycles) {
    const o = outcomeOf(c.log && c.log.result);
    if (!o || !FLAT.includes(norm(o)) || windowEntriesOf(c.log.prompt) !== 'allowed') continue;
    const st = statesOf(c);
    if (!st) continue;
    const s = tf => (st[tf] && st[tf].state) || 'unknown';
    const set = s('1h') === 'disagree' || s('15m') === 'disagree' ? 'change'
      : FRAMES.every(tf => s(tf) === 'agree' || s(tf) === 'range') && FRAMES.some(tf => s(tf) === 'agree') ? 'hold' : null;
    if (!set) continue;
    const unknown = FRAMES.filter(tf => s(tf) === 'unknown');
    out.push({ id: `${set}-${c.run}-${c.day}-${c.file.replace(/(?:-trade)?\.json$/, '')}`, set, cycle: c.path, frames: FRAMES.map(tf => `${tf} ${s(tf)}`).join(' | '),
      ...(unknown.length ? { readbackUnknown: unknown } : {}), day: `${c.run}/${c.day}` });
  }
  const days = new Set(out.filter(m => m.set === 'change').map(m => m.day));
  return out.filter(m => !sameDays || m.set === 'change' || days.has(m.day)).map(({ day: _day, ...m }) => m);
}

function collectCycles(homes, days = null) {
  const out = [];
  for (const home of homes) {
    const root = path.join(home, 'logs', 'cycles');
    if (!fs.existsSync(root)) throw new Error(`${home}: no logs/cycles`);
    for (const day of fs.readdirSync(root).sort()) {
      if (days && !days.includes(day)) continue;
      const dir = path.join(root, day);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir).filter(f => f.endsWith('-trade.json')).sort()) {
        const p = path.join(dir, file);
        out.push({ run: path.basename(home), day, file, path: p, log: JSON.parse(fs.readFileSync(p, 'utf8')) });
      }
    }
  }
  return out;
}

module.exports = { momentForRead, armOf, probeReads, summarizeReads, readTable, momentsFromCycles, collectCycles };

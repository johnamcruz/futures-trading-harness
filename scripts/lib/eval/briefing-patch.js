'use strict';

/**
 * The briefing patch: the moment probe's arm that changes what the model is SHOWN, not its skills. A patch is data (a
 * small JSON spec) applied to a recorded prompt; it fails loudly when its anchor is missing or matches more than once,
 * so a probe never measures a prompt the patch did not reach. And the State line's built-in patch: the recorded
 * briefing read back into the frame-state module's inputs, its line inserted where the live briefing shows it.
 *
 * A patch: { name?, within?: { from, to }, line | match, op, text?, unless? }
 *   within   the scope: from the one occurrence of `from` to the next `to` (both required; each must occur exactly
 *            once from there, or the patch fails); none: the whole prompt
 *   line     a regular expression (source) tested against each whole line of the scope: exactly one must match
 *   match    an exact substring of the scope: exactly one occurrence
 *   op       before | after | replace | remove. With `line`: a new line before / after the anchored line, the line
 *            replaced by `text`, or the line (with its newline) removed; with `match`: at the substring itself
 *   text     what to insert or replace with (required except for remove)
 *   unless   a regular expression (source) on the scope's lines: when one matches, the patch is already in (not
 *            applied, reason said): a patch applied twice changes nothing
 *
 *   validatePatch(p)                 -> p, or throws `patch: ...`
 *   applyPatch(prompt, p)            -> { prompt, applied, reason? }  throws on a missing or ambiguous scope or anchor
 *   applyPatches(prompt, list)       -> { prompt, changed: [names applied] }
 *   briefingInputs(prompt)           -> { m15, h1, candles, closedAt, et, windowEntries } read from the runner's bar
 *                                       briefing as the recorded prompt shows it, or null (no briefing, no m3 version or ET clock)
 *   frameLabels(prompt)              -> { '4h', '1h', '15m' }: each frame's trend label shown (a missing one left out)
 *   stateLineFor(cycle, fs?)         -> the State line for a recorded cycle ({ prompt }), or null
 *   frameStatesFor(cycle, fs?)       -> the frames' states for a recorded cycle, or null
 *   stateLinePatch(line)             -> the patch inserting `line` before `- Alignment:` in the runner's briefing, once
 *   statePatch(cycle, fs?)           -> stateLinePatch of the cycle's own State line, or null
 *   loadFrameState(req?)             -> { frameStates, stateLine } of scripts/lib/trading/frame-state.js; throws without
 *                                       it or without config/analysis.json briefing.stateRangeAtr
 *   reseal(before, after)            -> { prompt, resealed, unsealed }  each changed block's footer sha256 recomputed
 *
 * `fs` is { frameStates, stateLine } with frame-state.js's interface; by default that module, loaded only when asked.
 *
 * The read-back is from the recorded TEXT: the summary's candle lines (pattern, displacement side, range in ATR, the
 * sweep of the previous candle, close time) and the detail's m15 (frame, lastBreak) and h1 (h1, h4, lastBreak) JSON. Times
 * shown in ET ("09:45", "05-10 21:00") go back to ISO with the offset the prompt itself states (the m3 version's UTC
 * close against its `et` clock), so a time across a DST change is an hour off. Where the live briefing has data the text
 * leaves out (a 4h candle the summary omits: an event frame), the read-back has none and the frame reads unknown.
 */

const crypto = require('crypto');

const BRIEFING = Object.freeze({ from: '--- bar_briefing', to: '--- end of bar_briefing' });
const OPS = ['before', 'after', 'replace', 'remove'];
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

function regex(src, what) {
  try { return new RegExp(src); } catch (e) { throw new Error(`patch: ${what} is not a regular expression (${e.message})`, { cause: e }); }
}

function validatePatch(p) {
  if (!isObj(p)) throw new Error('patch: an object { line | match, op, text }');
  const name = p.name ? ` ${p.name}` : '';
  if (!OPS.includes(p.op)) throw new Error(`patch${name}: op one of ${OPS.join(', ')}`);
  const hasLine = typeof p.line === 'string' && p.line !== '';
  const hasMatch = typeof p.match === 'string' && p.match !== '';
  if (hasLine === hasMatch) throw new Error(`patch${name}: exactly one anchor, line (a pattern) or match (a substring)`);
  if (hasLine) regex(p.line, 'line');
  if (p.op !== 'remove' && typeof p.text !== 'string') throw new Error(`patch${name}: text required for ${p.op}`);
  if (p.within !== undefined && !(isObj(p.within) && typeof p.within.from === 'string' && p.within.from && typeof p.within.to === 'string' && p.within.to)) throw new Error(`patch${name}: within needs from and to`);
  if (p.unless !== undefined) regex(p.unless, 'unless');
  return p;
}

/** Every start index of `needle` in `hay`. */
function indexes(hay, needle) {
  const out = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/** The scope [start, end) of the prompt the patch acts on. */
function scopeOf(prompt, within) {
  if (!within) return [0, prompt.length];
  const starts = indexes(prompt, within.from);
  if (starts.length !== 1) throw new Error(`patch: scope "${within.from}" ${starts.length ? `matched ${starts.length} times` : 'not found'}`);
  const end = prompt.indexOf(within.to, starts[0] + within.from.length);
  if (end < 0) throw new Error(`patch: scope end "${within.to}" not found after "${within.from}"`);
  return [starts[0], end];
}

function applyPatch(prompt, p) {
  validatePatch(p);
  const src = String(prompt);
  const [s, e] = scopeOf(src, p.within);
  const scope = src.slice(s, e);
  const lines = scope.split('\n');
  if (p.unless !== undefined) {
    const re = regex(p.unless, 'unless');
    if (lines.some(l => re.test(l))) return { prompt: src, applied: false, reason: `already in: a line matches ${p.unless}` };
  }
  let out;
  if (p.line) {
    const re = regex(p.line, 'line');
    const hits = lines.map((l, i) => (re.test(l) ? i : -1)).filter(i => i >= 0);
    if (hits.length !== 1) throw new Error(`patch: anchor line ${p.line} ${hits.length ? `matched ${hits.length} times` : 'not found'}`);
    const i = hits[0];
    const next = p.op === 'before' ? [p.text, lines[i]] : p.op === 'after' ? [lines[i], p.text] : p.op === 'replace' ? [p.text] : [];
    out = [...lines.slice(0, i), ...next, ...lines.slice(i + 1)].join('\n');
  } else {
    const hits = indexes(scope, p.match);
    if (hits.length !== 1) throw new Error(`patch: anchor "${p.match}" ${hits.length ? `matched ${hits.length} times` : 'not found'}`);
    const i = hits[0];
    const j = i + p.match.length;
    const mid = p.op === 'before' ? p.text + p.match : p.op === 'after' ? p.match + p.text : p.op === 'replace' ? p.text : '';
    out = scope.slice(0, i) + mid + scope.slice(j);
  }
  return { prompt: src.slice(0, s) + out + src.slice(e), applied: true };
}

function applyPatches(prompt, list) {
  let out = String(prompt);
  const changed = [];
  for (const [i, p] of (Array.isArray(list) ? list : [list]).entries()) {
    const r = applyPatch(out, p);
    out = r.prompt;
    if (r.applied) changed.push(p.name || `patch ${i}`);
  }
  return { prompt: out, changed };
}

// ---- the recorded briefing read back

const CLOCK = /^(?:(\d\d)-(\d\d) )?(\d\d):(\d\d)$/;
const WALL = /^(\d{4})-(\d\d)-(\d\d)T(\d\d:\d\d)/;

/** The ET clock of the prompt: toIso("09:45" | "05-10 21:00") and et(iso) back, from the bar's UTC close and its ET clock. */
function clockOf(closedAt, etText) {
  const m = CLOCK.exec(String(etText || ''));
  const at = Date.parse(closedAt);
  if (!m || m[1] || !Number.isFinite(at)) return null;
  const u = new Date(at);
  // UTC minus ET: the ET clock read on the close's UTC day, or on the day before when that is later than the close.
  const on = d => Date.UTC(u.getUTCFullYear(), u.getUTCMonth(), d, Number(m[3]), Number(m[4]));
  const offset = at - (on(u.getUTCDate()) > at ? on(u.getUTCDate() - 1) : on(u.getUTCDate()));
  const wall = t => WALL.exec(new Date(t - offset).toISOString()); // the ET wall clock: [, year, month, day, HH:MM]
  const [, year, month, date] = wall(at);
  const day = `${month}-${date}`;
  const toIso = v => {
    const c = CLOCK.exec(v);
    if (!c) return v;
    const [mo, d] = c[1] ? [Number(c[1]), Number(c[2])] : [Number(month), Number(date)];
    const y = mo > Number(month) ? Number(year) - 1 : Number(year); // a later month than the bar's is last year's
    return new Date(Date.UTC(y, mo - 1, d, Number(c[3]), Number(c[4])) + offset).toISOString();
  };
  const et = iso => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    const [, , mo, d, clock] = wall(t);
    return `${mo}-${d}` === day ? clock : `${mo}-${d} ${clock}`;
  };
  return { toIso, et };
}

/** Every ET clock string in a JSON value back to ISO. */
const isoTimes = (v, toIso) => (typeof v === 'string' ? toIso(v) : Array.isArray(v) ? v.map(x => isoTimes(x, toIso))
  : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, isoTimes(x, toIso)])) : v);

/** The detail's sections: { m3: { key: value }, m15: {...}, h1: {...} } (a value that is not JSON stays its text; a broken JSON one is left out). */
function detailOf(block) {
  const out = {};
  let sec = null;
  for (const l of block.split('\n')) {
    const h = /^\[(\w+)\] version (\S+)/.exec(l);
    if (h) { sec = h[1]; out[sec] = { version: h[2].replace(/,$/, '') }; continue; }
    const kv = sec && /^ {2}(\w+): (.*)$/.exec(l);
    if (!kv) continue;
    const v = kv[2];
    if (/^[[{"]/.test(v)) { try { out[sec][kv[1]] = JSON.parse(v); } catch { /* left out: never a guess */ } } else out[sec][kv[1]] = v;
  }
  return out;
}

const CANDLE = /^- (\d+[mh]) \((?:[a-z, ]+, )?closed ((?:\d\d-\d\d )?\d\d:\d\d)\)(: |; )(.*?)\.?$/;

/** One summary candle line as frame-state reads a candle: pattern, dir, rangeAtr, closedAt, sweep (null: it stayed inside). */
function candleOf(rest, sep, closedAt) {
  const swept = /(?:^|; )swept the (.+?), closed back inside/.exec(rest);
  const beyond = /(?:^|; )traded beyond the (.+?), closed (above its high|below its low)/.exec(rest);
  const sweep = swept ? { of: swept[1], closedBack: true, closedBeyond: null }
    : beyond ? { of: beyond[1], closedBack: false, closedBeyond: /above/.test(beyond[2]) ? 'high' : 'low' } : null;
  if (sep === '; ') return { closedAt, sweep }; // an event frame's sweep-only line: no shape shown
  const head = rest.split(';')[0];
  const [shape] = head.split(', ');
  const side = / (up|down)$/.exec(shape);
  const range = /(?:^|, )range ([\d.]+) ATR(?:,|$)/.exec(head);
  return { pattern: side ? shape.slice(0, side.index) : shape, ...(side ? { dir: side[1] } : {}), ...(range ? { rangeAtr: Number(range[1]) } : {}), closedAt, sweep };
}

function briefingInputs(prompt) {
  const src = String(prompt || '');
  const i = src.indexOf(BRIEFING.from);
  if (i < 0) return null;
  const j = src.indexOf(BRIEFING.to, i);
  const block = src.slice(i, j > 0 ? j : undefined);
  const d = detailOf(block);
  const m3 = d.m3 || {};
  const v = /^m3@(.+)$/.exec(m3.version || '');
  const closedAt = v && Number.isFinite(Date.parse(v[1])) ? new Date(v[1]).toISOString() : null;
  const clock = closedAt && clockOf(closedAt, m3.et);
  if (!clock) return null;
  const candles = {};
  for (const l of block.split('\n')) {
    const c = CANDLE.exec(l);
    if (c && !(c[1] in candles)) candles[c[1]] = candleOf(c[4], c[3], clock.toIso(c[2]));
  }
  const part = (sec, keys) => (d[sec] ? Object.fromEntries(keys.filter(k => k in d[sec]).map(k => [k, isoTimes(d[sec][k], clock.toIso)])) : undefined);
  return { m15: part('m15', ['frame', 'lastBreak']), h1: part('h1', ['h1', 'h4', 'lastBreak']), candles, closedAt, et: clock.et, windowEntries: m3.windowEntries || null };
}

/** Each frame's trend label as the briefing shows it ({ '4h', '1h', '15m' }; a missing one left out). */
function frameLabels(prompt) {
  const x = briefingInputs(prompt);
  const of = v => (v && typeof v.trend === 'string' ? v.trend : null);
  const all = x ? { '4h': of((x.h1 || {}).h4), '1h': of((x.h1 || {}).h1), '15m': of((x.m15 || {}).frame) } : {};
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v));
}

// ---- the State line (scripts/lib/trading/frame-state.js, loaded only when asked)

function loadFrameState(req = require) {
  let m;
  try {
    m = req('../trading/frame-state');
    if (typeof m.frameStates !== 'function' || typeof m.stateLine !== 'function') throw new Error('no frameStates or stateLine');
  } catch (e) {
    throw new Error(`the State line patch needs scripts/lib/trading/frame-state.js (frameStates, stateLine) on this checkout: ${e.message}`, { cause: e });
  }
  // Its candle strength reads config/analysis.json briefing.stateRangeAtr: a checkout without it would read every candle wrong.
  const briefing = ((req('../tunables').analysis() || {}).briefing) || {};
  if (typeof briefing.stateRangeAtr !== 'number' || !Number.isFinite(briefing.stateRangeAtr)) throw new Error('the State line patch needs config/analysis.json briefing.stateRangeAtr (a number) on this checkout');
  return m;
}

// ---- the blocks' seals (cycle-data.js: "--- end of <tool> <args> (sha256 <hex of the block's text>) ---")

const FOOTER = /^--- end of (\S+) .*\(sha256 ([0-9a-f]+)\) ---$/gm;
const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');

/** Each sealed block: { tool, hash, text, at (the hash's index) }; its text is between its header line and its footer. */
function blocksOf(prompt) {
  return [...prompt.matchAll(FOOTER)].map(m => {
    const head = prompt.lastIndexOf(`\n--- ${m[1]} `, m.index - 1);
    const start = head < 0 && prompt.startsWith(`--- ${m[1]} `) ? 0 : head + 1;
    const textStart = prompt.indexOf('\n', start) + 1;
    return { tool: m[1], hash: m[2], text: prompt.slice(textStart, m.index - 1), at: m.index + m[0].lastIndexOf(m[2]) };
  });
}

/**
 * The prompt `after` (a patch of `before`) with each changed block's footer sha256 recomputed, so the seal matches the
 * text shown; a block whose recorded seal did not match its recorded text is left as recorded (`unsealed`).
 */
function reseal(before, after) {
  const old = blocksOf(String(before));
  let out = String(after);
  const resealed = [];
  const unsealed = [];
  const now = blocksOf(out);
  for (let i = now.length - 1; i >= 0; i -= 1) {
    const b = now[i];
    if (sha256(b.text) === b.hash) continue;
    const o = old[i];
    if (!o || o.tool !== b.tool || sha256(o.text) !== o.hash) { unsealed.unshift(b.tool); continue; }
    out = out.slice(0, b.at) + sha256(b.text) + out.slice(b.at + b.hash.length);
    resealed.unshift(b.tool);
  }
  return { prompt: out, resealed, unsealed };
}

function frameStatesFor(cycle, fs = loadFrameState()) {
  const x = briefingInputs(cycle && cycle.prompt);
  return x ? fs.frameStates({ m15: x.m15, h1: x.h1, candles: x.candles, closedAt: x.closedAt }) : null;
}

function stateLineFor(cycle, fs = loadFrameState()) {
  const x = briefingInputs(cycle && cycle.prompt);
  if (!x) return null;
  const states = fs.frameStates({ m15: x.m15, h1: x.h1, candles: x.candles, closedAt: x.closedAt });
  return states ? fs.stateLine(states, x.et) || null : null;
}

/** The patch that shows `line` where the live briefing does: right before `- Alignment:` in the runner's briefing, once. */
const stateLinePatch = line => ({ name: 'state-line', within: { ...BRIEFING }, line: '^- Alignment:', op: 'before', text: line, unless: '^- State \\(' });

function statePatch(cycle, fs = loadFrameState()) {
  const line = stateLineFor(cycle, fs);
  return line ? stateLinePatch(line) : null;
}

module.exports = { BRIEFING, validatePatch, applyPatch, applyPatches, briefingInputs, frameLabels, loadFrameState, frameStatesFor, stateLineFor, stateLinePatch, statePatch, reseal };

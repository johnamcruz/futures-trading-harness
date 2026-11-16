'use strict';

/**
 * The structure-read examples (adapters/README.md, "Structure reads"): a recorded bar briefing and a fixed instruction
 * as the prompt; as the completion, a model's answer kept only when every field it states verifies against the code's
 * facts for that bar, or else the code-built answer (`source: code`). Never labelled by outcome: nothing here reads a
 * fill, a price after the bar, or a result.
 *
 * The code's facts are the briefing's own printed data (its Summary lines and its [m3] and [m15] detail lines: the
 * briefing code's output for that bar, as the model read it), parsed from the same text the prompt holds, so the truth
 * and the prompt can't drift apart. Two instructions (INSTRUCTIONS), each answered as one JSON object:
 *   structure  the 3m and 15m last breaks, the 3m protected swing and its status, the 3m and 15m CISD, the pullback and
 *              its depth, alternating CHoCHs, the Day so far word and its RTH VWAP crosses, a 15m BOS known today
 *   sequence   the owner's structure table: what the 3m last break with the one before it means (continuation, potential
 *              reversal, confirmed reversal, failed reversal), its direction, the price whose close invalidates it, and
 *              whether a close has
 * Only a 3m lane's briefing is read (its second line names 3m). Every field is total: a briefing that doesn't print a fact has its stated "none" (a bar whose fact is printed but
 * can't be read, such as a pullback without its depth, gives no example of that instruction). An answer verifies only
 * when it is one JSON object and nothing else, with exactly the instruction's keys, each value exactly the truth's
 * (a number as a JSON number, equal; a word as written in the instruction): what is trained on is its text, so a close
 * value or another spelling is not kept.
 *
 * Balance keys, from the same facts: the case (the sequence truth: continuation, potential reversal, confirmed
 * reversal, failed reversal, none) and the regime (pullback when a Pullback line is printed and not given back, else
 * the Market state line's class: trend for trend-up or trend-down, chop, else other).
 *
 *   KINDS, INSTRUCTIONS, FIELDS
 *   briefingOf(prompt)                    the bar_briefing block of a cycle prompt (its end line included), or null
 *   truthOf(briefing)                     { structure, sequence, case, regime } (an instruction's truth null when a printed
 *                                         fact can't be read)
 *   symbolOf(briefing)                    the symbol its first line names, or null
 *   asOf(briefing)                        the time its first line says it is as of (ISO), or null
 *   promptOf(briefing, kind)              the user prompt: the briefing, a blank line, the instruction (its symbol)
 *   verifyAnswer(text, kind, truth)       { ok, wrong: [field], why }
 *   goldAnswer(kind, truth)               the code-built answer's text (one JSON object, the fields in order)
 */

const { SESSION_ALIASES } = require('../trading/clock');

const KINDS = Object.freeze(['structure', 'sequence']);
// The New York cash open (the clock's one home of the session boundaries), as the briefing prints its times.
const RTH_OPEN = SESSION_ALIASES.ny.split('-').shift();

const BREAKS = '"BOS up", "BOS down", "CHoCH up", "CHoCH down" or "none"';
const INSTRUCTIONS = Object.freeze({
  structure: `The text above is a bar briefing for MNQ at one 3-minute bar close. Answer ONLY from that briefing. Write the market structure read below as one JSON object and nothing else (no prose, no code fence).

Fields (use exactly these keys and only the allowed values):
- "b3_last": the 3m last break of structure: ${BREAKS}.
- "b3_prev": the 3m break before it, same values.
- "prot_price": the protected swing price of the 3m last break (a number), or "none".
- "prot_status": that protected swing "holding" (no close through it) or "broken" (broken by a close), or "none".
- "b15_last": the 15m last break, same values as b3_last.
- "cisd3": the 3m CISD: "bullish strong", "bullish weak", "bearish strong", "bearish weak" or "none".
- "cisd15": the 15m CISD, same values.
- "pullback": "yes" if the briefing prints a Pullback line whose leg is not given back past its origin, else "no".
- "pb_depth": the pullback's printed depth as an integer percent, or "none" when "pullback" is "no".
- "alt_choch": "yes" if the 3m last break and the one before it are both CHoCH, else "no".
- "day_so_far": the Day so far line's read word as printed (for example "too early", "rotational", "trending up", "trending down"), or "none" when the briefing prints no Day so far line.
- "vwap_crosses": the RTH VWAP crosses the Day so far line prints (an integer), or "none" when it prints none.
- "guard15": "yes" if a 15m BOS became known today at or after ${RTH_OPEN} ET (the 15m last or previous break), else "no".
`,
  sequence: `The text above is a bar briefing for MNQ at one 3-minute bar close. Answer ONLY from that briefing, using the owner's structure table: a BOS is a break in the same direction as the previous break (continuation); a CHoCH is a break against the previous break (a potential reversal); a CHoCH then a BOS the same way is a confirmed reversal; a CHoCH then a CHoCH back is a failed reversal (structural chop evidence, not chop by itself). A break is invalidated only by a close through its protected swing (a BOS: the leg's higher low / lower high; a CHoCH: the swing that started the shift); a wick is not.
Write one JSON object and nothing else (no prose, no code fence), with exactly these keys:
- "seq": what the 3m last break together with the break before it means: "continuation", "potential reversal", "confirmed reversal", "failed reversal" or "none".
- "seq_dir": the direction that read points: "up", "down" or "none".
- "inv_level": the price whose close-through invalidates the 3m last break (a number), or "none".
- "invalidated": "yes" if that level has been broken by a close, else "no".
`,
});
const FIELDS = Object.freeze({
  structure: Object.freeze(['b3_last', 'b3_prev', 'prot_price', 'prot_status', 'b15_last', 'cisd3', 'cisd15', 'pullback', 'pb_depth', 'alt_choch', 'day_so_far', 'vwap_crosses', 'guard15']),
  sequence: Object.freeze(['seq', 'seq_dir', 'inv_level', 'invalidated']),
});

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const START = '--- bar_briefing';
const END = '--- end of bar_briefing';

function briefingOf(prompt) {
  const p = typeof prompt === 'string' ? prompt : '';
  const i = p.indexOf(START);
  const j = i < 0 ? -1 : p.indexOf(END, i);
  if (i < 0 || j < 0) return null;
  // Two briefings in one prompt: which one a read is of is ambiguous.
  if (p.indexOf(START, i + 1) >= 0) return null;
  const nl = p.indexOf('\n', j);
  return nl < 0 ? null : p.slice(i, nl + 1);
}

/** A detail section ([m3], [m15]) of the briefing: from its version line to the next section. */
function section(text, tag) {
  const i = text.indexOf(`\n[${tag}] version`);
  if (i < 0) return '';
  const j = text.indexOf('\n[', i + 1);
  return text.slice(i, j < 0 ? undefined : j);
}
/**
 * A section's JSON detail line (`  key: {...}`): its object, null when the line is absent or prints null, undefined when
 * it is printed but isn't a JSON object (unreadable: nothing is assumed). Two such lines: undefined too.
 */
function jsonLine(sec, key) {
  const re = new RegExp(`\\n  ${key}: ([^\\n]*)`, 'g');
  const all = [...sec.matchAll(re)];
  if (!all.length) return null;
  if (all.length > 1) return undefined;
  try {
    const v = JSON.parse(all[0][1]);
    return v === null ? null : isObj(v) ? v : undefined;
  } catch (_err) { return undefined; }
}
const line = (text, re) => (text.match(re) || [])[0] || null;
const brk = x => (isObj(x) && (x.kind === 'BOS' || x.kind === 'CHoCH') && (x.direction === 'up' || x.direction === 'down') ? `${x.kind} ${x.direction}` : 'none');
// A CISD whose displacement is neither strong nor weak can't be read (null: no truth), never guessed weak.
const cis = x => (isObj(x) && (x.dir === 'bullish' || x.dir === 'bearish') ? (['strong', 'weak'].includes(x.displacement) ? `${x.dir} ${x.displacement}` : null) : 'none');
const today = k => typeof k === 'string' && /^\d\d:\d\d$/.test(k) && k >= RTH_OPEN;

function sequenceOf(lb) {
  const L = isObj(lb) && isObj(lb.last) ? lb.last : null;
  const P = isObj(lb) && isObj(lb.previous) ? lb.previous : null;
  if (!L || brk(L) === 'none') return { seq: 'none', seq_dir: 'none', inv_level: 'none', invalidated: 'no' };
  const prev = P && brk(P) !== 'none' ? P : null;
  let seq;
  if (!prev) seq = L.kind === 'BOS' ? 'continuation' : 'potential reversal';
  else if (L.kind === 'BOS') seq = prev.kind === 'BOS' ? 'continuation' : 'confirmed reversal';
  else seq = prev.kind === 'BOS' ? 'potential reversal' : 'failed reversal';
  const pr = isObj(L.protected) && Number.isFinite(L.protected.level) ? L.protected : null;
  return { seq, seq_dir: L.direction, inv_level: pr ? pr.level : 'none', invalidated: pr && pr.brokenAt ? 'yes' : 'no' };
}

function truthOf(briefing) {
  const t = typeof briefing === 'string' ? briefing : '';
  // Only a 3m lane's briefing: another lane prints its own bars under the [m3] tag, and the instructions say 3-minute.
  if (!/\nBar briefing \S+ 3m,/.test(t)) return { structure: null, sequence: null, case: null, regime: null };
  const m3 = section(t, 'm3');
  const m15 = section(t, 'm15');
  const lb = jsonLine(m3, 'lastBreak');
  const lb15 = jsonLine(m15, 'lastBreak');
  const cisd = jsonLine(m3, 'cisd');
  // A detail line printed but unreadable, or no [m3] section at all: nothing about the bar can be verified.
  if (!m3 || lb === undefined || lb15 === undefined || cisd === undefined) return { structure: null, sequence: null, case: null, regime: null };
  const last = isObj(lb) && isObj(lb.last) ? lb.last : null;
  const prev = isObj(lb) && isObj(lb.previous) ? lb.previous : null;
  const pr = last && isObj(last.protected) && Number.isFinite(last.protected.level) ? last.protected : null;
  const pbLine = line(t, /\n- Pullback \([^\n]*/);
  const pbYes = Boolean(pbLine && !/given back past its origin/.test(pbLine));
  const depth = pbLine ? pbLine.match(/depth (\d+)% of the leg/) : null;
  const sf = line(t, /\n- Day so far[^\n]*/);
  let word = 'none';
  if (sf) word = /too early/.test(sf) ? 'too early' : /^\n- Day so far(?: \([^)]*\))?: unknown\b/.test(sf) ? 'unknown' : ((sf.match(/`day-context`\): ([a-z ]+?):/) || [])[1] || null);
  const crossM = sf ? sf.match(/RTH VWAP crosses (\d+)/) : null;
  const l15 = isObj(lb15) ? [lb15.last, lb15.previous] : [];
  const structure = {
    b3_last: brk(last), b3_prev: brk(prev), prot_price: pr ? pr.level : 'none', prot_status: pr ? (pr.brokenAt ? 'broken' : 'holding') : 'none',
    b15_last: brk(isObj(lb15) ? lb15.last : null), cisd3: cis(isObj(cisd) ? cisd['3m'] : null), cisd15: cis(isObj(cisd) ? cisd['15m'] : null),
    pullback: pbYes ? 'yes' : 'no', pb_depth: pbYes ? (depth ? Number(depth[1]) : null) : 'none',
    alt_choch: last && prev && last.kind === 'CHoCH' && prev.kind === 'CHoCH' ? 'yes' : 'no',
    day_so_far: word, vwap_crosses: crossM ? Number(crossM[1]) : 'none',
    guard15: l15.some(x => isObj(x) && x.kind === 'BOS' && today(x.knownAt)) ? 'yes' : 'no',
  };
  const sequence = sequenceOf(lb);
  const cls = (line(t, /\n- Market state \(3m\):[^\n]*/) || '').match(/class (trend-up|trend-down|chop|unclear)\b/);
  const regime = pbYes ? 'pullback' : cls && cls[1].startsWith('trend') ? 'trend' : cls && cls[1] === 'chop' ? 'chop' : 'other';
  return { structure: Object.values(structure).some(v => v === null) ? null : structure, sequence, case: sequence.seq, regime };
}

/** The briefing's symbol (its first line's {"symbol": ...}), or null. */
function symbolOf(briefing) {
  const m = String(briefing || '').match(/^--- bar_briefing (\{[^\n]*?\}) as of/);
  try {
    const s = m ? JSON.parse(m[1]).symbol : null;
    return typeof s === 'string' && /^[A-Z0-9]{1,8}$/.test(s) ? s : null;
  } catch (_err) { return null; }
}

/** The user prompt: the briefing, a blank line, the instruction (its symbol the briefing's). */
function promptOf(briefing, kind) {
  if (!INSTRUCTIONS[kind]) throw new Error(`no structure-read instruction "${kind}" (${KINDS.join(', ')})`);
  const symbol = symbolOf(briefing);
  if (!symbol) throw new Error('promptOf: a briefing that names its symbol');
  return `${briefing}\n\n${INSTRUCTIONS[kind].replace('a bar briefing for MNQ', `a bar briefing for ${symbol}`)}`;
}

/** A JSON text without the whitespace outside its strings. */
function minified(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] || ''; i += 1; } else if (ch === '"') inStr = false;
    } else if (ch === '"') { inStr = true; out += ch; } else if (!/\s/.test(ch)) out += ch;
  }
  return out;
}

/** The time the briefing is as of (its first line's), as ISO, or null. */
function asOf(briefing) {
  const m = String(briefing || '').match(/^--- bar_briefing [^\n]*? as of (\S+) ---/);
  return m && Number.isFinite(Date.parse(m[1])) ? new Date(m[1]).toISOString() : null;
}

function verifyAnswer(text, kind, truth) {
  const fields = FIELDS[kind];
  if (!fields) throw new Error(`no structure-read instruction "${kind}"`);
  if (!isObj(truth)) return { ok: false, wrong: [], why: 'no truth for the bar' };
  let a;
  // Only JSON's own whitespace around it (String.trim would also drop a no-break space, kept in the trained text).
  const body = String(text).replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  try { a = JSON.parse(body); } catch (_err) { return { ok: false, wrong: [], why: 'not one JSON object and nothing else' }; }
  if (!isObj(a)) return { ok: false, wrong: [], why: 'not one JSON object' };
  // What is trained on is the text: it must be the object's own canonical text (whitespace aside), so a repeated key,
  // an escaped character, a BOM or a number written another way (1.399025e4) is not kept.
  if (/\uFEFF/.test(String(text)) || minified(body) !== JSON.stringify(a)) return { ok: false, wrong: [], why: 'not written canonically (a repeated key, an escape or a number written another way)' };
  const keys = Object.keys(a);
  if (keys.length !== fields.length || !fields.every(f => keys.includes(f))) return { ok: false, wrong: [], why: `its keys aren't exactly ${fields.join(', ')}` };
  const wrong = fields.filter(f => a[f] !== truth[f]);
  return { ok: !wrong.length, wrong, why: wrong.length ? `wrong: ${wrong.join(', ')}` : null };
}

function goldAnswer(kind, truth) {
  if (!FIELDS[kind] || !isObj(truth)) throw new Error('goldAnswer: an instruction and its truth');
  return JSON.stringify(Object.fromEntries(FIELDS[kind].map(f => [f, truth[f]])));
}

module.exports = { KINDS, INSTRUCTIONS, FIELDS, RTH_OPEN, briefingOf, symbolOf, asOf, truthOf, promptOf, verifyAnswer, goldAnswer, sequenceOf };

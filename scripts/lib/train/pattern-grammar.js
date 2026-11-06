'use strict';

/**
 * The grammar a proposer's quiz pattern (a probe question's required or forbidden regex, train/probe-question.js) must be
 * written in: a whitelist, so no form that backtracks without end on a long answer reaches the grader (a blacklist of
 * bad forms kept leaking). Accepted, and nothing else:
 *
 *   literal text     letters, digits, the plain space, common punctuation and any non-ASCII character but whitespace (no
 *                    tab, no-break or em space: \s matches those); any punctuation escaped
 *                    (\. \? \( ...); one letter or digit may be optional (needs?)
 *   \b               anywhere
 *   \s \s+ \s* \s?   only directly between literal text (a non-space character, a class or a group on both sides, \b
 *                    aside)
 *   [...]            letters, digits, ranges and punctuation, never negated, never whitespace or an escape; at most ? after
 *   (...) (?:...)    literal alternatives only (a|the), none empty, no nesting, pairwise distinct and none a prefix of
 *                    another (case-blind: (a|ab) never), a plain space only inside one (never at its edge); at most ?
 *                    after; at most limits.maxGroups groups in all
 *   ^ $              at the start, at the end
 *   a gap            .{0,N} .{1,N} \w{0,N} \S{1,N} ...: N at most limits.maxGapChars, at most limits.maxGaps of them, each
 *                    preceded by literal text (or the start) and followed by literal text (unbounded .* or \w+ never)
 * At most limits.maxOptionals optional parts (x?, [..]?, (..)?). The backtracking a start can take is then bounded by
 * the product of each group's alternatives (at most maxGroups groups), 2^maxOptionals and maxGapChars^maxGaps, each
 * branch checked against literal text: no input length makes it grow (a pattern's length is gate.maxPatternChars).
 *
 *   grammarErrors(src, { maxGaps, maxGapChars, maxOptionals, maxGroups })   [error]: the rule each part breaks (the quiz file's gate)
 */

const ESCAPABLE = '.?()[]{}*+|^$\\/-,:;\'"!#%&=<>~@';
const isAlnum = c => /^[A-Za-z0-9]$/.test(c);
// Literal text unescaped: letters, digits, the plain space and punctuation a regex gives no meaning, and any non-ASCII
// character but whitespace (no-break space, em space, line separator: \s matches them, so a \s+ beside one overlaps).
const isLiteral = c => isAlnum(c) || c === ' ' || ',;:\'"!%&/#@=<>~-_`'.includes(c) || (c > '\x7f' && !/\s/.test(c));
const isClassChar = c => isAlnum(c) || (!/\s/.test(c) && c !== '\\' && c !== ']' && c !== '^' && c !== '[' && (isLiteral(c) || '.?()*+|$'.includes(c)));
const GAP = /^\{([01]),(\d+)\}/;

function grammarErrors(src, limits = {}) {
  const { maxGaps, maxGapChars, maxOptionals, maxGroups } = limits;
  // Whole numbers (the quiz file's validation, eval/context-quiz.js quizErrors, holds their ranges).
  if (![maxGaps, maxGapChars, maxOptionals, maxGroups].every(Number.isInteger)) throw new Error('grammarErrors: limits { maxGaps, maxGapChars, maxOptionals, maxGroups } (the quiz file\'s gate)');
  const s = String(src);
  const errors = [];
  const toks = [];
  const optional = () => { if (s[i + 1] === '?') { i += 1; return true; } return false; };
  const repeatAfter = j => '*+{'.includes(s[j] || '#');
  let i = 0;
  const gap = (at, atom) => {
    const m = GAP.exec(s.slice(i + 1));
    if (s[i + 1] === '*' || s[i + 1] === '+' || /^\{\d+,\}/.test(s.slice(i + 1))) errors.push(`${atom} at ${at}: an unbounded gap; write ${atom}{0,N} with N at most ${maxGapChars}`);
    else if (!m) errors.push(`${atom} at ${at}: a wildcard only as a gap ${atom}{0,N} (N at most ${maxGapChars}); escape a literal "."`);
    else if (Number(m[2]) > maxGapChars || Number(m[2]) < Number(m[1])) errors.push(`${atom}{${m[1]},${m[2]}} at ${at}: a gap of at most ${maxGapChars} characters (the quiz file's gate.maxGapChars)`);
    else { toks.push({ k: 'gap', at }); i += m[0].length; return; }
    i += 1;
  };
  for (; i < s.length; i += 1) {
    const c = s[i];
    const at = i;
    if (c === '\\') {
      const n = s[i + 1];
      if (n === 'b') { toks.push({ k: 'b' }); i += 1; } else if (n === 's') {
        i += 1;
        if ('+*?'.includes(s[i + 1] || '#')) i += 1;
        if (repeatAfter(i + 1)) errors.push(`\\s at ${at}: one repeat (\\s+ \\s* \\s?), never more`);
        toks.push({ k: 'ws', at });
      } else if (n === 'w' || n === 'S') { i += 1; gap(at, `\\${n}`); } else if (n !== undefined && ESCAPABLE.includes(n)) {
        i += 1;
        if (repeatAfter(i + 1)) errors.push(`\\${n} at ${at}: a repeat only in a gap .{0,N} or \\s+`);
        toks.push({ k: 'lit', ch: n, opt: false });
      } else errors.push(`\\${n || ''} at ${at}: only \\b, \\s, a gap \\w{0,N} or \\S{0,N}, and escaped punctuation`);
    } else if (c === '.') gap(at, '.');
    else if (c === '[') {
      const end = s.indexOf(']', i + 1);
      const body = end < 0 ? '' : s.slice(i + 1, end);
      if (end < 0 || !body.length || ![...body].every(isClassChar)) errors.push(`a class at ${at}: letters, digits, ranges and punctuation only (never negated, a space or an escape)`);
      i = end < 0 ? s.length : end;
      const opt = optional();
      if (repeatAfter(i + 1)) errors.push(`a class at ${at}: no repeat after it (at most ?)`);
      toks.push({ k: 'class', opt });
    } else if (c === '(') {
      const end = s.indexOf(')', i + 1);
      let body = end < 0 ? null : s.slice(i + 1, end);
      if (body) body = body.replace(/^\?:/, '');
      const alts = body === null ? [] : body.split('|');
      // A plain space only strictly between two other characters, no other whitespace: a group beside \s+ stays disjoint.
      const altOk = a => a.length > 0 && /^(?:\\[^A-Za-z0-9]|[^\\()[\]{}.*+?|^$])+$/.test(a) && [...a.replace(/\\./g, '')].every(isLiteral) && !/^\s|\s$/.test(a);
      if (body === null || !alts.every(altOk)) errors.push(`a group at ${at}: literal alternatives only, such as (a|the) or (?:wait|hold), none empty, nothing nested, no space at an edge`);
      // Two alternatives that can match the same text (equal, or one a prefix of the other) double the paths a start.
      const low = alts.map(a => a.toLowerCase());
      if (low.some((a, j) => low.some((b, m) => m !== j && b.startsWith(a)))) errors.push(`a group at ${at}: distinct alternatives, none a prefix of another (case-blind; (a|ab) never)`);
      i = end < 0 ? s.length : end;
      const opt = optional();
      if (repeatAfter(i + 1)) errors.push(`a group at ${at}: no repeat after it (at most ?): a repeated group backtracks without end`);
      toks.push({ k: 'group', opt });
    } else if (c === '^' && i === 0) toks.push({ k: 'start' });
    else if (c === '$' && i === s.length - 1) toks.push({ k: 'end' });
    else if (isLiteral(c)) {
      const opt = isAlnum(c) && optional();
      if (repeatAfter(i + 1)) errors.push(`"${c}" at ${at}: a repeat only in a gap .{0,N} or \\s+`);
      toks.push({ k: 'lit', ch: c, opt });
    } else errors.push(`"${c}" at ${at}: not in the pattern grammar (${c === '|' ? 'put alternatives in a group (a|b)' : c === '^' || c === '$' ? 'an anchor only at the start or the end' : 'literal text, \\b, \\s, a class, a group of literals or a gap'})`);
  }
  // The neighbours of a whitespace repeat and of a gap, \b aside.
  const near = toks.filter(t => t.k !== 'b');
  const solid = t => Boolean(t) && ((t.k === 'lit' && t.ch !== ' ') || t.k === 'class' || t.k === 'group');
  near.forEach((t, j) => {
    const [p, n] = [near[j - 1], near[j + 1]];
    if (t.k === 'ws' && !(solid(p) && solid(n))) errors.push(`\\s at ${t.at}: only directly between literal text (never at an end, beside a space, a gap or another \\s)`);
    if (t.k === 'gap') {
      if (!(p === undefined || p.k === 'start' || (p.k === 'lit' && !p.opt))) errors.push(`a gap at ${t.at}: preceded by literal text or the start`);
      if (!(n && n.k === 'lit' && !n.opt)) errors.push(`a gap at ${t.at}: followed by literal text`);
    }
  });
  const gaps = toks.filter(t => t.k === 'gap').length;
  if (gaps > maxGaps) errors.push(`at most ${maxGaps} wildcard gaps (the quiz file's gate.maxGaps): this has ${gaps}`);
  const groups = toks.filter(t => t.k === 'group').length;
  if (groups > maxGroups) errors.push(`at most ${maxGroups} groups (the quiz file's gate.maxGroups): this has ${groups}`);
  const opts = toks.filter(t => t.opt).length;
  if (opts > maxOptionals) errors.push(`at most ${maxOptionals} optional parts (the quiz file's gate.maxOptionals): this has ${opts}`);
  return errors;
}

module.exports = { grammarErrors };

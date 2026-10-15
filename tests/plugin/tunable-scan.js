'use strict';

/**
 * The tunable-literal scan behind tests/plugin/no-tunable-literals.test.js: what in scripts/ looks like a tunable
 * stated in code instead of read from config/ (scripts/lib/tunables.js).
 *
 *   constantsIn(text)    [{ name, line }]: UPPER_CASE constants whose value states a numeric literal, and lower-case
 *                        ones stated as numbers (other than 0 and 1) or arithmetic of numbers
 *   literalCount(text)   the number of numeric literals (other than 0 and 1) in a comparison, a default value, a
 *                        fallback (x || 5, x ?? 5), a property assignment (this.k = 5), a bare numeric call argument
 *                        (setTimeout(f, 5000), list.slice(0, 20)), an object literal's value, Math.max / Math.min arguments or a fractional factor (x * 0.35),
 *                        outside a named constant's own statement (the constant is listed with its reason);
 *                        { mechanics }: regular expressions (sources) of listed mechanical forms, not counted
 *   scriptFiles(repo)    every .js under scripts/lib, scripts/hooks and scripts/*.js, repo-relative with '/'
 *
 * The scan is heuristic, line by line: it counts per file, and a literal it can't see (an argument over several lines, a
 * number built from other names) is not counted.
 *
 * A literal inside a string, a template's text, a regular expression or a comment is not counted.
 */

const fs = require('fs');
const path = require('path');

const NUM = String.raw`(?:\d+\.\d*|\.\d+|\d+)(?:e[-+]?\d+)?`;
const HAS_NUM = new RegExp(String.raw`(?<![\w$.])${NUM}(?![\w$])`);
const MECHANICAL = new Set(['0', '1', '0.0', '1.0']);
const COMPARE = new RegExp(String.raw`(?:[<>]=?|[!=]==?)\s*-?(${NUM})(?![\w$.])|(?<![\w$.])(${NUM})\s*(?:[<>]=?|[!=]==?)`, 'g');
const DEFAULT = new RegExp(String.raw`[({,]\s*[A-Za-z_$][\w$]*\s*=\s*-?(${NUM})(?![\w$.])`, 'g');
// An object literal's numeric value ({ minN: 20 }, a key quoted or not), and a fractional factor (x * 0.35, 0.5 * y).
const OBJECT = new RegExp(String.raw`[{,]\s*(?:[A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:\s*-?(${NUM})(?![\w$.])`, 'g');
const FRACTION = new RegExp(String.raw`(?<!\*)\*\s*-?(\d*\.\d+(?:e[-+]?\d+)?)(?![\w$.])|(?<![\w$.])(\d*\.\d+(?:e[-+]?\d+)?)\s*\*(?!\*)`, 'g');
// A default stated after a fallback operator (x || 5, x ?? 0.5), and a number assigned to a property (this.k = 5, x.k = 5; not
// ==, <=, +=). A call argument that is a bare number (setTimeout(f, 5000), list.slice(0, 20)) is found by callArgs().
const FALLBACK = new RegExp(String.raw`(?:\|\||\?\?)\s*-?(${NUM})(?![\w$.])`, 'g');
const PROP_ASSIGN = new RegExp(String.raw`(?<![\w$])(?:this|[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])+\s*(?<![=!<>+\-*/%&|^])=(?!=)\s*-?(${NUM})(?![\w$.])`, 'g');
const NOT_A_CALL = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'of', 'in', 'async']);
const ANY_NUM = new RegExp(String.raw`(?<![\w$.])(${NUM})(?![\w$.])`, 'g');
// A lower-case constant stated as a number or arithmetic of numbers (const half = 0.5; let tries = 3 * 2;).
const LOWER = new RegExp(String.raw`^\s*(?:const|let|var)\s+([a-z][\w$]*)\s*=\s*([-+*/().\s\d_e]+);`);

/** The code of a file with strings, template text, regular expressions and comments blanked (lines kept). */
function codeOnly(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let prev = ''; // the last significant code character (to tell a regex from a division)
  const blank = s => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') { const j = text.indexOf('\n', i); const e = j === -1 ? n : j; out += blank(text.slice(i, e)); i = e; continue; }
    if (c === '/' && d === '*') { const j = text.indexOf('*/', i + 2); const e = j === -1 ? n : j + 2; out += blank(text.slice(i, e)); i = e; continue; }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out += c + blank(text.slice(i + 1, j)) + c; i = j + 1; prev = c; continue;
    }
    if (c === '`') {
      // Template text is blanked; ${...} expressions are code (scanned recursively by depth).
      let j = i + 1;
      out += '`';
      while (j < n && text[j] !== '`') {
        if (text[j] === '\\') { out += '  '; j += 2; continue; }
        if (text[j] === '$' && text[j + 1] === '{') {
          let depth = 1;
          let k = j + 2;
          while (k < n && depth) { if (text[k] === '{') depth += 1; else if (text[k] === '}') depth -= 1; k += 1; }
          out += `\${${codeOnly(text.slice(j + 2, k - 1))}}`;
          j = k;
          continue;
        }
        out += text[j] === '\n' ? '\n' : ' ';
        j += 1;
      }
      out += '`'; i = j + 1; prev = '`'; continue;
    }
    if (c === '/' && (!prev || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /\b(?:return|typeof|case|of|in)\s*$/.test(out))) {
      // A regular expression literal.
      let j = i + 1;
      let cls = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '[') cls = true;
        else if (text[j] === ']') cls = false;
        else if (text[j] === '/' && !cls) break;
        j += 1;
      }
      j += 1;
      while (j < n && /[a-z]/.test(text[j])) j += 1;
      out += blank(text.slice(i, j)); i = j; prev = '/'; continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

/** The statement starting at line i (until its brackets close and it ends). */
function statementAt(lines, i) {
  let depth = 0;
  let s = '';
  for (let j = i; j < lines.length; j += 1) {
    s += `${lines[j]}\n`;
    for (const ch of lines[j]) { if ('([{'.includes(ch)) depth += 1; else if (')]}'.includes(ch)) depth -= 1; }
    if (depth <= 0) break;
  }
  return s;
}

/** The numbers in a string of code other than 0 and 1. */
const tunableNumbers = s => [...s.matchAll(ANY_NUM)].map(m => m[1]).filter(x => !MECHANICAL.has(x));

/** [{ name, line, lines }]: each constant that states a number, with how many lines its statement spans. */
function constantStatements(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const m = /^\s*(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(l);
    if (m) {
      const rhs = statementAt([m[2], ...lines.slice(i + 1)], 0);
      if (HAS_NUM.test(rhs)) out.push({ name: m[1], line: i + 1, lines: rhs.split('\n').length - 1 });
      return;
    }
    // A lower-case name hides a tunable as well as an UPPER_CASE one: one stated as numbers, other than 0 and 1.
    const low = LOWER.exec(l);
    if (low && tunableNumbers(low[2]).length) out.push({ name: low[1], line: i + 1, lines: 1 });
  });
  return out;
}

function constantsIn(text) {
  return constantStatements(codeOnly(text).split('\n')).map(({ name, line }) => ({ name, line }));
}

/** The args of each Math.max( / Math.min( call on a line (to its closing paren; the rest of the line if it has none). */
function mathArgs(line) {
  const out = [];
  const re = /\bMath\.(?:max|min)\(/g;
  let m;
  while ((m = re.exec(line))) {
    let depth = 1;
    let j = m.index + m[0].length;
    const from = j;
    while (j < line.length && depth) { if (line[j] === '(') depth += 1; else if (line[j] === ')') depth -= 1; j += 1; }
    out.push({ from, text: line.slice(from, depth ? j : j - 1) });
  }
  return out;
}

/** The bare numeric arguments of each call on a line: [{ at, x }] (the number's offset). A name before "(" makes it a call. */
function callArgs(line) {
  const out = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== '(') continue;
    const name = /([A-Za-z_$][\w$]*)\s*$/.exec(line.slice(0, i));
    if (!name || NOT_A_CALL.has(name[1])) continue;
    let depth = 1;
    let j = i + 1;
    let from = j;
    const cut = end => {
      const arg = line.slice(from, end);
      const m = new RegExp(String.raw`^\s*-?(${NUM})\s*$`).exec(arg);
      if (m) out.push({ at: from + arg.indexOf(m[1]), x: m[1] });
    };
    for (; j < line.length && depth; j += 1) {
      const ch = line[j];
      if ('([{'.includes(ch)) depth += 1;
      else if (')]}'.includes(ch)) { depth -= 1; if (!depth) cut(j); } else if (ch === ',' && depth === 1) { cut(j); from = j + 1; }
    }
  }
  return out;
}

/**
 * The numeric literals (other than 0 and 1) that look like a threshold: in a comparison, a default value, an object
 * literal's value, a Math.max / Math.min call's arguments, or a fractional factor. A literal two of these see counts once.
 * A named constant's own statement is not counted: the constant itself must be listed, with its reason.
 */
function literalCount(text, { mechanics = [] } = {}) {
  let n = 0;
  const lines = codeOnly(text).split('\n');
  const named = new Set(constantStatements(lines).flatMap(c => Array.from({ length: c.lines }, (_, k) => c.line - 1 + k)));
  const allowed = mechanics.map(p => new RegExp(p, 'g'));
  for (const [i, raw] of lines.entries()) {
    if (named.has(i)) continue;
    // A listed mechanical form (a protocol's code, with its reason in the pins) is blanked before counting.
    const l = allowed.reduce((s, re) => s.replace(re, x => ' '.repeat(x.length)), raw);
    const seen = new Set();
    const count = (at, x) => { if (!MECHANICAL.has(x) && !seen.has(at)) { seen.add(at); n += 1; } };
    for (const re of [COMPARE, DEFAULT, OBJECT, FRACTION, FALLBACK, PROP_ASSIGN]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(l))) {
        const x = m[1] || m[2];
        count(m.index + m[0].lastIndexOf(x), x);
      }
    }
    for (const { from, text: args } of mathArgs(l)) {
      for (const m of args.matchAll(ANY_NUM)) count(from + m.index, m[1]);
    }
    for (const { at, x } of callArgs(l)) count(at, x);
  }
  return n;
}

function scriptFiles(repo) {
  const out = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(path.relative(repo, p).split(path.sep).join('/'));
    }
  };
  walk(path.join(repo, 'scripts'));
  return out.sort();
}

module.exports = { codeOnly, constantsIn, literalCount, scriptFiles };

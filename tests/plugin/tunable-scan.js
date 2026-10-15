'use strict';

/**
 * The tunable-literal scan behind tests/plugin/no-tunable-literals.test.js: what in scripts/ looks like a tunable
 * stated in code instead of read from config/ (scripts/lib/tunables.js).
 *
 *   constantsIn(text)    [{ name, line }]: UPPER_CASE constants whose value states a numeric literal
 *   literalCount(text)   the number of numeric literals (other than 0 and 1) in a comparison or a default value
 *   scriptFiles(repo)    every .js under scripts/lib, scripts/hooks and scripts/*.js, repo-relative with '/'
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

function constantsIn(text) {
  const lines = codeOnly(text).split('\n');
  const out = [];
  lines.forEach((l, i) => {
    const m = /^\s*(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(l);
    if (!m) return;
    const rhs = statementAt([m[2], ...lines.slice(i + 1)], 0);
    if (HAS_NUM.test(rhs)) out.push({ name: m[1], line: i + 1 });
  });
  return out;
}

function literalCount(text) {
  let n = 0;
  for (const l of codeOnly(text).split('\n')) {
    for (const re of [COMPARE, DEFAULT]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(l))) if (!MECHANICAL.has(m[1] || m[2])) n += 1;
    }
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

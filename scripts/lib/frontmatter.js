'use strict';

/**
 * Minimal, dependency-free YAML frontmatter parser for skill, agent, command,
 * and strategy Markdown files. Plugin installs don't run `npm install`, so the
 * runtime can't depend on a YAML package.
 *
 * Supported subset: nested maps by indentation (spaces only), lists of
 * scalars or maps (`- item`, `- key: value`), inline lists (`[a, b]`),
 * quoted and plain scalars, numbers, booleans, null, and `#` comments.
 * Block scalars (`|`, `>`), anchors, and tags are rejected with an error.
 */

/** A quote only opens a quoted scalar at the start of a value: after "key:", "- ", "[", or ",". */
function opensQuote(text, i) {
  const before = text.slice(0, i).trimEnd();
  return before === '' || /[:[,]$/.test(before) || /(^|\s)-$/.test(before);
}

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
    } else if ((ch === '"' || ch === "'") && opensQuote(text, i)) {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

function splitInline(body) {
  const items = [];
  let quote = null;
  let current = '';
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if ((ch === '"' || ch === "'") && current.trim() === '') {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') items.push(current.trim());
  return items;
}

function parseScalar(raw, lineNo) {
  const text = raw.trim();
  if (text === '' || text === '~' || text === 'null') return null;
  if (/^[|>][+-]?$/.test(text) || /^[&*!]/.test(text)) {
    throw new Error(`line ${lineNo}: unsupported YAML feature "${text}"`);
  }
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new Error(`line ${lineNo}: unterminated inline list`);
    return splitInline(text.slice(1, -1)).map(item => parseScalar(item, lineNo));
  }
  if (text.startsWith('{')) throw new Error(`line ${lineNo}: inline maps are not supported; use indentation`);
  if (text.startsWith('"')) {
    if (!(text.endsWith('"') && text.length >= 2)) throw new Error(`line ${lineNo}: unterminated or trailing text after a quoted value`);
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`line ${lineNo}: invalid quoted value ${text.slice(0, 40)}`, { cause: err });
    }
  }
  if (text.startsWith("'")) {
    if (!(text.endsWith("'") && text.length >= 2)) throw new Error(`line ${lineNo}: unterminated or trailing text after a quoted value`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function tokenize(source) {
  return source.split('\n').flatMap((line, i) => {
    if (/\t/.test(line.match(/^\s*/)[0])) throw new Error(`line ${i + 1}: tabs are not allowed for indentation`);
    const content = stripComment(line);
    if (content.trim() === '') return [];
    return [{ indent: content.match(/^ */)[0].length, text: content.trim(), lineNo: i + 1 }];
  });
}

function parseBlock(lines, start, indent) {
  const first = lines[start];
  if (first.text.startsWith('- ') || first.text === '-') return parseList(lines, start, indent);
  return parseMap(lines, start, indent);
}

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function keyValue(line) {
  const m = /^([A-Za-z0-9_.-]+|"[^"]*"|'[^']*'):(?:\s+(.*))?$/.exec(line.text);
  if (!m) throw new Error(`line ${line.lineNo}: expected "key: value", got "${line.text}"`);
  const key = m[1].replace(/^["']|["']$/g, '');
  if (RESERVED_KEYS.has(key)) throw new Error(`line ${line.lineNo}: "${key}" is not allowed as a key`);
  return { key, rest: m[2] === undefined ? '' : m[2] };
}

function parseMap(lines, start, indent) {
  const out = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i];
    if (line.text.startsWith('- ')) throw new Error(`line ${line.lineNo}: unexpected list item in a map`);
    const { key, rest } = keyValue(line);
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`line ${line.lineNo}: duplicate key "${key}"`);
    i += 1;
    if (rest !== '') {
      out[key] = parseScalar(rest, line.lineNo);
    } else if (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
      // Compact list style: "key:" followed by "- item" at the same indent.
      const [value, next] = parseList(lines, i, indent);
      out[key] = value;
      i = next;
    } else if (i < lines.length && lines[i].indent > indent) {
      const [value, next] = parseBlock(lines, i, lines[i].indent);
      out[key] = value;
      i = next;
    } else {
      out[key] = null;
    }
  }
  if (i < lines.length && lines[i].indent > indent) {
    throw new Error(`line ${lines[i].lineNo}: unexpected indentation`);
  }
  return [out, i];
}

function parseList(lines, start, indent) {
  const out = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
    const line = lines[i];
    const itemText = line.text === '-' ? '' : line.text.slice(2).trim();
    i += 1;
    if (itemText === '') {
      if (i < lines.length && lines[i].indent > indent) {
        const [value, next] = parseBlock(lines, i, lines[i].indent);
        out.push(value);
        i = next;
      } else {
        out.push(null);
      }
    } else if (/^([A-Za-z0-9_.-]+):(\s|$)/.test(itemText)) {
      // A map item: "- key: value" plus following keys indented to the item text.
      const childIndent = indent + 2;
      const synthetic = [{ indent: childIndent, text: itemText, lineNo: line.lineNo }];
      while (i < lines.length && lines[i].indent >= childIndent) synthetic.push(lines[i++]);
      const [value, next] = parseMap(synthetic, 0, childIndent);
      if (next !== synthetic.length) throw new Error(`line ${synthetic[next].lineNo}: bad indentation in list item`);
      out.push(value);
    } else {
      out.push(parseScalar(itemText, line.lineNo));
    }
  }
  return [out, i];
}

/** Parse a YAML-subset document into a plain object. */
function parseYaml(source) {
  const lines = tokenize(source);
  if (lines.length === 0) return {};
  if (lines[0].indent !== 0) throw new Error(`line ${lines[0].lineNo}: top level must not be indented`);
  const [value, next] = parseMap(lines, 0, 0);
  if (next !== lines.length) throw new Error(`line ${lines[next].lineNo}: could not parse`);
  return value;
}

/**
 * Split a Markdown document into { data, body }. Throws when the file has no
 * frontmatter block or the block is invalid.
 */
function parseFrontmatter(text) {
  const normalized = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!m) throw new Error('missing YAML frontmatter (--- ... ---) at the top of the file');
  return { data: parseYaml(m[1]), body: normalized.slice(m[0].length) };
}

module.exports = { parseYaml, parseFrontmatter, parseScalar };

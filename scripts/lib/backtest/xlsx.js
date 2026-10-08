'use strict';

/**
 * Minimal, dependency-free Excel (.xlsx) reader for bar files: unzips the
 * workbook with Node's zlib and reads one worksheet's cells (numbers, shared
 * and inline strings, booleans, formula results). Excel stores dates as serial
 * day numbers; they are returned as numbers and the bar loader converts them
 * (see excelSerialToMs). Legacy .xls (binary) is not supported.
 */

const fs = require('fs');
const zlib = require('zlib');

/** { name: Buffer } for every file in a zip archive. */
function unzip(buf) {
  let eocd = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 65557); p -= 1) {
    if (buf.readUInt32LE(p) === 0x06054b50) { eocd = p; break; }
  }
  if (eocd < 0) throw new Error('not an .xlsx file (no zip directory); save the sheet as .xlsx');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let k = 0; k < count; k += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('xlsx: corrupt zip directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    if (method === 0) files[name] = raw;
    else if (method === 8) files[name] = zlib.inflateRawSync(raw);
    else throw new Error(`xlsx: zip compression method ${method} is not supported`);
  }
  return files;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
  });
}

/** Text of every <t> in an XML fragment (rich text runs joined). */
function textOf(xml) {
  let out = '';
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1];
  return unescapeXml(out);
}

function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Read a worksheet (default: the first) into { rows: [[cell...]], date1904 }.
 * Cells are numbers, strings, booleans, or null.
 */
function readXlsx(file, { sheet = null } = {}) {
  const files = unzip(fs.readFileSync(file));
  const xml = name => (files[name] ? files[name].toString('utf8') : null);
  const workbook = xml('xl/workbook.xml');
  if (!workbook) throw new Error('xlsx: no xl/workbook.xml (is this an Excel workbook?)');
  const date1904 = /<workbookPr[^>]*date1904="(1|true)"/.test(workbook);
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map(m => ({
    name: unescapeXml((/name="([^"]*)"/.exec(m[0]) || [])[1] || ''),
    rid: (/r:id="([^"]*)"/.exec(m[0]) || /\bid="([^"]*)"/.exec(m[0]) || [])[1],
  }));
  if (!sheets.length) throw new Error('xlsx: the workbook has no sheets');
  const chosen = sheet === null ? sheets[0] : sheets.find(s => s.name === sheet);
  if (!chosen) throw new Error(`xlsx: no sheet named "${sheet}" (sheets: ${sheets.map(s => s.name).join(', ')})`);
  const rels = xml('xl/_rels/workbook.xml.rels') || '';
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(r => r.includes(`Id="${chosen.rid}"`));
  let target = rel ? /Target="([^"]*)"/.exec(rel)[1] : 'worksheets/sheet1.xml';
  target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const sheetXml = xml(target);
  if (!sheetXml) throw new Error(`xlsx: worksheet ${target} is missing`);

  const shared = [];
  const sst = xml('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));

  const rows = [];
  for (const rm of sheetXml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row = [];
    const body = rm[1] || '';
    let next = 0;
    for (const cm of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const inner = cm[2] || '';
      const ref = (/\br="([A-Z]+\d+)"/.exec(attrs) || [])[1];
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      const type = (/\bt="([^"]*)"/.exec(attrs) || [])[1] || 'n';
      const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      let value;
      if (type === 's') value = v === undefined ? null : shared[Number(v)];
      else if (type === 'inlineStr') value = textOf(inner);
      else if (type === 'str') value = v === undefined ? null : unescapeXml(v);
      else if (type === 'b') value = v === '1';
      else if (type === 'e') value = null;
      else value = v === undefined || v === '' ? null : Number(v);
      row[col] = value;
    }
    rows.push(Array.from(row, x => (x === undefined ? null : x)));
  }
  return { rows, date1904 };
}

/** Excel serial date (days, fraction = time of day) to epoch ms, rounded to the second. */
function excelSerialToMs(serial, date1904 = false) {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return Math.round((epoch + serial * 86400000) / 1000) * 1000;
}

module.exports = { readXlsx, unzip, excelSerialToMs };

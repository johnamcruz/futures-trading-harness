'use strict';

// The scanner behind tests/plugin/no-platform-specifics.test.js: which lines of the repository name a
// platform, a firm, a firm's times or a model, what each shrink-only exception excuses (a hash per
// excused line), the verdict of those lines against the pins, of the pins against the base branch's,
// and the only update the pins allow (removing lines). Test infrastructure only.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** Forbidden terms, each with a sample that must be caught (the self-test checks every one). */
const TERMS = [
  { re: 'top[\\s-]?step', sample: 'Top Step' },
  { re: 'topstepx', sample: 'TopstepX' },
  { re: 'project[\\s-]?x', sample: 'Project-X' },
  { re: 'PROJECTX_', sample: 'PROJECTX_API_KEY' },
  { re: 'CON\\.F\\.', sample: 'CON.F.US.MNQ.Z26' },
  { re: 'auto oco', sample: 'Auto OCO' },
  { re: 'position brackets', sample: 'Position Brackets' },
  { re: 'gateway\\.docs', sample: 'gateway.docs' },
  { re: 'api\\.topstepx', sample: 'api.topstepx' },
  { re: 'userapi', sample: 'userapi' },
  { re: 'signalr', sample: 'SignalR' },
  { re: 'mlx', sample: 'mlx' },
  { re: 'mlx_lm', sample: 'mlx_lm' },
  { re: 'qwen[\\s-]?\\d', sample: 'Qwen 3' },
  { re: '\\b9B\\b', sample: '9B' },
  { re: 'dashscope', sample: 'DashScope' },
];
const FORBIDDEN = new RegExp(TERMS.map(t => t.re).join('|'), 'i');
/**
 * A model's size (Qwen 9B, a 70B model, 3.5B params): a `<number>B` within about 20 characters of a model
 * word, either side, so a trading setup like the 2B reversal never counts.
 */
const MODEL_WORD = '(?:models?|params|parameters|qwen|llama|gemma|mistral)';
const SIZE = '\\b\\d+(?:\\.\\d+)?B\\b';
const MODEL_SIZE = new RegExp(`${MODEL_WORD}[^\\n]{0,20}?${SIZE}|${SIZE}[^\\n]{0,20}?${MODEL_WORD}`, 'i');
/**
 * A firm's own times (its reset, its flatten), in any common form: 24-hour, 12-hour, 4-digit, with a
 * zone, a zone name or a city (17:00 CT, 5 pm Central, 1510 CST, 16:10 America/New_York): firm rules,
 * which belong in account files.
 */
const FIRM_ZONE = String.raw`[\s@]*(?:america\/)?(?:c[sd]?t|e[sd]?t|central|eastern|chicago|new[\s_]york)\b`;
const FIRM_TIME = new RegExp(String.raw`\b(?:15:10|16:10|17:00|3:10\s*pm|4:10\s*pm|5(?::00)?\s*pm|1510|1610)${FIRM_ZONE}`, 'i');

/** What a shrink-only entry excuses, by kind (a name, never a pattern, so the pins file names no firm). */
const KINDS = {
  firm: /\btopstep\b(?![x_])/gi, // the firm's name alone: never TopstepX, api.topstepx or an account name
  account: /\btopstep_(?:50k|100k|150k)\b/gi, // a shipped account's name
  'firm-time': new RegExp(FIRM_TIME.source, 'gi'),
};

const BINARY = /\.(?:xlsx|xls|parquet|png|jpe?g|gif|ico|pdf|zip|gz|woff2?|ttf)$/i;

/** Greek and Cyrillic letters that look Latin, folded to the Latin ones (Cyrillic a, Greek capital tau, ...). */
const CONFUSABLES = {
  '\u0430': 'a', '\u0432': 'B', '\u0435': 'e', '\u043a': 'k', '\u043c': 'M', '\u043d': 'H', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0442': 'T', '\u0443': 'y', '\u0445': 'x', '\u0455': 's', '\u0456': 'i', '\u0458': 'j',
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041a': 'K', '\u041c': 'M', '\u041d': 'H', '\u041e': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0425': 'X', '\u0405': 'S', '\u0406': 'I', '\u0408': 'J',
  '\u03b1': 'a', '\u03bf': 'o', '\u03c1': 'p', '\u03c4': 't', '\u03c5': 'u', '\u03bd': 'v', '\u03ba': 'k', '\u03b9': 'i', '\u03c7': 'x',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I', '\u039a': 'K', '\u039c': 'M', '\u039d': 'N', '\u039f': 'O', '\u03a1': 'P', '\u03a4': 'T', '\u03a5': 'Y', '\u03a7': 'X',
};
const CONFUSABLE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'gu');

/** NFKC, without format characters (zero-width joiners and the like), look-alike letters folded: spellings that only look different are caught. */
const normalize = s => s.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(CONFUSABLE, c => CONFUSABLES[c]);

/** Binary by extension, or a NUL byte in the first 8 KB; a text file is scanned whole. */
const isBinary = (file, buf) => BINARY.test(file) || buf.subarray(0, 8192).includes(0);

/** A line that names the exchange (CME, Globex) states its hours: an exchange fact, not a firm's rule. */
const EXCHANGE = /\b(?:CME|Globex)\b/i;
/** The exchange's own day boundary (17:00, 5 pm), the only time a line naming the exchange may state; a firm's flatten (15:10, 16:10, ...) stays an offence. */
const EXCHANGE_TIME = new RegExp(String.raw`\b(?:17:00|5(?::00)?\s*pm)${FIRM_ZONE}`, 'gi');
const offends = line => FORBIDDEN.test(line) || MODEL_SIZE.test(line) || FIRM_TIME.test(line);
const firstOffence = line => (line.match(FORBIDDEN) || line.match(MODEL_SIZE) || line.match(FIRM_TIME))[0];
const GUARD = { scanner: 'tests/plugin/platform-scan.js', pins: /^tests\/(?:.*\/)?[^/]*\.pins\.json$/ };
const key = e => `${e.file}|${e.kind}`;
/** A pinned line: the hash of its trimmed, normalized text. */
const lineHash = text => crypto.createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
/** `a` within `b`, counting repeats (sorted hash lists). */
function within(a, b) {
  const left = new Map();
  for (const h of b) left.set(h, (left.get(h) || 0) + 1);
  for (const h of a) {
    if (!left.get(h)) return false;
    left.set(h, left.get(h) - 1);
  }
  return true;
}

/** The repository's files: `git ls-files -co --exclude-standard`, split into files, symlinks, and what is neither. */
function listFiles(repo) {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  const listed = [...new Set(r.stdout.split('\0').filter(Boolean))];
  const excluded = listed.filter(f => /^node_modules(\/|$)/.test(f) || f === 'package-lock.json');
  const rest = listed.filter(f => !excluded.includes(f));
  const type = f => { try { const st = fs.lstatSync(path.join(repo, f)); return st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : 'other'; } catch (_err) { return 'missing'; } };
  // A tracked symlink (qwen-extension/ links the canonical folders) is not read through: its target is listed itself.
  return { listed, excluded, files: rest.filter(f => type(f) === 'file'), links: rest.filter(f => type(f) === 'link'), notFiles: rest.filter(f => !['file', 'link'].includes(type(f))) };
}

/**
 * Scan `files` with `read(file)` -> Buffer. `allowed` files are skipped whole; `permanent` lines ({ file,
 * pattern }) and shrink-only `entries` ({ file, kind }) excuse their matches. Returns the hits, what each
 * entry excused ({ lines, excused, hashes }), how often each permanent one was used, and which files were
 * scanned or skipped as binary.
 */
function scan(files, read, { allowed = [], permanent = [], entries = [] } = {}) {
  const hits = [];
  const actual = new Map(entries.map(e => [key(e), { lines: 0, excused: [], hashes: [] }]));
  const permanentUsed = new Map(permanent.map(p => [p, 0]));
  const scanned = [];
  const binary = [];
  for (const file of files) {
    if (allowed.some(re => re.test(file))) { scanned.push(file); continue; }
    if (offends(normalize(file))) hits.push(`${file}: the path names a platform, firm or model`);
    const buf = read(file);
    if (isBinary(file, buf)) { binary.push(file); continue; }
    scanned.push(file);
    const perm = permanent.filter(p => p.file === file);
    const own = entries.filter(e => e.file === file);
    normalize(buf.toString('utf8')).split('\n').forEach((text, i) => {
      // An escaped newline or tab in a string (JSON, code) separates words as the real one does.
      let line = text.replace(/\\[ntr]/g, ' ');
      if (!offends(line)) return;
      // The exchange's own hours on a line that names it are facts, never a firm's time to pin.
      if (EXCHANGE.test(line)) line = line.replace(EXCHANGE_TIME, '');
      for (const p of perm) {
        const rest = line.replace(new RegExp(p.pattern.source, 'g'), '');
        if (rest !== line) permanentUsed.set(p, permanentUsed.get(p) + 1);
        line = rest;
      }
      for (const e of own) {
        const rest = line.replace(KINDS[e.kind], '');
        if (rest !== line) {
          const a = actual.get(key(e));
          a.lines += 1;
          a.excused.push(text.trim());
          a.hashes.push(lineHash(text));
        }
        line = rest;
      }
      if (offends(line)) hits.push(`${file}:${i + 1}: ${firstOffence(line)} in "${text.trim().slice(0, 120)}"`);
    });
  }
  for (const a of actual.values()) a.hashes.sort();
  return { hits, actual, permanentUsed, scanned, binary };
}

/**
 * The shrink-only verdict: problems with the entries and the lines they excuse against the pins
 * ({ "file|kind": [line hashes] }). A new key, a new or changed excused line, a duplicate, an entry that
 * excuses nothing, or a permanent exception never used fails; a line gone fails until the pins record it
 * (FTH_UPDATE_PINS=1). No message gives a hash to paste.
 */
function pinVerdict(entries, actual, pins, permanentUsed = new Map()) {
  const problems = [];
  const seen = new Set();
  for (const e of entries) {
    const k = key(e);
    if (seen.has(k)) problems.push(`${k}: listed twice`);
    seen.add(k);
    if (!KINDS[e.kind]) problems.push(`${k}: unknown kind`);
    if (!e.reason || !/^plan [A-Z]\b|removal PR/.test(String(e.plan))) problems.push(`${k}: needs a reason and the plan that removes it`);
    const a = actual.get(k) || { lines: 0, hashes: [] };
    const pin = pins[k];
    if (!pin) { problems.push(`${k}: a new exception (the list may only shrink)`); continue; }
    if (a.lines === 0) problems.push(`${k}: excuses nothing: remove the entry (FTH_UPDATE_PINS=1 removes its pin)`);
    else if (!within(a.hashes, pin)) problems.push(`${k}: an excused line is new or changed (${a.lines} lines, ${pin.length} pinned): the list may only shrink`);
    else if (a.hashes.length < pin.length) problems.push(`${k}: ${pin.length - a.hashes.length} pinned line(s) gone: record it with FTH_UPDATE_PINS=1`);
  }
  for (const k of Object.keys(pins)) if (!seen.has(k)) problems.push(`${k}: pinned but not listed: remove the pin`);
  for (const [p, n] of permanentUsed) if (n === 0) problems.push(`${p.file}: its permanent exception (${p.reason}) matches nothing: remove it`);
  return problems;
}

/**
 * The only update the pins allow: lines removed. A key keeps the lines it still excuses when they are
 * within its pinned ones (else it stays as it was, and the verdict fails); a key that excuses nothing
 * goes. A key is never added and a line never gained.
 */
function updatePins(pins, actual) {
  const out = {};
  for (const [k, pin] of Object.entries(pins)) {
    const a = actual.get(k);
    if (!a || a.lines === 0) continue;
    out[k] = within(a.hashes, pin) ? [...a.hashes] : pin;
  }
  return out;
}

/**
 * The pins against the base branch's: every key in the base, every line within the base's. The base
 * may lack the pins only when it lacks the rule's test too (the change that brings the rule).
 */
function baseVerdict(pins, base) {
  if (base === null) return [];
  const problems = [];
  for (const [k, pin] of Object.entries(pins)) {
    if (!base[k]) problems.push(`${k}: not pinned on the base branch: the list may only shrink`);
    else if (!within(pin, base[k])) problems.push(`${k}: a line not pinned on the base branch (${pin.length} pinned, ${base[k].length} on the base): the list may only shrink`);
  }
  return problems;
}

/**
 * The pins file at `git merge-base HEAD <ref>` (origin/main). Null only when the base has no guard at all
 * (no scanner, no `*.pins.json` anywhere under tests/, no rule's test: the change that brings the rule).
 * Throws (fail closed) when the base can't be read, or has a guard but not the pins at `pinsRel` (a
 * rename or a deletion would otherwise switch the check off).
 */
function readBasePins(repo, pinsRel, testRel, ref = 'origin/main') {
  const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  const mb = git(['merge-base', 'HEAD', ref]);
  if (mb.status !== 0) throw new Error(`the base branch can't be read (git merge-base HEAD ${ref}: ${mb.stderr.trim() || mb.status}): fetch ${ref} (CI: actions/checkout fetch-depth: 0)`);
  const base = mb.stdout.trim();
  const tree = git(['ls-tree', '-r', '--name-only', base, 'tests/']);
  if (tree.status !== 0) throw new Error(`the base's tests/ can't be listed: ${tree.stderr.trim()}`);
  const names = tree.stdout.split('\n').filter(Boolean);
  const guards = names.filter(n => n === GUARD.scanner || n === testRel || GUARD.pins.test(n));
  if (guards.length === 0) return null;
  if (!names.includes(pinsRel)) throw new Error(`the base ${base.slice(0, 12)} has ${guards.join(', ')} but no ${pinsRel}: the guard was renamed or removed; can't check the pins only shrink`);
  const shown = git(['show', `${base}:${pinsRel}`]);
  if (shown.status !== 0) throw new Error(`the base's ${pinsRel} can't be read: ${shown.stderr.trim()}`);
  return JSON.parse(shown.stdout);
}

module.exports = { GUARD, TERMS, FORBIDDEN, MODEL_SIZE, FIRM_TIME, EXCHANGE, EXCHANGE_TIME, KINDS, normalize, isBinary, listFiles, scan, pinVerdict, updatePins, baseVerdict, readBasePins, key, lineHash, within };

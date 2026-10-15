'use strict';

/**
 * A training-loop proposal (docs/LEARNED-RULEBOOK.md R24, R25 step 2): a small, structured diff against the
 * canonical documents the agent runs on, never code. The proposer (an LLM) writes one per line of its reply:
 *
 *   PROPOSAL {"targets":["wrong stated reason"],"expects":"...","why":"...","edits":[{"file":"skills/x/SKILL.md","find":"...","replace":"..."}]}
 *
 * - targets: the failure categories it means to fix (the scorecard's, R25), at least one;
 * - expects: the effect it expects, in one sentence; why: the flagged decisions it read;
 * - edits: 1 to MAX_EDITS exact replacements, each `find` found exactly once in its file when applied.
 *
 * Only these files: a skill's SKILL.md (not the loop's own skills), a strategy's STRATEGY.md (never its
 * `name:` or `status:` line, nor any LOCKED_KEYS value however the edit is worded: a status flip is the owner's
 * decision, R33), a rulebook (accounts/<account>/RULEBOOK.md; never ACCOUNT.md).
 * Never code, accounts (firm rules), agents, rules, commands, generated adapters, or the promotion gate.
 *
 *   parseProposals(output)              [{ proposal } | { error, line }] from PROPOSAL lines
 *   validateProposal(p, { root })       [error]: empty when it may be applied to the tree at root
 *   applyProposal(p, dir)               edits applied in the tree at dir (validated first); returns the files changed
 *   proposalId(p)                       a short digest of its targets and edits: the same change is the same id
 *   isMechanical(p)                     it touches a strategy or a rulebook (screened by the evaluator first, R28)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CATEGORIES } = require('../replay/scorecard');
const { parseFrontmatter } = require('../frontmatter');
const { rulebookErrors } = require('./rulebook-guard');

const FAILURES = Object.freeze(CATEGORIES.filter(c => c !== 'right' && c !== 'unchecked'));
const PROP = require('../tunables').training().proposal; // config/training.json proposal (each only falls)
const MAX_EDITS = PROP.maxEdits;
const MAX_TEXT = PROP.maxText;
const MAX_CHANGED = PROP.maxChanged;
// The loop's own skills (training-verdict is the training-loop skill's verdict, split out): never a proposal's to edit.
const LOOP_SKILLS = Object.freeze(['training-loop', 'training-verdict', 'design-self-review']);
const ALLOWED = Object.freeze([
  { re: /^skills\/([a-z0-9-]+)\/SKILL\.md$/, kind: 'skill' },
  { re: /^strategies\/([a-z0-9_]+)\/STRATEGY\.md$/, kind: 'strategy' },
  // The rulebook beside its account (section 10 step 7): never the account's ACCOUNT.md (firm rules).
  { re: /^accounts\/([a-z0-9_]+)\/RULEBOOK\.md$/, kind: 'rulebook' },
]);
const LOCKED_KEY = /^\s*(name|status)\s*:/m;
// A strategy's keys a proposal never changes: its identity, status and kind, and a policy's account, sizing,
// contracts, exit, markets, timeframe and component list, the regime gate and the risk block (the owner's, or the rulebook's, R1).
const LOCKED_KEYS = Object.freeze(['name', 'status', 'signal', 'account', 'sizing', 'contracts', 'exit', 'instruments', 'timeframe', 'strategies', 'regime_gate', 'risk']);

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const str = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;

/** Every string inside a JSON value (a harness's JSON events carry the model's text inside them). */
function stringsIn(x, out = []) {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) x.forEach(v => stringsIn(v, out));
  else if (x && typeof x === 'object') Object.values(x).forEach(v => stringsIn(v, out));
  return out;
}

/** PROPOSAL lines in the output: plain lines, or lines inside the strings of a harness's JSON events; each once. */
function parseProposals(output) {
  const lines = [];
  for (const line of String(output || '').split('\n')) {
    lines.push(line);
    const t = line.trim();
    if (!/^[[{]/.test(t)) continue;
    try {
      for (const s of stringsIn(JSON.parse(t))) lines.push(...s.split('\n'));
    } catch (_err) { /* not JSON: a plain line */ }
  }
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const m = /^\s*PROPOSAL\s+(\{.*\})\s*$/.exec(line);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    try {
      out.push({ proposal: JSON.parse(m[1]), raw: m[1] });
    } catch (err) {
      out.push({ error: `not JSON: ${err.message}`, line: line.slice(0, 300), raw: m[1] });
    }
  }
  return out;
}

/** The kind of a file a proposal may edit, or null. */
function kindOf(file) {
  if (typeof file !== 'string' || file.includes('\\') || path.isAbsolute(file) || file.split('/').some(p => p === '..' || p === '.' || p === '')) return null;
  for (const a of ALLOWED) {
    const m = a.re.exec(file);
    if (m && !(a.kind === 'skill' && LOOP_SKILLS.includes(m[1]))) return a.kind;
  }
  return null;
}

function countOf(text, find) {
  let n = 0;
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + 1)) n += 1;
  return n;
}

/** Errors in the proposal against the tree at root (each edit applied in order, as applyProposal does). */
function validateProposal(p, { root }) {
  const errors = [];
  if (!isObj(p)) return ['a proposal is a JSON object'];
  const extra = Object.keys(p).filter(k => !['targets', 'expects', 'why', 'edits'].includes(k));
  if (extra.length) errors.push(`unknown keys: ${extra.join(', ')}`);
  if (!Array.isArray(p.targets) || !p.targets.length || !p.targets.every(t => FAILURES.includes(t))) errors.push(`targets: one or more of ${FAILURES.join(', ')}`);
  if (!str(p.expects, 300)) errors.push('expects: the effect it expects, one sentence (up to 300 characters)');
  if (p.why !== undefined && !(typeof p.why === 'string' && p.why.length <= 1000)) errors.push('why: up to 1000 characters');
  if (!Array.isArray(p.edits) || !p.edits.length || p.edits.length > MAX_EDITS) return [...errors, `edits: 1 to ${MAX_EDITS}`];
  const texts = new Map();
  const originals = new Map();
  let changed = 0;
  p.edits.forEach((e, i) => {
    const at = `edits[${i}]`;
    if (!isObj(e) || Object.keys(e).some(k => !['file', 'find', 'replace'].includes(k))) { errors.push(`${at}: { file, find, replace }`); return; }
    const kind = kindOf(e.file);
    if (!kind) { errors.push(`${at}.file: ${String(e.file)} is not a document a proposal may edit (a skill, a strategy or a rulebook; not the loop's own skills, never code)`); return; }
    if (!str(e.find, MAX_TEXT) || typeof e.replace !== 'string' || e.replace.length > MAX_TEXT) { errors.push(`${at}: find (non-empty) and replace, up to ${MAX_TEXT} characters each`); return; }
    if (e.find === e.replace) { errors.push(`${at}: replace equals find`); return; }
    if (kind === 'strategy' && (LOCKED_KEY.test(e.find) || LOCKED_KEY.test(e.replace))) { errors.push(`${at}: a strategy's name or status line is the owner's to change, never a proposal's`); return; }
    const abs = path.join(root, e.file);
    let text = texts.get(e.file);
    if (text === undefined) {
      try {
        if (fs.lstatSync(abs).isSymbolicLink()) throw new Error('a symbolic link');
        const real = fs.realpathSync(abs);
        if (!real.startsWith(`${fs.realpathSync(root)}${path.sep}`)) throw new Error('outside the tree');
        text = fs.readFileSync(abs, 'utf8');
        originals.set(e.file, text);
      } catch (err) {
        errors.push(`${at}.file: ${e.file}: ${err.code === 'ENOENT' ? 'no such file' : err.message}`);
        return;
      }
    }
    const n = countOf(text, e.find);
    if (n !== 1) { errors.push(`${at}.find: found ${n} times in ${e.file}; exactly once`); return; }
    texts.set(e.file, text.replace(e.find, () => e.replace));
    changed += Math.max(e.find.length, e.replace.length);
  });
  if (changed > MAX_CHANGED) errors.push(`a small diff: ${changed} characters changed, at most ${MAX_CHANGED}`);
  // A strategy's owner-held keys, compared parsed before and after (however the edit is worded).
  for (const [file, after] of texts) {
    // A rulebook: valid after the edit, and only tightened, key by key (train/rulebook-guard.js).
    if (kindOf(file) === 'rulebook') { errors.push(...rulebookErrors(file, originals.get(file), after)); continue; }
    if (kindOf(file) !== 'strategy') continue;
    let a;
    let b;
    try {
      a = parseFrontmatter(originals.get(file)).data;
      b = parseFrontmatter(after).data;
    } catch (err) {
      errors.push(`${file}: the frontmatter no longer parses after the edit (${err.message})`);
      continue;
    }
    const moved = LOCKED_KEYS.filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    if (moved.length) errors.push(`${file}: ${moved.join(', ')} ${moved.length > 1 ? 'are' : 'is'} the owner's to change, never a proposal's`);
  }
  return errors;
}

function applyProposal(p, dir) {
  const errors = validateProposal(p, { root: dir });
  if (errors.length) throw new Error(`proposal refused:\n- ${errors.join('\n- ')}`);
  const files = [];
  for (const e of p.edits) {
    const abs = path.join(dir, e.file);
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace(e.find, () => e.replace));
    if (!files.includes(e.file)) files.push(e.file);
  }
  return files;
}

function proposalId(p) {
  const body = JSON.stringify({ targets: [...(p.targets || [])].sort(), edits: (p.edits || []).map(e => [e.file, e.find, e.replace]) });
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
}

const isMechanical = p => (p.edits || []).some(e => ['strategy', 'rulebook'].includes(kindOf(e.file)));

module.exports = { FAILURES, MAX_EDITS, LOOP_SKILLS, LOCKED_KEYS, parseProposals, validateProposal, applyProposal, proposalId, isMechanical, kindOf };

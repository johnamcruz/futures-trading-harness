'use strict';

/**
 * Golden files for the regression tests (test infrastructure only): a test renders what the harness
 * produced (decisions, the text the model sees, gate verdicts, cache keys) as text and compares it with
 * its golden under tests/fixtures/golden/. Any difference fails, with the changed lines and how to update.
 *
 * Goldens change only on purpose, through the flag the CLI snapshots already use:
 *   FTH_UPDATE_SNAPSHOTS=1 node --test <the test file>
 * then review `git diff tests/fixtures/golden/` and explain every changed line in the pull request.
 * A missing golden fails (it is never created by a plain run), and with CI or GITHUB_ACTIONS set the flag is
 * refused (here and in tests/scripts/cli-parity.test.js), so a CI run can never write or accept a golden.
 *
 * Golden text is neutral: what the platform scan forbids (tests/plugin/platform-scan.js: a platform, firm or
 * model name, a model size, a firm's time) is replaced before comparing with a placeholder of its kind and a
 * hash of the exact text (<name-1a2b3c>, <firm-time-...>, <model-...>: distinct texts stay distinct), and
 * temporary directories with <tmp>, so a golden never names what the repository may not.
 *
 *   assertGolden(name, text)                 fails the test unless text equals the golden
 *   checkGolden(name, text, { dir, env })    { ok, message, wrote }: the same, as a value
 *   updateRefused(env)                       why the update flag is refused here (CI or GITHUB_ACTIONS set), or null
 *   neutral(text)                            the text as a golden holds it
 *   lineDiff(expected, actual)               the first changed lines, numbered
 */

const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FORBIDDEN, MODEL_SIZE, FIRM_TIME } = require('./plugin/platform-scan');

const GOLDEN_DIR = path.join(__dirname, 'fixtures', 'golden');
const FLAG = 'FTH_UPDATE_SNAPSHOTS';
const global = re => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
// The temporary directory by its real path first (macOS: /private/var/... holds /var/...).
/**
 * Every spelling of the temporary directory, read at each call: os.tmpdir() and TMPDIR as given (a doubled slash
 * kept, a trailing one dropped), normalized, and by real path (macOS: /private/var/... holds /var/..., /private/tmp holds
 * /tmp), longest first so a real path is masked before the shorter form inside it.
 */
function tmpRoots(env = process.env) {
  const out = new Set();
  for (const raw of [os.tmpdir(), env.TMPDIR, env.TMP, env.TEMP]) {
    if (!raw) continue;
    // Never with a trailing slash: the directory a test made under it keeps its own (<tmp>/<dir>).
    const forms = [raw.replace(/\/+$/, ''), path.resolve(raw)];
    try { forms.push(fs.realpathSync(raw)); } catch (_err) { /* gone: its spellings still mask */ }
    for (const f of forms) if (f && f !== path.sep) out.add(f);
  }
  return [...out].sort((x, y) => y.length - x.length);
}

// A forbidden name with the rest of its word (a suffixed account name stays apart from the bare name).
const NAME = new RegExp(`(?:${FORBIDDEN.source})[A-Za-z0-9_]*`, 'gi');
/** A placeholder per distinct text: its kind and a hash of the exact text, so two names or two times never merge. */
const tag = kind => m => `<${kind}-${crypto.createHash('sha256').update(m).digest('hex').slice(0, 6)}>`;

/** The text as a golden holds it: platform-neutral, no temporary paths, one trailing newline. */
function neutral(text) {
  let out = String(text);
  for (const dir of tmpRoots()) out = out.split(dir).join('<tmp>');
  // The directory a test made under it (an fth home, a run home), whatever its name: one placeholder.
  out = out.replace(/<tmp>\/+(?!<dir>)[^/\s"'`)\]<>,;]+/g, '<tmp>/<dir>');
  out = out.replace(global(FIRM_TIME), tag('firm-time')).replace(NAME, tag('name')).replace(global(MODEL_SIZE), tag('model'));
  return out.endsWith('\n') ? out : `${out}\n`;
}

/**
 * The changed block, between the lines both share at the start and at the end: the golden's lines (-) and
 * the new ones (+), numbered, at most `max` of each. An inserted or removed line shows as itself, not as
 * every line after it.
 */
function lineDiff(expected, actual, { max = 30 } = {}) {
  const a = String(expected).split('\n');
  const b = String(actual).split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const gone = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const show = (lines, sign) => [
    ...lines.slice(0, max).map((l, k) => `  line ${head + k + 1} ${sign} ${l}`),
    ...(lines.length > max ? [`  ... and ${lines.length - max} more ${sign} lines`] : []),
  ];
  return [`  (${a.length} lines in the golden, ${b.length} now; the first change at line ${head + 1})`, ...show(gone, '-'), ...show(added, '+')].join('\n');
}

/** Why an update is refused here (the flag set on CI: CI or GITHUB_ACTIONS), or null. */
function updateRefused(env = process.env) {
  if (env[FLAG] !== '1') return null;
  const ci = ['CI', 'GITHUB_ACTIONS'].find(k => env[k] && env[k] !== 'false');
  return ci ? `${FLAG}=1 is refused with ${ci} set: goldens and snapshots are regenerated on purpose, locally, never by CI` : null;
}

const how = file => `If the change is intended, regenerate with ${FLAG}=1 node --test <this test file>, review git diff ${path.relative(path.join(__dirname, '..'), file)}, and explain every changed line in the pull request.`;

function checkGolden(name, text, { dir = GOLDEN_DIR, env = process.env } = {}) {
  const file = path.join(dir, name);
  const actual = neutral(text);
  if (env[FLAG] === '1') {
    const refused = updateRefused(env);
    if (refused) return { ok: false, wrote: false, message: refused };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, actual);
    return { ok: true, wrote: true, message: '' };
  }
  let expected;
  try {
    expected = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { ok: false, wrote: false, message: `golden ${name} is missing (${file}): it is never created by a test run. Create it on purpose with ${FLAG}=1 node --test <this test file> and commit it.` };
  }
  if (expected === actual) return { ok: true, wrote: false, message: '' };
  return { ok: false, wrote: false, message: `golden ${name} differs from what the harness produces now:\n${lineDiff(expected, actual)}\n${how(file)}` };
}

function assertGolden(name, text, opts) {
  const r = checkGolden(name, text, opts);
  if (!r.ok) assert.fail(r.message);
}

module.exports = { tmpRoots, GOLDEN_DIR, FLAG, neutral, lineDiff, updateRefused, checkGolden, assertGolden };

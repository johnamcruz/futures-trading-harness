'use strict';

// The rulebook is robust: no incomplete, missing or malformed rulebook ever removes a protection unseen.
// For every key of every shipped RULEBOOK.md (each nested key and list entry), a variant removes it, and others set
// it to an empty string, a negative number, text, or 0, and add an unknown key beside it. Each variant must be
// refused (the account or the policy, with a message naming the key), or load limits identical to or stricter
// than the shipped ones: never looser. Then: nothing enforced takes a code default.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const RB = require('../../scripts/lib/trading/rulebook');
const { SIZING_KEYS, sizingErrors } = require('../../scripts/lib/trading/combine');
const { loadAccounts } = require('../../scripts/lib/trading/accounts');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
const { tmpDir } = require('../helpers');
const { entryLooser } = require('../../scripts/lib/train/rulebook-guard');

const ROOT = path.resolve(__dirname, '..', '..');
const ACCOUNTS = fs.readdirSync(path.join(ROOT, 'accounts')).filter(d => fs.existsSync(path.join(ROOT, 'accounts', d, RB.FILE)));
const SHIPPED_POLICIES = loadStrategies(ROOT, {}).strategies.filter(s => s.signal === 'policy');

/** YAML for the frontmatter subset the parser reads: maps by indentation, lists inline or of maps, scalars. */
function yaml(value, indent = '') {
  const scalar = v => (typeof v === 'string' ? JSON.stringify(v) : String(v));
  const out = [];
  for (const [k, v] of Object.entries(value)) {
    if (Array.isArray(v)) {
      if (v.every(x => x === null || typeof x !== 'object')) out.push(`${indent}${k}: [${v.map(scalar).join(', ')}]`);
      else {
        out.push(`${indent}${k}:`);
        for (const item of v) {
          const lines = yaml(item, `${indent}    `).split('\n');
          out.push(`${indent}  - ${lines[0].trimStart()}`, ...lines.slice(1));
        }
      }
    } else if (v && typeof v === 'object') {
      out.push(`${indent}${k}:`, yaml(v, `${indent}  `));
    } else out.push(`${indent}${k}: ${scalar(v)}`);
  }
  return out.filter(l => l !== '').join('\n');
}

/** Every path into the data: [path, kind] for map keys and list entries. */
function paths(v, at = []) {
  const out = [];
  if (Array.isArray(v)) v.forEach((x, i) => { out.push([[...at, i], 'entry']); out.push(...paths(x, [...at, i])); });
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push([[...at, k], 'key']); out.push(...paths(x, [...at, k])); }
  return out;
}
const clone = x => JSON.parse(JSON.stringify(x));
function edit(data, at, fn) {
  const d = clone(data);
  let o = d;
  for (const k of at.slice(0, -1)) o = o[k];
  fn(o, at[at.length - 1]);
  return d;
}

/** Variants of one rulebook's data: [label, data]. */
function variants(data) {
  const out = [];
  for (const [at, kind] of paths(data)) {
    const label = at.join('.');
    out.push([`${label} removed`, edit(data, at, (o, k) => (Array.isArray(o) ? o.splice(k, 1) : delete o[k]))]);
    for (const bad of ['', -1, 'abc', 0]) out.push([`${label} = ${JSON.stringify(bad)}`, edit(data, at, (o, k) => { o[k] = bad; })]);
    if (kind === 'key') {
      const parent = at.slice(0, -1);
      out.push([`${label}: an unknown key beside it`, edit(data, [...parent, 'zz_unknown'], (o, k) => { o[k] = 1; })]);
    }
  }
  out.push(['an unknown top-level key', { ...clone(data), zz_unknown: 1 }]);
  return out;
}

// Each limit as the code reads it, as a size: the larger, the looser. off (0) is no limit at all.
const none = v => (v > 0 ? v : Infinity);
const LOOSER = {
  cushion_frac: (n, o) => n > o,
  cap_usd: (n, o) => none(n) > none(o),
  drawdown_halve_usd: (n, o) => none(n) > none(o),
  clock_k: (n, o) => none(n) > none(o),
  r_per_session: (n, o, s) => n < o && none(s.clock_k) !== Infinity,
  min_size_guard: (n, o) => n > o,
  stop_slippage_ticks: (n, o) => n < o,
};

/** What a variant loads compared with the shipped load: 'refused', 'stricter', 'identical', or the looser limits. */
function judge(root, account, shipped) {
  const a = loadAccounts(root, {}).accounts.find(x => x.name === account);
  if (!a || !a.valid) return { verdict: 'refused', why: a ? a.errors : ['not found'] };
  const looser = [];
  const pinned = [];
  let stricter = a.daily_loss_soft !== shipped.account.daily_loss_soft;
  if (none(a.daily_loss_soft) > none(shipped.account.daily_loss_soft)) looser.push(`daily_loss_soft ${a.daily_loss_soft}`);
  // The loss streak stop: more losses in a row before the session stops (or off) is looser.
  if (a.loss_streak_stop !== shipped.account.loss_streak_stop) stricter = true;
  if (none(a.loss_streak_stop) > none(shipped.account.loss_streak_stop)) looser.push(`loss_streak_stop ${a.loss_streak_stop}`);
  const policies = loadStrategies(root, {}).strategies.filter(s => s.signal === 'policy' && s.account === account);
  let refused = false;
  for (const old of shipped.policies) {
    const p = policies.find(x => x.name === old.name);
    if (!p || !p.valid) { refused = true; continue; }
    for (const k of SIZING_KEYS) {
      if (p.sizing[k] === old.sizing[k]) continue;
      if (LOOSER[k](p.sizing[k], old.sizing[k], p.sizing)) looser.push(`${p.name}.sizing.${k} ${p.sizing[k]}`);
      else stricter = true;
    }
    if (JSON.stringify(p.exit) !== JSON.stringify(old.exit)) looser.push(`${p.name}.exit ${JSON.stringify(p.exit)} (a changed trail is never "stricter")`);
    if (JSON.stringify(p.multipliers) !== JSON.stringify(old.multipliers)) stricter = true;
    // The entry rule: a dropped bias frame or bias_agree moved to a looser mode loads valid but looser; the shipped-entry pin
    // (tests/plugin/rulebook.test.js) refuses shipping it and the rulebook guard a proposal, so it is reported apart.
    const el = entryLooser(`${p.name}.entry`, old.entry, p.entry);
    if (el.length) pinned.push(...el);
    else if (JSON.stringify(p.entry) !== JSON.stringify(old.entry)) stricter = true;
  }
  if (looser.length) return { verdict: 'looser', why: looser };
  if (pinned.length) return { verdict: 'pinned', why: pinned };
  return { verdict: refused ? 'refused' : stricter ? 'stricter' : 'identical' };
}

test('fuzz: every key of every shipped rulebook removed, emptied, negative, text, 0, or beside an unknown key - refused or stricter, never looser', t => {
  const counts = { tried: 0, refused: 0, stricter: 0, identical: 0, pinned: 0 };
  const pinnedLabels = [];
  const bad = [];
  for (const account of ACCOUNTS) {
    const root = tmpDir();
    fs.cpSync(path.join(ROOT, 'accounts'), path.join(root, 'accounts'), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'strategies'), path.join(root, 'strategies'));
    const file = path.join(root, 'accounts', account, RB.FILE);
    const text = fs.readFileSync(file, 'utf8');
    const { data, body } = parseFrontmatter(text);
    // Written back by the writer, the shipped file loads as shipped (so each variant differs only where it says).
    fs.writeFileSync(file, `---\n${yaml(data)}\n---\n${body}`);
    const shipped = {
      account: loadAccounts(root, {}).accounts.find(a => a.name === account),
      policies: loadStrategies(root, {}).strategies.filter(s => s.signal === 'policy' && s.account === account),
    };
    assert.ok(shipped.account.valid, shipped.account.errors.join());
    assert.deepStrictEqual(shipped.policies.map(p => [p.name, p.valid, p.sizing]), SHIPPED_POLICIES.filter(p => p.account === account).map(p => [p.name, p.valid, p.sizing]));
    for (const [label, d] of variants(data)) {
      fs.writeFileSync(file, `---\n${yaml(d)}\n---\n${body}`);
      const r = judge(root, account, shipped);
      counts.tried += 1;
      if (r.verdict === 'looser') bad.push(`${account}: ${label}: loads looser (${r.why.join(', ')})`);
      else counts[r.verdict] += 1;
      if (r.verdict === 'pinned') pinnedLabels.push(label);
      if (r.verdict === 'identical') bad.push(`${account}: ${label}: loads as shipped, so the change went unseen`);
    }
    fs.writeFileSync(file, text);
  }
  t.diagnostic(`rulebook fuzz: ${JSON.stringify(counts)}`);
  assert.deepStrictEqual(bad, []);
  assert.ok(counts.tried > 300, JSON.stringify(counts));
  assert.strictEqual(counts.tried, counts.refused + counts.stricter + counts.pinned, JSON.stringify(counts));
  // Only a bias frame dropped loads looser and valid: each one the shipped-entry pin and the guard refuse.
  for (const l of pinnedLabels) assert.match(l, /\.entry\.bias_frames\.\d+ removed$/, l);
});

test('fuzz: the writer and the judge catch what they claim (a looser load is reported)', () => {
  const root = tmpDir();
  fs.cpSync(path.join(ROOT, 'accounts'), path.join(root, 'accounts'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'strategies'), path.join(root, 'strategies'));
  const policy = SHIPPED_POLICIES[0];
  const file = path.join(root, 'accounts', policy.account, RB.FILE);
  const shipped = {
    account: loadAccounts(root, {}).accounts.find(a => a.name === policy.account),
    policies: loadStrategies(root, {}).strategies.filter(s => s.signal === 'policy' && s.account === policy.account),
  };
  assert.strictEqual(judge(root, policy.account, shipped).verdict, 'identical');
  const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  const write = d => fs.writeFileSync(file, `---\n${yaml(d)}\n---\n${body}`);
  write(edit(data, ['policies', policy.name, 'sizing', 'cushion_frac'], (o, k) => { o[k] = 0.9; }));
  assert.strictEqual(judge(root, policy.account, shipped).verdict, 'looser');
  write(edit(data, ['daily_loss_soft'], (o, k) => { o[k] = 'off'; }));
  assert.strictEqual(judge(root, policy.account, shipped).verdict, 'looser');
  write(edit(data, ['loss_streak_stop'], (o, k) => { o[k] = 'off'; }));
  assert.strictEqual(judge(root, policy.account, shipped).verdict, 'looser');
  write(edit(data, ['loss_streak_stop'], (o, k) => { o[k] = shipped.account.loss_streak_stop + 1; }));
  assert.strictEqual(judge(root, policy.account, shipped).verdict, 'looser');
  write(edit(data, ['policies', policy.name, 'exit', 'mode'], (o, k) => { o[k] = 'trail'; }));
  assert.strictEqual(judge(root, policy.account, shipped).verdict, 'refused', 'mode trail without a trail in R');
  // The shipped bias_agree (neutral-15m-declared) is its loosest mode: off and on are stricter; a dropped frame is looser.
  for (const v of ['off', 'on']) {
    write(edit(data, ['policies', policy.name, 'entry', 'bias_agree'], (o, k) => { o[k] = v; }));
    assert.strictEqual(judge(root, policy.account, shipped).verdict, 'stricter', `bias_agree ${v}: stricter`);
  }
  write(edit(data, ['policies', policy.name, 'entry', 'bias_frames'], (o, k) => { o[k] = ['4h']; }));
  assert.strictEqual(judge(root, policy.account, shipped).verdict, 'pinned', 'a dropped bias frame: looser, held by the pin');
  write(edit(data, ['policies', policy.name, 'sizing', 'cushion_frac'], (o, k) => { o[k] = 0.01; }));
  assert.strictEqual(judge(root, policy.account, shipped).verdict, 'stricter');
  write(edit(data, ['policies', policy.name, 'sizing', 'cap_usd'], (o, k) => { o[k] = 0; }));
  assert.strictEqual(judge(root, policy.account, shipped).verdict, 'refused');
});

test('nothing enforced takes a code default: every enforced value the code reads comes from the rulebook file as written', () => {
  for (const account of ACCOUNTS) {
    const file = path.join(ROOT, 'accounts', account, RB.FILE);
    const raw = parseFrontmatter(fs.readFileSync(file, 'utf8')).data;
    assert.ok(raw.enforced.includes('daily_loss_soft') && raw.daily_loss_soft !== undefined, `${file}: daily_loss_soft`);
    const a = loadAccounts(ROOT, {}).accounts.find(x => x.name === account);
    assert.strictEqual(a.daily_loss_soft, RB.limit(raw.daily_loss_soft), `${account}: the soft stop is the rulebook's`);
    assert.ok(raw.enforced.includes('loss_streak_stop') && raw.loss_streak_stop !== undefined, `${file}: loss_streak_stop`);
    assert.strictEqual(a.loss_streak_stop, RB.limit(raw.loss_streak_stop), `${account}: the loss streak stop is the rulebook's`);
    for (const [name, entry] of Object.entries(raw.policies || {})) {
      const p = SHIPPED_POLICIES.find(x => x.name === name);
      // Every sizing key the code reads (combine.js SIZING_KEYS) is written in the file: there is no code default.
      assert.deepStrictEqual(Object.keys(entry.sizing).sort(), [...SIZING_KEYS].sort(), `${file}: ${name}.sizing states every key`);
      assert.deepStrictEqual(p.sizing, Object.fromEntries(Object.entries(entry.sizing).map(([k, v]) => [k, RB.limit(v)])), `${name}: loaded as written`);
      assert.deepStrictEqual(sizingErrors(p.sizing), [], `${name}: a whole sizing, as the code requires`);
      // Every exit key written (the mode and both trail values, `off` included); loaded as the rulebook reads it.
      assert.deepStrictEqual(Object.keys(entry.exit).sort(), [...RB.EXIT_KEYS].sort(), `${file}: ${name}.exit states every key`);
      assert.deepStrictEqual(p.exit, RB.policyEntry(raw, name).exit, `${name}: the exit as written`);
      assert.strictEqual(p.exit.mode, entry.exit.mode, `${name}: the exit mode as written`);
      assert.ok(Array.isArray(entry.multipliers), `${file}: ${name}.multipliers stated`);
      assert.deepStrictEqual(p.multipliers, entry.multipliers, `${name}: multipliers as written`);
    }
  }
});

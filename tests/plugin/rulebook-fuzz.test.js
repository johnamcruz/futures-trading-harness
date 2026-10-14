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
const { DEFAULT_SIZING } = require('../../scripts/lib/trading/combine');
const { loadAccounts } = require('../../scripts/lib/trading/accounts');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
const { tmpDir } = require('../helpers');

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
  let stricter = a.daily_loss_soft !== shipped.account.daily_loss_soft;
  if (none(a.daily_loss_soft) > none(shipped.account.daily_loss_soft)) looser.push(`daily_loss_soft ${a.daily_loss_soft}`);
  const policies = loadStrategies(root, {}).strategies.filter(s => s.signal === 'policy' && s.account === account);
  let refused = false;
  for (const old of shipped.policies) {
    const p = policies.find(x => x.name === old.name);
    if (!p || !p.valid) { refused = true; continue; }
    for (const k of Object.keys(DEFAULT_SIZING)) {
      if (p.sizing[k] === old.sizing[k]) continue;
      if (LOOSER[k](p.sizing[k], old.sizing[k], p.sizing)) looser.push(`${p.name}.sizing.${k} ${p.sizing[k]}`);
      else stricter = true;
    }
    if (JSON.stringify(p.exit) !== JSON.stringify(old.exit)) looser.push(`${p.name}.exit ${JSON.stringify(p.exit)} (a changed trail is never "stricter")`);
    if (JSON.stringify(p.multipliers) !== JSON.stringify(old.multipliers)) stricter = true;
  }
  if (looser.length) return { verdict: 'looser', why: looser };
  return { verdict: refused ? 'refused' : stricter ? 'stricter' : 'identical' };
}

test('fuzz: every key of every shipped rulebook removed, emptied, negative, text, 0, or beside an unknown key - refused or stricter, never looser', t => {
  const counts = { tried: 0, refused: 0, stricter: 0, identical: 0 };
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
      if (r.verdict === 'identical') bad.push(`${account}: ${label}: loads as shipped, so the change went unseen`);
    }
    fs.writeFileSync(file, text);
  }
  t.diagnostic(`rulebook fuzz: ${JSON.stringify(counts)}`);
  assert.deepStrictEqual(bad, []);
  assert.ok(counts.tried > 300, JSON.stringify(counts));
  assert.strictEqual(counts.tried, counts.refused + counts.stricter, JSON.stringify(counts));
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
    for (const [name, entry] of Object.entries(raw.policies || {})) {
      const p = SHIPPED_POLICIES.find(x => x.name === name);
      // Every sizing key the code reads (DEFAULT_SIZING's) is written in the file: the defaults never fill a gap.
      assert.deepStrictEqual(Object.keys(entry.sizing).sort(), Object.keys(DEFAULT_SIZING).sort(), `${file}: ${name}.sizing states every key`);
      assert.deepStrictEqual(p.sizing, Object.fromEntries(Object.entries(entry.sizing).map(([k, v]) => [k, RB.limit(v)])), `${name}: loaded as written`);
      assert.deepStrictEqual({ ...DEFAULT_SIZING, ...p.sizing }, p.sizing, `${name}: the code's merge with its defaults changes nothing`);
      assert.deepStrictEqual(p.exit, entry.exit, `${name}: the trail as written`);
      assert.ok(Array.isArray(entry.multipliers), `${file}: ${name}.multipliers stated`);
      assert.deepStrictEqual(p.multipliers, entry.multipliers, `${name}: multipliers as written`);
    }
  }
});

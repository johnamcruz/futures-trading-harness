'use strict';

// The rulebook's hard rules (docs/LEARNED-RULEBOOK.md, R1-R4), on the shipped tree:
//   R1  one place: every rulebook value is defined in its account's RULEBOOK.md and nowhere else (no code literal,
//       no skill, strategy, agent, rule, command or document restating it), and the code reads it from there;
//   R4  enforced or taught: every enforced item is really held by code (each probe below changes its outcome by the
//       rulebook's value or its fact), and every taught item really appears in the skills the agent loads.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const RB = require('../../scripts/lib/trading/rulebook');
const combine = require('../../scripts/lib/trading/combine');
const { loadAccounts } = require('../../scripts/lib/trading/accounts');
const { loadStrategies, exitPlan, tradeExitPlan } = require('../../scripts/lib/trading/strategies');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
const { tmpDir, FLOW_POLICY, FX_STRATEGIES, FX_GOLDEN, withComponents, withExitBlock, exitBlock } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ACCOUNTS = fs.readdirSync(path.join(ROOT, 'accounts')).filter(d => fs.existsSync(path.join(ROOT, 'accounts', d, 'ACCOUNT.md')));
const BOOKS = ACCOUNTS.map(a => ({ account: a, file: `accounts/${a}/${RB.FILE}`, book: RB.loadRulebookFile(path.join(ROOT, 'accounts', a, RB.FILE)) }));
const STRATEGIES = loadStrategies(ROOT, {}).strategies;
const POLICIES = STRATEGIES.filter(s => s.signal === 'policy');

test('R1: every shipped account has a valid rulebook beside it, and its profile states none of the rulebook\'s values', () => {
  assert.ok(ACCOUNTS.length >= 1);
  for (const { account, file, book } of BOOKS) {
    assert.ok(book, `${file} is missing`);
    assert.strictEqual(book.valid, true, `${file}: ${(book.errors || []).join('; ')}`);
    assert.strictEqual(book.learned, 'none', `${file}: nothing is learned yet (step 7 starts from today's values)`);
    const profile = parseFrontmatter(read(`accounts/${account}/ACCOUNT.md`)).data;
    for (const k of Object.keys(book).filter(x => !['name', 'description', 'learned', 'policies', 'enforced', 'taught', 'file', 'body', 'valid', 'errors'].includes(x))) {
      assert.strictEqual(profile[k], undefined, `accounts/${account}/ACCOUNT.md states ${k}: it lives in ${file}`);
    }
    const loaded = loadAccounts(ROOT, {}).accounts.find(a => a.name === account);
    assert.strictEqual(loaded.valid, true, loaded.errors.join());
    assert.strictEqual(loaded.daily_loss_soft, book.daily_loss_soft, `${account}: the loader reads daily_loss_soft from ${file}`);
    assert.strictEqual(loaded.loss_streak_stop, RB.limit(book.loss_streak_stop), `${account}: the loader reads loss_streak_stop from ${file}`);
  }
});

test('R1: every shipped policy strategy is in its account\'s rulebook, states none of it itself, and is loaded with the rulebook\'s values', () => {
  assert.ok(POLICIES.length >= 1);
  for (const p of POLICIES) {
    const { book, file } = BOOKS.find(b => b.account === p.account) || {};
    assert.ok(book, `${p.name}: its account ${p.account} has no rulebook`);
    const entry = RB.policyEntry(book, p.name);
    assert.ok(entry, `${p.name} is not in ${file} (policies.${p.name})`);
    const own = parseFrontmatter(read(`strategies/${p.name}/STRATEGY.md`)).data;
    for (const k of ['sizing', 'exit', 'multipliers']) assert.strictEqual(own[k], undefined, `strategies/${p.name}/STRATEGY.md states ${k}: it lives in ${file}`);
    assert.strictEqual(p.valid, true, p.errors.join());
    assert.deepStrictEqual([p.sizing, p.exit, p.multipliers], [entry.sizing, entry.exit, entry.multipliers], `${p.name}: loaded from ${file}`);
  }
  // No rulebook lists a policy that doesn't trade its account (a stale entry).
  for (const { account, file, book } of BOOKS) {
    for (const name of Object.keys(book.policies || {})) {
      const p = POLICIES.find(x => x.name === name);
      assert.ok(p && p.account === account, `${file} lists ${name}, which is not a policy strategy on ${account}`);
    }
  }
});

/**
 * Every rulebook value as [where, key, value]: the account's soft stop and each policy's sizing and exit numbers, and
 * the retired prop_flow_1m's entry (FLOW_POLICY, tests/helpers.js): its rulebook entry is gone, but nothing outside a
 * rulebook may restate its numbers either (a document or code keeping them would be a second place).
 */
function values() {
  const out = [];
  for (const group of ['sizing', 'exit']) for (const [k, v] of Object.entries(FLOW_POLICY[group])) out.push([`tests/helpers.js FLOW_POLICY (the retired prop_flow_1m).${group}`, k, v]);
  for (const { file, book } of BOOKS) {
    if (book.daily_loss_soft !== undefined) out.push([file, 'daily_loss_soft', book.daily_loss_soft]);
    if (book.loss_streak_stop !== undefined) out.push([file, 'loss_streak_stop', book.loss_streak_stop]);
    for (const [name, p] of Object.entries(book.policies || {})) {
      for (const group of ['sizing', 'exit']) for (const [k, v] of Object.entries(p[group] || {})) out.push([`${file} policies.${name}.${group}`, k, v]);
    }
  }
  return out;
}

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dollars = v => `\\$${esc(v.toLocaleString('en-US'))}(?![\\d,])|\\$${esc(v)}(?![\\d,])`;
/**
 * How a value can be restated, by key: the key with its number, and the prose a document would use (a share of
 * the cushion as a percent or a factor, the cap, the drawdown point, the soft stop, the trail in R). The trail's
 * numbers are also every rules strategy's own exit (a strategy parameter, outside the rulebook), so those count
 * only where a policy is meant: in a policy's own file, the pacing skill, or a line naming a policy.
 */
function restatements(key, v) {
  const num = `${esc(v)}(?![\\d.])`;
  const $ = `(?:${dollars(v)})`;
  const exit = ['trail_activate_r', 'trail_giveback_r'].includes(key);
  const res = [new RegExp(`\\b${key}\\b["']?\\s*[:=]\\s*${num}`)];
  if (key === 'cushion_frac') res.push(new RegExp(`(?<![\\d–-])${esc(Math.round(v * 100))}% of the cushion`), new RegExp(`(?:^|[^\\d.])${num}\\s*[x×]\\s*(?:the cushion|\\$)`));
  if (key === 'cap_usd') res.push(new RegExp(`(?:at most|capped at|a cap of|under the|cap) ${$}`, 'i'), new RegExp(`${$} cap\\b`));
  if (key === 'drawdown_halve_usd') res.push(new RegExp(`${$} or more below`), new RegExp(`${$} below (?:its|the) peak`));
  if (key === 'daily_loss_soft') res.push(new RegExp(`-${$} for the day`), new RegExp(`soft[^.\\n]{0,40}${$}`, 'i'));
  if (key === 'floor_stretch_max_usd') res.push(new RegExp(`(?:floor|stretch)[^.\\n]{0,60}(?:up to|at most|within) ${$}`, 'i'), new RegExp(`${$}[^.\\n]{0,40}(?:if|while) (?:the attempt is )?healthy`, 'i'));
  if (key === 'near_target_usd') res.push(new RegExp(`(?:target|pass)[^.\\n]{0,60}(?:within|under|at most) ${$}`, 'i'), new RegExp(`${$}[^.\\n]{0,40}(?:of|from|short of) the (?:target|pass)`, 'i'));
  if (key === 'loss_streak_stop') res.push(new RegExp(`(?:^|[^\\d.])${num} (?:losing trades|losses|losers) in a row[^\\n]{0,80}\\b(?:session|loss streak stop)`, 'i'));
  if (key === 'trail_activate_r') res.push(new RegExp(`(?:until|past|to|from) \\+${num}R\\b`));
  if (key === 'trail_giveback_r') res.push(new RegExp(`trail(?:s|ing)? ${num}R\\b`), new RegExp(`${num}R behind`));
  if (exit) res.push(new RegExp(`(?:^|[^\\d.])${num}R\\s*/`), new RegExp(`/\\s*${num}R\\b`));
  return res.map(re => ({ re, policyOnly: exit }));
}
const POLICY_FILES = [...POLICIES.map(p => `strategies/${p.name}/STRATEGY.md`), 'skills/prop-challenge-pacing/SKILL.md', 'skills/prop-evaluator/SKILL.md', 'skills/prop-pacing-judgment/SKILL.md'];
const POLICY_LINE = new RegExp(`\\b(?:${POLICIES.map(p => esc(p.name)).join('|')}|polic(?:y|ies))\\b`, 'i');

/** The files the rule covers: the repository's text, but the rulebooks, the tests and generated copies of the canonical files. */
function scanned() {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean).filter(f => /\.(?:md|js|json|toml|ya?ml)$/.test(f))
    .filter(f => !/(^|\/)RULEBOOK\.md$/.test(f) && !/^tests\//.test(f) && !/^node_modules\//.test(f) && f !== 'package-lock.json')
    .filter(f => fs.existsSync(path.join(ROOT, f)) && fs.lstatSync(path.join(ROOT, f)).isFile());
}

test('R1: no rulebook value is restated anywhere else: not in code, skills, agents, rules, commands, strategies or documents', () => {
  const vals = values();
  assert.ok(vals.length >= 10, 'the rulebooks hold today\'s values');
  const hits = [];
  for (const f of scanned()) {
    let text = read(f);
    // opencode's config holds each prompt (embedded skills included) as one JSON string, one line: scanned as the
    // prompt's own lines, as its sources are (a policy named anywhere in a whole prompt isn't one on the line).
    if (f === 'workspace/opencode.json') {
      const oc = JSON.parse(text);
      const prompts = Object.values(oc.agent || {}).map(a => a.prompt).filter(p => typeof p === 'string');
      text = [JSON.stringify(oc, (k, v) => (k === 'prompt' ? undefined : v), 2), ...prompts].join('\n');
    }
    for (const [where, key, v] of vals) {
      for (const { re, policyOnly } of restatements(key, v)) {
        const lines = text.split('\n');
        lines.forEach((line, i) => {
          // A policy is meant when it is named on the line or the two before it (a wrapped sentence).
          if (policyOnly && !POLICY_FILES.includes(f) && !POLICY_LINE.test(lines.slice(Math.max(0, i - 2), i + 1).join(' '))) return;
          if (re.test(line)) hits.push(`${f}:${i + 1} restates ${key} ${v} (${where}): ${line.trim().slice(0, 120)}`);
        });
      }
    }
  }
  assert.deepStrictEqual([...new Set(hits)], [], 'point to the account\'s RULEBOOK.md instead');
});

test('R1: the scan catches each way a value can be restated (it would fail without the rulebook rule)', () => {
  const caught = (key, v, line) => restatements(key, v).some(({ re }) => re.test(line));
  assert.ok(caught('cushion_frac', 0.3, 'sizing:\n  cushion_frac: 0.3'.split('\n')[1]));
  assert.ok(caught('cushion_frac', 0.3, 'sizing: { cushion_frac: 0.3, cap_usd: 1000 }'));
  assert.ok(caught('cushion_frac', 0.3, 'const z = { "cushion_frac": 0.3 };'));
  assert.ok(caught('cushion_frac', 0.3, 'The size budget is 30% of the cushion above the floor'));
  assert.ok(caught('cushion_frac', 0.3, 'Cushion $3,250: budget 0.3 x $3,250 = $975.'));
  assert.ok(caught('cap_usd', 1000, 'and at most $1,000'));
  assert.ok(caught('cap_usd', 1000, '(under the $1,000 cap; no drawdown)'));
  assert.ok(caught('drawdown_halve_usd', 1500, 'halved while the balance is $1,500 or more below its peak'));
  assert.ok(caught('daily_loss_soft', 1000, '- **Daily**: the harness stops new entries at -$1000 for the day'));
  assert.ok(caught('loss_streak_stop', 2, 'after 2 losing trades in a row the session stops'));
  assert.ok(caught('loss_streak_stop', 2, 'loss_streak_stop: 2'));
  assert.ok(!caught('loss_streak_stop', 2, 'after `loss_streak_stop` losing trades in a row the session stops'));
  assert.ok(!caught('loss_streak_stop', 2, '- After 2 losses in a row: stop, write a review and a lesson, then wait out the cooldown'), 'the gate\'s timed cooldown is its own setting');
  assert.ok(caught('floor_stretch_max_usd', 500, 'floor_stretch_max_usd: 500'));
  assert.ok(caught('floor_stretch_max_usd', 500, 'code may trade the floor up to $500 while the attempt is healthy'));
  assert.ok(caught('floor_stretch_max_usd', 500, 'Up to $500 if healthy'));
  assert.ok(!caught('floor_stretch_max_usd', 500, 'code may trade just the floor over $300, up to the rulebook\'s floor stretch'));
  assert.ok(caught('mode', 'target', 'exit: { mode: target }'));
  assert.ok(caught('trail_activate_r', 2, 'hold the setup\'s own stop until +2R ...'));
  assert.ok(caught('trail_giveback_r', 0.5, '... then trail 0.5R behind the best price'));
  assert.ok(caught('trail_activate_r', 2, 'exits by the policy strategy\'s own trail (2R / 0.5R), not'));
  assert.ok(caught('trail_giveback_r', 0.5, 'exits by the policy strategy\'s own trail (2R / 0.5R), not'));
  // Not a restatement: another number, a cushion amount, the key without its value.
  assert.ok(!caught('cushion_frac', 0.3, 'cushion_frac: 0.35'));
  assert.ok(!caught('cap_usd', 1000, 'Cushion $1,000, $2,000 below the peak'));
  assert.ok(!caught('cap_usd', 1000, 'at most $10,000'));
  assert.ok(!caught('cushion_frac', 0.3, 'budget cushion_frac x $3,250 = $975'));
  assert.ok(!caught('cushion_frac', 0.3, 'Daily risk budget ≤ 25–30% of the cushion'), 'a range is not the value');
  // The trail's numbers count only where a policy is meant (a rules strategy's own exit is its parameter).
  assert.ok(restatements('trail_activate_r', 2).every(r => r.policyOnly));
  assert.ok(POLICY_LINE.test('| Exits | `prop_portfolio` `exit` (hold to +2R, trail 0.5R) |'));
  assert.ok(!POLICY_LINE.test('initial stop (0.5 × ATR(20)) until +2R, then trail 0.5R behind the best'));
});

// ---- R4: enforced items are held by code; taught items are in the skills the agent loads. ----

const CLASSES = BOOKS.map(b => ({ ...b, enforced: b.book.enforced, taught: b.book.taught }));

const POLICY = POLICIES.find(p => p.name === 'prop_portfolio') || POLICIES[0];
/**
 * A plugin root with copies of the shipped accounts (rulebooks included) and the shipped strategies (linked), but the
 * policy given the fixture components fx_break and fx_cross (tests/fixtures/strategies-fx, copied in): the shipped one
 * lists none since its components retired, and a probe of its verdict needs a component.
 */
function rootCopy() {
  const root = tmpDir();
  fs.cpSync(path.join(ROOT, 'accounts'), path.join(root, 'accounts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'strategies'));
  for (const d of fs.readdirSync(path.join(ROOT, 'strategies'))) if (d !== POLICY.name) fs.symlinkSync(path.join(ROOT, 'strategies', d), path.join(root, 'strategies', d));
  fs.mkdirSync(path.join(root, 'strategies', POLICY.name));
  fs.writeFileSync(path.join(root, 'strategies', POLICY.name, 'STRATEGY.md'), withComponents(read(`strategies/${POLICY.name}/STRATEGY.md`)));
  for (const d of ['fx_break', 'fx_cross']) fs.cpSync(path.join(FX_STRATEGIES, d), path.join(root, 'strategies', d), { recursive: true });
  return root;
}
/** The gate probes' strategies: the shipped ones and fx_orb (the retired orb's rules, tests/fixtures/strategies-golden). */
const GATE_STRATEGIES = loadStrategies(ROOT, { FTH_STRATEGIES_DIRS: FX_GOLDEN }).strategies;
const fxOrb = H => ({ order: H.entryOrder({ rationale: 'setup:fx_orb break above OR high 21500, stop 21480, target 21540, risk $40' }), fired: [{ name: 'fx_orb', direction: 'long' }] });
const bookOf = root => path.join(root, 'accounts', POLICY.account, RB.FILE);
const edit = (root, fn) => fs.writeFileSync(bookOf(root), fn(fs.readFileSync(bookOf(root), 'utf8')));
const account = root => loadAccounts(root, {}).accounts.find(a => a.name === POLICY.account);
const policy = root => loadStrategies(root, {}).strategies.find(s => s.name === POLICY.name);

/** Probes: each enforced item's outcome in code, so a test fails if the code stops holding it. */
const ENFORCED = {
  daily_loss_soft: () => {
    // The rulebook's value stops entries; another value moves where they stop.
    const root = rootCopy();
    const soft = account(root).daily_loss_soft;
    assert.ok(soft > 0);
    const at = s => combine.entryBlock({ ...combine.start(account(root)), dayPnl: -s });
    assert.match(String(at(soft)), /soft daily limit/);
    assert.strictEqual(at(soft - 1), null);
    edit(root, t => t.replace(/^daily_loss_soft: \d+/m, `daily_loss_soft: ${soft - 1}`));
    assert.match(String(at(soft - 1)), /soft daily limit/);
  },
  sizing: () => {
    const root = rootCopy();
    const cs = { ...combine.start(account(root)), balance: account(root).starting_balance };
    const before = combine.budget(cs, policy(root).sizing);
    edit(root, t => t.replace(/^( {6}cushion_frac: )[\d.]+/m, '$10.05'));
    assert.strictEqual(policy(root).sizing.cushion_frac, 0.05);
    assert.ok(combine.budget(cs, policy(root).sizing) < before, 'the budget follows the rulebook\'s sizing');
  },
  exit: () => {
    // The rulebook's mode and trail reach the plan every trade exits by (the runner's and the backtester's).
    const root = rootCopy();
    const mode = POLICY.exit.mode;
    assert.ok(['target', 'target_then_trail', 'trail'].includes(mode));
    const component = { exit: { target_r: 3 }, risk: { min_rr: 2 } };
    const plan = () => tradeExitPlan(policy(root), component);
    if (mode !== 'trail') assert.strictEqual(plan().targetR, 3, 'the trade\'s own target is kept');
    if (mode === 'target_then_trail') assert.deepStrictEqual(plan().afterTarget, { lockGivebackR: POLICY.exit.lock_giveback_r, trailBy: POLICY.exit.trail_by, trailR: POLICY.exit.trail_r, swingMinutes: POLICY.exit.trail_by === 'structure' ? { '5m': 5, '15m': 15, '1h': 60 }[POLICY.exit.swing_tf] : null });
    edit(root, t => withExitBlock(t, exitBlock({ mode: 'trail', trail_activate_r: 2, trail_giveback_r: 1 })));
    assert.deepStrictEqual([plan().targetR, plan().trailActivateR, plan().trailGivebackR, plan().afterTarget], [null, 2, 1, undefined], policy(root).errors.join());
    edit(root, t => withExitBlock(t, exitBlock({ mode: 'target', trail_activate_r: 2, trail_giveback_r: 1 })));
    assert.deepStrictEqual([plan().targetR, plan().trailActivateR], [3, 2], 'mode target with a trail on top');
    edit(root, t => withExitBlock(t, exitBlock({ mode: 'target_then_trail', lock_giveback_r: 0.25, trail_by: 'r', trail_r: 0.75 })));
    assert.deepStrictEqual([plan().targetR, plan().afterTarget], [3, { lockGivebackR: 0.25, trailBy: 'r', trailR: 0.75, swingMinutes: null }], 'the lock and the trail follow the rulebook');
    assert.strictEqual(exitPlan(policy(root)).own, true);
  },
  loss_streak_stop: () => {
    // The rulebook's value stops entries after that many losses in a row; a scratch neither ends nor extends it.
    const root = rootCopy();
    const n = account(root).loss_streak_stop;
    assert.ok(Number.isInteger(n) && n >= 1);
    const after = grosses => grosses.reduce((cs, g) => combine.applyClose(cs, g - 1, g), combine.start(account(root)));
    const losses = k => Array.from({ length: k }, () => -10);
    assert.match(String(combine.entryBlock(after(losses(n)))), /loss streak stop/);
    assert.strictEqual(combine.entryBlock(after(losses(n - 1))), null);
    assert.match(String(combine.entryBlock(after([...losses(n - 1), 0, -10]))), /loss streak stop/, 'a scratch does not end it');
    assert.strictEqual(combine.entryBlock(after([...losses(n - 1), 10, -10])), null, 'a win ends it');
    assert.strictEqual(combine.entryBlock(combine.endDay(after(losses(n)))), null, 'the next session starts at 0');
    edit(root, t => t.replace(/^loss_streak_stop: \S+/m, `loss_streak_stop: ${n + 1}`));
    assert.strictEqual(combine.entryBlock(after(losses(n))), null, 'the stop follows the rulebook');
  },
  multipliers: () => {
    // An enforced multiplier item reaches the verdict; with its fact missing, the setup is skipped.
    const { decideSetup } = require('../../scripts/lib/prop/verdict');
    const root = rootCopy();
    const item = '\n    multipliers:\n      - item: multipliers\n        fact: probe\n        values:\n          ok: 1\n';
    edit(root, t => t.replace(new RegExp(`(\\n  ${POLICY.name}:\\n[^]*?)\\n    multipliers: \\[\\][^\\n]*\\n`), `$1${item}`));
    const p = policy(root);
    assert.strictEqual(p.multipliers.length, 1, p.errors.join());
    assert.ok(p.strategies[0], 'the policy has a component');
    const bars = Array.from({ length: 50 }, (_, k) => ({ t: new Date(Date.parse('2026-10-07T13:00:00Z') + k * 180000).toISOString(), o: 21500, h: 21502, l: 21498, c: 21500, v: 100 }));
    const args = facts => ({ account: account(root), cs: combine.start(account(root)), strategy: p, component: p.strategies[0], symbol: 'MNQ', contractId: 'MNQ', rawBars: bars, spec: { tickSize: 0.25, tickValue: 0.5 }, scan: { direction: 'long', stopDistance: 10 }, now: new Date('2026-10-07T15:30:00Z'), facts });
    assert.strictEqual(decideSetup(args({})).action, 'skip');
    assert.strictEqual(decideSetup(args({ probe: { value: 'ok' } })).action, 'full');
  },
  target_stop: () => {
    const a = account(ROOT);
    assert.match(String(combine.entryBlock({ ...combine.start({ ...a, consistency_pct: 0 }), balance: a.starting_balance + a.profit_target })), /at the profit target/);
  },
  consistency_stop: () => {
    const a = account(ROOT);
    const s = { ...combine.start(a), balance: a.starting_balance + a.profit_target + 10, days: [a.profit_target / 2], dayPnl: a.profit_target / 2 + 10 };
    assert.match(String(combine.entryBlock(s)), /today the best day/);
  },
  one_position: () => {
    const prop = require('../../scripts/lib/trading/prop-state');
    const home = tmpDir();
    const a = account(ROOT);
    prop.startAttempt(home, a, new Date('2026-10-06T14:00:00Z'));
    prop.snapshot(home, a, a.starting_balance, new Date('2026-10-07T13:59:00Z'), { open: 1, openIds: ['MNQ'] });
    assert.match(String(prop.combineBlock(home, a.name, new Date('2026-10-07T14:00:00Z'))), /one position at a time/);
  },
  hard_stops: () => {
    const { evaluateOrder } = require('../../scripts/lib/trading/order-gate');
    const { loadConfig } = require('../../scripts/lib/trading/config');
    const H = require('../helpers');
    const { order, fired } = fxOrb(H);
    const config = { ...loadConfig({}), killSwitchFile: '/nonexistent/fth/STOP', home: H.trendHome(undefined, { fired }), mtfMaxAgeMin: 1e9, signalMaxAgeMin: 1e9 };
    const blackouts = { items: [{ start: H.minutesAgo(5), end: H.minutesAgo(-10), reason: 'CPI' }] };
    const r = evaluateOrder({ input: order, entries: [H.plan()], now: H.NOW, config, blackouts, strategies: GATE_STRATEGIES });
    assert.ok(r.violations.some(v => v.check === 'blackout'), JSON.stringify(r.violations));
  },
  entry_rule: () => {
    // The rulebook's entry rule reaches the reads checker (compose_check and the gate's re-check): as shipped (BG,
    // bias_agree neutral-15m-declared), a long with the 4h up and the 1h ranging goes, one with the 1h down is refused,
    // and with both ranging only the 15m up and the declared trend up let it go; bias_agree on refuses the 1h ranging;
    // with every key off nothing more is checked.
    const { entryRuleOf } = require('../../scripts/lib/trading/entry-rule');
    const { checkReads } = require('../../scripts/lib/trading/composed-reads');
    const root = rootCopy();
    const DEC = { long: { vwapAtr: 0.5, ema20Atr: 0.3, dayMoveAtr: 1, regime: 'with' }, short: { vwapAtr: -0.5, ema20Atr: -0.3, dayMoveAtr: -1, regime: 'against' } };
    const briefing = (t1h, regime = 'trend-up', { t4h = 'up', t15 = 'range', declared = null } = {}) => ({ minutes: 3, sections: { m3: { data: { price: 21500, regime: { primary: regime }, ...(declared ? { declared } : {}) } }, m15: { data: { frame: { trend: t15 } } }, h1: { data: { h4: { trend: t4h }, h1: { trend: t1h } } } } });
    const problems = b => checkReads({ reads: [], side: 'long', briefing: b, entryRule: entryRuleOf(policy(root).entry) }).problems.filter(x => /^entry rule/.test(x));
    assert.deepStrictEqual(problems(briefing('range')), [], policy(root).errors.join());
    assert.deepStrictEqual(problems(briefing('up')), [], 'both up: no entry-rule problem');
    assert.match(problems(briefing('down')).join(), /the 1h trend is down, against the long/);
    assert.match(problems(briefing('range', 'trend-up', { t4h: 'range', t15: 'up' })).join(), /Trend declared\? facts are not in the briefing/);
    assert.deepStrictEqual(problems(briefing('range', 'trend-up', { t4h: 'range', t15: 'up', declared: DEC })), [], 'both range: the 15m and declared up');
    assert.match(problems(briefing('range', 'trend-up', { t4h: 'range', t15: 'down', declared: DEC })).join(), /the 15m is down, not up/);
    edit(root, t => t.replace(/^( {6}bias_agree: )neutral-15m-declared/m, '$1on'));
    assert.match(problems(briefing('range')).join(), /4h and 1h must each trend up for a long .*no agreement, no trade/, 'bias_agree on: the strict rule');
    edit(root, t => t.replace(/^( {6}bias_agree: )on/m, '$1off'));
    edit(root, t => t.replace(/^( {6}bias_frames: )\[4h, 1h\]/m, '$1off'));
    edit(root, t => t.replace(/^( {6}regime_against: )off/m, '$1on'));
    assert.match(problems(briefing('range', 'trend-down')).join(), /regime is trend-down, against the long/, policy(root).errors.join());
  },
  trend_rule: () => {
    const { evaluateOrder } = require('../../scripts/lib/trading/order-gate');
    const { loadConfig } = require('../../scripts/lib/trading/config');
    const H = require('../helpers');
    const { order, fired } = fxOrb(H);
    const config = { ...loadConfig({}), killSwitchFile: '/nonexistent/fth/STOP', home: H.trendHome(undefined, { biases: { 240: -1, 60: -1, 15: -1 }, fired }), mtfMaxAgeMin: 1e9, signalMaxAgeMin: 1e9 };
    const r = evaluateOrder({ input: order, entries: [H.plan()], now: H.NOW, config, strategies: GATE_STRATEGIES });
    assert.ok(r.violations.some(v => /against the 4h down trend: no entry against a trending 4h or 1h/.test(v.message)), JSON.stringify(r.violations));
  },
};

test('the owner\'s top-down rule is shipped and held: every policy\'s entry has bias_frames [4h, 1h] and bias_agree neutral-15m-declared (BG)', () => {
  // "Don't counter trade against the prevailing trend" (2026-10-29); BG, the owner's pick from the alignment study (2026-10-29).
  const { entryRuleOf } = require('../../scripts/lib/trading/entry-rule');
  assert.ok(POLICIES.length >= 1);
  for (const { file, book } of BOOKS) for (const [name, p] of Object.entries(book.policies || {})) {
    assert.deepStrictEqual(p.entry.bias_frames, ['4h', '1h'], `${file} policies.${name}.entry.bias_frames`);
    assert.strictEqual(p.entry.bias_agree, 'neutral-15m-declared', `${file} policies.${name}.entry.bias_agree`);
  }
  for (const s of POLICIES) assert.deepStrictEqual({ ...entryRuleOf(s.entry) }, { chain: require('../../scripts/lib/trading/chain').chainOf('4h'), entryLane: true, biasFrames: ['4h', '1h'], biasAgree: false, biasNeutral: true, regimeAgainst: s.entry.regime_against === 'on', legTurned: s.entry.leg_turned === 'on' }, s.name);
  // A changed copy fails this test: each way of changing the bias is seen (a dropped frame is looser; on and off are stricter).
  const shipped = read(BOOKS[0].file);
  const loosened = [['bias_agree: neutral-15m-declared', 'bias_agree: off'], ['bias_agree: neutral-15m-declared', 'bias_agree: on'], ['bias_frames: [4h, 1h]', 'bias_frames: off'], ['bias_frames: [4h, 1h]', 'bias_frames: [4h]'], ['bias_frames: [4h, 1h]', 'bias_frames: [1h]']];
  for (const [a, b] of loosened) {
    assert.ok(shipped.includes(a), a);
    const e = parseFrontmatter(shipped.replace(a, b)).data.policies.prop_portfolio.entry;
    assert.ok(!(JSON.stringify(e.bias_frames) === JSON.stringify(['4h', '1h']) && e.bias_agree === 'neutral-15m-declared'), b);
  }
});

test('R4: each rulebook classifies every item, and every enforced item is really held by code (its probe)', () => {
  for (const { file, enforced, taught } of CLASSES) {
    assert.deepStrictEqual([...enforced, ...taught].sort(), Object.keys(RB.ITEMS).sort(), file);
    for (const k of enforced) {
      assert.ok(ENFORCED[k], `${file}: ${k} is classified enforced, but no probe shows the code holding it`);
      ENFORCED[k]();
    }
  }
  // Every probe is for an item some rulebook classifies enforced (none left over from a reclassification).
  for (const k of Object.keys(ENFORCED)) assert.ok(CLASSES.some(c => c.enforced.includes(k)), `${k} has a probe but no rulebook enforces it`);
  // The owner's classification (section 11): the mechanical items the code holds today are enforced, the rest taught.
  assert.deepStrictEqual(CLASSES[0].taught.sort(), ['confluence', 'halving', 'mtf_read', 'room', 'secondary_context', 'skip_rules', 'trend_fade']);
});

/** What each taught item's step teaches, in the skill's own words (whitespace may wrap). */
const TAUGHT = {
  trend_fade: /\(never counter\): any setup or strategy against a\s+trending 4h or 1h[^]*→ no trade/,
  room: /`inTheWay`[^]*`needR`\)[^]*never a no\s+trade alone/,
  mtf_read: /`aligned` → full;[^]*`mixed` → half;[^]*`counter` → no trade/,
  skip_rules: /skip rules\*\*[^]*any skip rule hit: no trade/,
  confluence: /\*\*Confluence\*\* \(rules strategies\): another firing the other side → no trade/,
  secondary_context: /cuts to half \(not in a prop attempt\), never vetoes alone/,
  halving: /half is `floor\(size \/ 2\)`[^]*?Halvings don't compound/,
};
/** Step `n` of a priority-order section: from its number to the next step or the section's end. */
function stepText(section, n) {
  const at = section.search(new RegExp(`\\n${n}\\. \\*\\*`));
  if (at < 0) return null;
  const next = section.slice(at + 1).search(/\n(?:\d+\. \*\*|\n)/);
  return section.slice(at, next < 0 ? undefined : at + 1 + next);
}

test('R4: the taught keywords catch a rewritten step (each would fail on the step it does not pin)', () => {
  const sec = '### The priority order\n\n4. **The multi-timeframe read for its side**: `aligned` → full; `mixed` → half;\n   `counter` → no trade.\n5. **Next**: x\n';
  assert.match(stepText(sec, 4), TAUGHT.mtf_read);
  assert.doesNotMatch(stepText(sec.replace('`mixed` → half', '`mixed` → full'), 4), TAUGHT.mtf_read);
  assert.doesNotMatch(stepText(sec, 5), TAUGHT.mtf_read, 'another step\'s words never count');
  assert.strictEqual(stepText(sec, 6), null);
});

test('R4: every taught item is in the skill that teaches it, and the roles that decide load that skill in every harness', () => {
  const sections = {};
  const section = skill => {
    if (!sections[skill]) {
      const text = read(`skills/${skill}/SKILL.md`);
      const at = text.indexOf('### The priority order: the rule for every setup');
      assert.ok(at >= 0, `${skill}: no priority order`);
      sections[skill] = text.slice(at, text.indexOf('\n### ', at + 10));
    }
    return sections[skill];
  };
  for (const { file, taught } of CLASSES) {
    for (const k of taught) {
      const t = RB.ITEMS[k].taughtIn;
      assert.ok(t, `${file}: ${k} is classified taught, but no skill teaches it`);
      const text = section(t.skill);
      if (t.step === null) assert.match(text, TAUGHT.halving, `${k}: the rounding of a cut`);
      else {
        // The step, and what it teaches: a rewritten step fails here, not just a renumbered one.
        const step = stepText(text, t.step);
        assert.ok(step, `${k}: step ${t.step} of the priority order in ${t.skill}`);
        assert.ok(TAUGHT[k], `${k}: no keyword pins what its step teaches`);
        assert.match(step, TAUGHT[k], `${k}: step ${t.step} of ${t.skill} no longer teaches it`);
      }
    }
  }
  // The skill reaches the agent: the head trader's cycle loads it, the risk manager carries it, and the
  // generated adapters hold it.
  const skills = new Set(CLASSES.flatMap(c => c.taught.map(k => RB.ITEMS[k].taughtIn.skill)));
  for (const skill of skills) {
    assert.match(read('skills/trade-session/SKILL.md'), new RegExp(`the \`${skill}\` skill`));
    assert.match(read('agents/risk-manager.md'), new RegExp(`^role-skills: \\[[^\\]]*\\b${skill}\\b`, 'm'));
    const oc = JSON.parse(read('workspace/opencode.json'));
    assert.match(oc.agent['risk-manager'].prompt, /### The priority order: the rule for every setup/);
  }
});

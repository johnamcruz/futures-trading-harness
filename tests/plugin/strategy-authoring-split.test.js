'use strict';

// The strategy-authoring skill was split by job: strategy-authoring keeps writing the document (the file, the
// frontmatter keys, the body, porting faithfully, validating, promoting); strategy-rules takes the rules language
// (conditions, groups, every series); strategy-backtest the backtest, the field study and the bar-source comparison.
// This test proves nothing was lost or doubled: every sentence (and every table cell and code line) of the skill as
// it was (tests/fixtures/skill-split/strategy-authoring.before.txt, frozen) is in the new homes exactly as many times
// as before, byte-for-byte after whitespace is normalised, in its old order within each home. The only exceptions are
// listed, each with its reason; an exception that no longer differs fails too, so the list can only shrink.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { units, differences } = require('./skill-split');
const { orderErrors } = require('./skill-split-order');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// skills/strategy-authoring/SKILL.md as main had it before the split (at e7433091): pinned, so a sentence can't be
// dropped from the fixture and from its new home together.
const BEFORE = 'tests/fixtures/skill-split/strategy-authoring.before.txt';
const BEFORE_SHA256 = '5d89353effc4c6d34069fdbb046d4e2da44fd4767bd44e0b6795a3647bac146f';
const HOMES = ['strategy-authoring', 'strategy-rules', 'strategy-backtest'];

// Deliberate differences, each with its reason.
const ALLOWED = [
  // A pointer to a step that is now another skill.
  { old: 'Bars the backtester builds from shorter ones, and CSV files, carry no broker fields (step 8 says how to backtest on them).',
    now: 'Bars the backtester builds from shorter ones, and CSV files, carry no broker fields (the `strategy-backtest` skill says how to backtest on them).',
    reason: 'step 8 is the strategy-backtest skill' },
  { old: "A 60m rejection of the prior day's high: `htfd_rejected(60, prior_high) < 0`; its target: `exit.target: close - htfd_next_swing_low(60)`.",
    now: "A 1h rejection of the prior day's high: `htfd_rejected(60, prior_high) < 0`; its target: `exit.target: close - htfd_next_swing_low(60)`.",
    reason: "\"60m\" is written \"1h\" in prose, as the briefing names it; the rules language keeps its minutes argument (fix/skills-concept-owners)" },
];

// Edits made to the homes since the split (skill-split-late.js), each with its reason: the coverage test holds each
// home to its edited text, and a late edit that matches nothing fails.
const { withLate } = require('./skill-split-late');
const LATE = [
  { from: "A policy strategy: the prop challenge as a strategy (see `strategies/prop_portfolio`). `strategies` lists the rules strategies whose setups it trades, in priority order, all on its timeframe; `account` names `accounts/<name>/ACCOUNT.md` (the gate enforces its floor, daily limits, and size budget); its numbers live in its account's rulebook, `accounts/<account>/RULEBOOK.md` (`policies.<name>`: `sizing`, `exit`, `multipliers`, every key stated, a limit turned off only by `off`), the one place for them: a policy may not state them in its STRATEGY.md, and one the rulebook doesn't list is refused (the loader refuses both); `sizing` sets risk per trade from the cushion (`cushion_frac` ≤ 1, `cap_usd`, `clock_k`, `r_per_session`, `min_size_guard`, `drawdown_halve_usd`: halve the budget while the balance is at least that far below its peak, `stop_slippage_ticks`: the stop's expected slippage counted in each contract's risk, at least 1, the default and the backtester's fill slippage); `contracts` is `micro`, `mini`, or `auto` (minis once the size reaches one mini); its `exit` needs a trail (it exits every trade the policy strategy takes); each verdict is `full` (sized at the rulebook's multiplier) or `skip`; `risk.stop: strategy` keeps each setup's own stop. Each setup is taken at the largest size the budget allows, or skipped. `priority` (optional, a whole number 1 to 99, 1 first) orders policy strategies whose setups come in the same cycle on different runner lanes (timeframes): the lower number keeps its setup and the other is skipped as \"lower priority\" (equal or unset: the one on 3m or slower goes first), settled per runner, that is per account (a runner trades one account): a setup on another of its symbols collides too, and so does another policy's entry verdict from an earlier cycle while it is still open (unexpired, unused). Only policy strategies have these keys",
    to: "A policy strategy: the prop challenge as a strategy (see `strategies/prop_portfolio`). `strategies` lists the rules strategies whose setups it trades, in priority order, all on its timeframe; `account` names `accounts/<name>/ACCOUNT.md` (the gate enforces its floor, daily limits, and size budget); its numbers live in its account's rulebook, `accounts/<account>/RULEBOOK.md` (`policies.<name>`: `sizing`, `exit`, `multipliers`, every key stated, a limit turned off only by `off`), the one place for them: a policy may not state them in its STRATEGY.md, and one the rulebook doesn't list is refused (the loader refuses both); `sizing` sets risk per trade from the cushion (`cushion_frac` ≤ 1, `cap_usd`, `clock_k`, `r_per_session`, `min_size_guard`, `drawdown_halve_usd`: halve the budget while the balance is at least that far below its peak, `stop_slippage_ticks`: the stop's expected slippage counted in each contract's risk, at least 1, the default and the backtester's fill slippage); `contracts` is `micro`, `mini`, or `auto` (minis once the size reaches one mini); its `exit` has a mode (`target`: each trade's own stop and target, a trail on top only when set; `target_then_trail`: past its own target the trade is trailed, not closed; `trail`: the trail in place of the target); each verdict is `full` (sized at the rulebook's multiplier) or `skip`; `risk.stop: strategy` keeps each setup's own stop. Each setup is taken at the largest size the budget allows, or skipped. `priority` (optional, a whole number 1 to 99, 1 first) orders policy strategies whose setups come in the same cycle on different runner lanes (timeframes): the lower number keeps its setup and the other is skipped as \"lower priority\" (equal or unset: the one on 3m or slower goes first), settled per runner, that is per account (a runner trades one account): a setup on another of its symbols collides too, and so does another policy's entry verdict from an earlier cycle while it is still open (unexpired, unused). Only policy strategies have these keys",
    reason: "feat/prop-portfolio-missing (owner-approved): a policy's exit is a rulebook mode (target; target_then_trail, trailed past its own target; trail), no longer always a trail" },
  { from: "`trend` (the default) or `reversal`. A trend strategy never enters against the prevailing higher-timeframe trend (the highest of 4h, 1h, 15m with one): the scan drops the signal, the backtester skips it, and the order gate refuses the entry. Set `reversal` only when the setup is a raid or exhaustion at a higher-timeframe level that fades that trend by design (`crt_1h`, `crt_4h`, `ofi_absorption`, `value_area_reentry`); say why in the body. Policy strategies have no `mtf`: each setup keeps its strategy's",
    to: "`trend` (the default) or `reversal`. A trend strategy never enters against the prevailing higher-timeframe trend (the highest of 4h, 1h, 15m with one): the scan drops the signal, the backtester skips it, and the order gate refuses the entry. Set `reversal` only when the setup is a raid or exhaustion at a higher-timeframe level that fades that trend by design; say why in the body. Policy strategies have no `mtf`: each setup keeps its strategy's",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit; moved into fix/skills-composed-process so strategy-library's composed clauses grow no prompt)" },
  { from: "`stop` (`atr:<k>` = k × ATR(20), a distance expression such as `0.5 * atr(20)` or `cisd_risk(15)`, a map `{ long: <expr>, short: <expr> }` when each side's stop sits somewhere else (beyond a swept low or high, as in `crt_1h`), `structure`, `swing`, `manual`), `min_rr`, optional `max_risk_usd`. The order gate checks that a stop exists and, when `max_risk_usd` is set, refuses an entry whose risk (size × stop ticks × the broker's tick value) is over it, or whose risk it can't compute (a market entry with its stop only in the rationale: give `stopLossBracket.ticks`); `min_rr` is applied by the agents (risk-manager), not by code. In a policy strategy, only its own `max_risk_usd` applies to its entries, not its components'",
    to: "`stop` (`atr:<k>` = k × ATR(20), a distance expression such as `0.5 * atr(20)` or `cisd_risk(15)`, a map `{ long: <expr>, short: <expr> }` when each side's stop sits somewhere else (beyond a swept low or high), `structure`, `swing`, `manual`), `min_rr`, optional `max_risk_usd`. The order gate checks that a stop exists and, when `max_risk_usd` is set, refuses an entry whose risk (size × stop ticks × the broker's tick value) is over it, or whose risk it can't compute (a market entry with its stop only in the rationale: give `stopLossBracket.ticks`); `min_rr` is applied by the agents (risk-manager), not by code. In a policy strategy, only its own `max_risk_usd` applies to its entries, not its components'",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit; moved into fix/skills-composed-process so strategy-library's composed clauses grow no prompt)" },
  { from: "See `strategies/vwap_reclaim/STRATEGY.md` for a complete rules strategy.",
    to: "See `strategies/_template/STRATEGY.md` for a rules strategy's skeleton.",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit; moved into fix/skills-composed-process so strategy-library's composed clauses grow no prompt); the template is the skeleton that ships" },
  { from: "Every item in a side must hold (AND); an item can be a group, `any: [...]` (one of them holds, OR) or `all: [...]` (every one), nested three deep, so one strategy can take two setups or two confirmations (see `value_area`: a POC rejection or breakout, confirmed by a broker field or expansion).",
    to: "Every item in a side must hold (AND); an item can be a group, `any: [...]` (one of them holds, OR) or `all: [...]` (every one), nested three deep, so one strategy can take two setups or two confirmations (a POC rejection or breakout, confirmed by a broker field or expansion).",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples)" },
  { from: "`crt_dir(m) crt_risk(m) crt_target(m)` are the Candle Range Theory sweep detector on m-minute candles (one setup per candle, tuned by the `crt*` params; see `crt_1h`).",
    to: "`crt_dir(m) crt_risk(m) crt_target(m)` are the Candle Range Theory sweep detector on m-minute candles (one setup per candle, tuned by the `crt*` params).",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples)" },
  { from: "Only a pattern the rules can't express (multi-bar zone logic like cisd_ote's) needs `manual` or a new series in `scripts/lib/trading/rules.js` (with tests), used from the rules like `cisd_entry(15)`.",
    to: "Only a pattern the rules can't express (multi-bar zone logic) needs `manual` or a new series in `scripts/lib/trading/rules.js` (with tests), used from the rules like `cisd_entry(15)`.",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples)" },
];
const LATE_STALE = (() => {
  const r = withLate(ALLOWED, LATE, units(require('fs').readFileSync(require('path').join(__dirname, '..', '..', BEFORE), 'utf8')));
  ALLOWED.splice(0, ALLOWED.length, ...r.allowed);
  return r.stale.map(l => l.from);
})();

const homeTexts = () => HOMES.map(s => read(`skills/${s}/SKILL.md`));

test('strategy-authoring split: every unit of the old skill is in exactly one new home, in its old order', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, BEFORE))).digest('hex');
  assert.strictEqual(sha, BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  assert.deepStrictEqual(differences(read(BEFORE), homeTexts(), ALLOWED), []);
  assert.deepStrictEqual(orderErrors(read(BEFORE), homeTexts(), HOMES, ALLOWED), [], 'moved text keeps its old order in each home');
  for (const a of ALLOWED) assert.ok(a.reason, a.old);
});

test('strategy-authoring split: the comparison catches a lost, a doubled, an edited or a reordered sentence', () => {
  const old = read(BEFORE);
  const u = units(old);
  assert.ok(u.length > 100, `the units are fine-grained (${u.length})`);
  assert.ok(u.includes('Port faithfully.'), 'a short sentence is a unit');
  assert.ok(u.includes('At most 12 conditions per side.'), 'a sentence is a unit');
  assert.ok(u.includes('- adx(14) >= 20'), 'a code line is a unit');
  const homes = homeTexts();
  const at = name => HOMES.indexOf(name);
  const swap = (name, text) => homes.map((h, i) => (i === at(name) ? text : h));
  // A sentence as a pattern that matches it across line breaks.
  const loose = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  const S = 'At most 12 conditions per side.';
  const rules = homes[at('strategy-rules')];
  assert.match(rules, new RegExp(loose(S)));
  // Lost, doubled, edited.
  assert.notDeepStrictEqual(differences(old, swap('strategy-rules', rules.replace(new RegExp(loose(S)), '')), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap('strategy-backtest', `${homes[at('strategy-backtest')]}\n${S}\n`), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap('strategy-rules', rules.replace('(n up to 500; adx up to 250)', '(n up to 400; adx up to 250)')), ALLOWED), []);
  // Reordered: two sentences of one paragraph swapped (nothing lost, the order changed).
  const A1 = 'A rules strategy with only `long` rules can\'t be used to sell into an entry.';
  const A0 = S;
  const pair = new RegExp(`${loose(A0)}\\s+${loose(A1)}`);
  assert.match(rules, pair);
  const swapped = rules.replace(pair, `${A1} ${A0}`);
  assert.deepStrictEqual(differences(old, swap('strategy-rules', swapped), ALLOWED), [], 'a swap loses nothing');
  assert.notDeepStrictEqual(orderErrors(old, swap('strategy-rules', swapped), HOMES, ALLOWED), [], 'but changes the order');
  // The changed pointer reverted to its old text (the exception no longer needed) fails: the list only shrinks.
  assert.notDeepStrictEqual(differences(old, swap('strategy-rules', rules.replace(/the `strategy-backtest` skill says\s+how/, 'step 8 says how')), ALLOWED), []);
  // A section heading dropped.
  assert.notDeepStrictEqual(differences(old, swap('strategy-backtest', homes[at('strategy-backtest')].replace('## Examples', '## Example')), ALLOWED), []);
});

test('strategy-authoring split: each skill has a short "Use when" index line, and strategy-authoring points to the rest', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  for (const s of HOMES) {
    const d = parseFrontmatter(read(`skills/${s}/SKILL.md`)).data.description;
    assert.ok(d.length <= 160, `${s}: description ${d.length} chars, over 160`);
    assert.match(d, /^Use when /, s);
  }
  const sa = read('skills/strategy-authoring/SKILL.md').replace(/\s+/g, ' ');
  for (const s of HOMES.slice(1)) assert.match(sa, new RegExp(`the \`${s}\` skill`), `strategy-authoring points to ${s}`);
  // The workflow keeps the backtest's place: before paper trading (old step 8's own text is in strategy-backtest).
  assert.match(sa, /8\. Before paper trading, backtest it \(the `strategy-backtest` skill/);
  // The schema table stays; the language and the backtest left it.
  assert.match(sa, /\| `signal: policy` \|/);
  assert.doesNotMatch(sa, /htfd_rejected|crosses_above`, |field-study\.js|compare-bars\.js|backtest\.js --data/);
  // The roles that read the htfd_* functions point to where they are now.
  for (const s of ['candle-reading', 'levels-and-reactions']) assert.match(read(`skills/${s}/SKILL.md`), /strategy-rules/, s);
});

test('strategy-authoring split: the strategy researcher loads what its method uses (the document and the rules language)', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  const sr = parseFrontmatter(read('agents/strategy-researcher.md')).data['role-skills'];
  for (const s of ['strategy-authoring', 'strategy-rules']) assert.ok(sr.includes(s), s);
  // Backtesting is not in its method (steps 1-6): strategy-authoring's step 8 points to strategy-backtest, which it
  // loads with its skill tool when a session asks for a backtest.
  assert.ok(!sr.includes('strategy-backtest'));
  assert.match(read('skills/strategy-authoring/SKILL.md').replace(/\s+/g, ' '), /the `strategy-backtest` skill/);
});

test('strategy-authoring-split: every late edit matches a unit of the homes', () => {
  assert.deepStrictEqual(LATE_STALE, []);
});

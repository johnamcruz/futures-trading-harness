'use strict';

// The autonomous-trading skill was split by job: autonomous-trading keeps the cycle every autonomous run follows (one
// bounded cycle per bar, no questions, positions first and what the prompt carries, guardrails, the result line, the
// read budget, harness tools); runner-lanes takes several lanes, analysts on their own timeframe and the policy
// priority; kill-switch the kill switch, the broker allow-list and the account lock; runner-logs where the runner's
// logs and session records are. This test proves nothing was lost or doubled: every sentence (and every code line) of
// the skill as it was (tests/fixtures/skill-split/autonomous-trading.before.txt, frozen) is in the new homes exactly
// as many times as before, byte-for-byte after whitespace is normalised, in its old order within each home. The only
// exceptions are listed, each with its reason: text that restated trade-session is now a pointer to it. An exception
// that no longer differs fails too, so the list can only shrink.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { units, count, differences, STRUCTURE } = require('./skill-split');
const { orderErrors } = require('./skill-split-order');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const flat = s => s.replace(/\s+/g, ' ');

// skills/autonomous-trading/SKILL.md as main had it before the split (at e7433091): pinned, so a sentence can't be
// dropped from the fixture and from its new home together.
const BEFORE = 'tests/fixtures/skill-split/autonomous-trading.before.txt';
const BEFORE_SHA256 = '498687248447a47507de60e2ac2a6720d83c128e3e812100b919a1100e343717';
const HOMES = ['autonomous-trading', 'runner-lanes', 'kill-switch', 'runner-logs'];

// Deliberate differences, each with its reason: the head trader loads trade-session every cycle (the order gate
// requires it), so what it already teaches is a pointer here, never a second copy.
const ALLOWED = [
  { old: '**Analysts on their own timeframe.** When the prompt says "Each analyst reads its own timeframe" (e.g. trend-momentum-analyst on 15m, volume-liquidity-analyst on 1h), pass each named analyst its timeframe with the symbol (trade-session step 2).',
    copies: 0, reason: 'trade-session step 2\'s own paragraph ("An analyst on its own timeframe") teaches it, and is in runner-lanes now (the trade-session split, tests/plugin/trade-session-split.test.js), so the pointer to it went' },
  { old: 'Its cached report says "(15m, from 10:45 ET, holds until 11:00 ET)": it rests on its own bar and may be up to one of its bars old, so this bar\'s facts come from the bar briefing.',
    copies: 0, reason: 'trade-session step 2: such a report holds until its own next bar close, and this bar\'s facts come from the briefing' },
  { old: 'Merge every analyst\'s latest report and decide once.',
    copies: 0, reason: 'trade-session step 2: "You merge every analyst\'s latest report and decide once for the cycle."' },
  { old: 'A rules strategy\'s signal expires 3 bars of its own timeframe after its bar closed, never more than 45 minutes (3 min on 1m, 9 min on 3m), so a 1m setup can\'t wait.',
    now: 'A rules strategy\'s signal expires as trade-session step 2 says (the trigger check), so a 1m setup can\'t wait.',
    reason: 'the expiry is trade-session step 2\'s trigger check ("The trigger is checked too"): a pointer, keeping the lane fact' },
  { old: 'Every entry carries its stop bracket; a refused entry (`success: false` with an `errorCode` other than 6 (`OrderPending`) or 7 (`UnknownError`), its brackets included) ends the cycle as `blocked` with the broker\'s message, journalled, and is never sent again without its bracket.',
    now: 'A refused entry, or one whose reply was an error, is handled as trade-session step 6 says (a refusal ends the cycle `blocked`), and confirm it yourself: read positions and orders, and fix any position without a working stop first.',
    reason: 'trade-session step 6 teaches the refusal (cycle result `blocked`, never re-sent without its bracket): a pointer' },
  { old: 'Any other error on an entry (codes 6 and 7 included) is an unknown outcome, not a refusal: read positions and orders at once, protect or close any position without a covering stop first, and never re-send it.',
    copies: 0, reason: 'trade-session step 6 has the unknown outcome and never re-sending the entry, but gives the reads and the protecting to the trade-executor: the head trader\'s own check (read positions and orders, fix an unprotected position first) stays in the pointer above' },
  { old: 'The prompt also carries the last 10 closed bars and your last 10 cycle results (with several lanes, per lane: see rule 1): read them, and don\'t reverse a recent decision without saying what changed.',
    now: 'The prompt also carries the last 10 closed bars and your last 10 cycle results (with several lanes, per lane: the `runner-lanes` skill): read them, and don\'t reverse a recent decision without saying what changed.',
    reason: 'rule 1\'s per-lane text is now the runner-lanes skill: point straight to it' },
  // A pointer to a skill retired later (tests/plugin/harness-tools-split.test.js): each tool's row is in its own skill.
  { old: '**Harness tools, not scripts.** Bars, scans, the snapshot, the multi-timeframe read, blackouts, the prop status, lessons, and reconcile are tools on the `harness` MCP server (the `harness-tools` skill): call them; don\'t run the harness\'s scripts from a shell.',
    now: '**Harness tools, not scripts.** Bars, scans, the snapshot, the multi-timeframe read, blackouts, the prop status, lessons, and reconcile are tools on the `harness` MCP server (each in its skill): call them; don\'t run the harness\'s scripts from a shell.',
    reason: 'the tool skill is retired; each tool\'s row is in its topic skill (no longer than the old pointer: the head trader reads it every cycle)' },
  // trade-session's step 3 checks and step 2 roles are skills of their own (tests/plugin/trade-session-split.test.js).
  { old: 'Check its reasons against the facts before you write it (`reason_check`, trade-session step 3): a reason marked FALSE is dropped and the decision made again.',
    now: 'Check its reasons against the facts before you write it (`reason_check`, setup-judgment): a reason marked FALSE is dropped and the decision made again.',
    reason: 'reason_check moved from trade-session step 3 to setup-judgment: the pointer names it, shorter' },
  { old: 'A full cycle still runs its analysts in parallel, except those whose report the prompt gives under "Cached reports" (trade-session step 2): those reports are this cycle\'s; don\'t launch the role again.',
    now: 'A full cycle still runs its analysts in parallel, except those whose report the prompt gives under "Cached reports" (role-round): those reports are this cycle\'s; don\'t launch the role again.',
    reason: 'cached reports moved from trade-session step 2 to role-round: the pointer names it, shorter' },
  // The decision history tells a risk-manager veto apart from the model's own pass (decision-history.js vetoedIn).
  { old: 'Each history line is one decision: time, symbol and lane, what you did (entered, skipped, planned, managed, no-trade, flattened, blocked, error), the setup and side, the price, your reason, and what happened since, from closed bars only: ticks moved, whether a skipped setup would have hit +1R or -1R first, an entry\'s real position (open from its fill with R now, closed with its R, or "unknown" or "unavailable": then you don\'t know, so don\'t guess).',
    now: 'Each history line is one decision: time, symbol and lane, what you did (entered, skipped, vetoed, planned, managed, no-trade, flattened, blocked, error; skipped is your own pass, vetoed the risk manager\'s veto), the setup and side, the price, your reason, and what happened since, from closed bars only: ticks moved, whether a skipped or vetoed setup would have hit +1R or -1R first, an entry\'s real position (open from its fill with R now, closed with its R, or "unknown" or "unavailable": then you don\'t know, so don\'t guess).',
    reason: 'the history\'s new action word, vetoed (the risk manager\'s veto), told apart from skipped (the model\'s own pass)' },
];

// Edits made to the homes since the split (skill-split-late.js), each with its reason: the coverage test holds each
// home to its edited text, and a late edit that matches nothing fails.
const { withLate } = require('./skill-split-late');
const LATE = [
  { from: "It carries today's premarket plan (when today's premarket run failed, the \"Context unavailable\" line says \"premarket plan unavailable\": there is no plan yet, so trade from the bars and your skills; the runner retries the premarket between cycles, and once one succeeds the next cycles carry the plan; on very short bars, such as 1-minute, a retry rarely fits between cycles, so a failed premarket usually means trading the session without one), the news blackouts (in force, or the next one), the day so far (the \"day:\" line; outside RTH the \"overnight\" line), each fired strategy's track record (a `paper` one is marked: plan it only), and each open trade's state (setup, initial risk, stop, target, R now, best and worst): the `trade-session` skill says how to weigh them.",
    to: "It carries today's premarket plan (when today's premarket run failed, the \"Context unavailable\" line says \"premarket plan unavailable\": there is no plan yet, so trade from the bars and your skills; the runner retries the premarket between cycles, and once one succeeds the next cycles carry the plan; on very short bars, such as 1-minute, a retry rarely fits between cycles, so a failed premarket usually means trading the session without one), the news blackouts (in force, or the next one), the day so far (the \"day:\" line; outside RTH the \"overnight\" line), each fired rules strategy's track record (a `paper` one is marked: plan it only), and each open trade's state (setup, initial risk, stop, target, R now, best and worst): the `trade-session` skill says how to weigh them.",
    reason: "a fired strategy is a rules strategy; the composed trade fires nothing (fix/skills-stale-examples)" },
  { from: "CYCLE RESULT: no-trade - orb fired but relative volume 0.8x (skip rule)",
    to: "CYCLE RESULT: no-trade - compose_check: 3m momentum up false (volume 0.8x)",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples)" },
  { from: "Before your cycle, the runner has already: - cancelled leftover orders on a flat contract; - for strategies whose exit trails, applied the trailing stop: the initial stop until `trailActivateR`, then `trailGivebackR` behind the best price (both in the scan's `exit`); - for strategies with a time stop (`exit.max_bars`), closed a trade that has been open that long.", to: "Before your cycle, the runner has already: - cancelled leftover orders on a flat contract; - managed each open trade's exit: a composed one by its policy's exit mode (`trade-plan`); a rules one's trail or time stop (none active).",
    reason: "fix/skills-match-code: the runner manages a composed trade by its policy's exit mode; no rules strategy is active (strategies/retired.json)" },
  { from: "It carries today's premarket plan (when today's premarket run failed, the \"Context unavailable\" line says \"premarket plan unavailable\": there is no plan yet, so trade from the bars and your skills; the runner retries the premarket between cycles, and once one succeeds the next cycles carry the plan; on very short bars, such as 1-minute, a retry rarely fits between cycles, so a failed premarket usually means trading the session without one), the news blackouts (in force, or the next one), the day so far (the \"day:\" line; outside RTH the \"overnight\" line), each fired rules strategy's track record (a `paper` one is marked: plan it only), and each open trade's state (setup, initial risk, stop, target, R now, best and worst): the `trade-session` skill says how to weigh them.", to: "It carries today's premarket plan (when today's premarket run failed, the \"Context unavailable\" line says \"premarket plan unavailable\": there is no plan yet, so trade from the bars and your skills; the runner retries the premarket between cycles, and once one succeeds the next cycles carry the plan; on very short bars, such as 1-minute, a retry rarely fits between cycles, so a failed premarket usually means trading the session without one), the news blackouts (in force, or the next one), the day so far (the \"day:\" line; outside RTH the \"overnight\" line), and each open trade's state (setup, initial risk, stop, target, R now, best and worst): the `trade-session` skill says how to weigh them.",
    reason: "fix/skills-match-code: the runner manages a composed trade by its policy's exit mode; no rules strategy is active (strategies/retired.json)" },
  { from: "It gives only a count of working orders, the trend rule, and no scan details: read `list_open_orders` once; take the alignment and the scan's candidates from the bar briefing (`m15` `alignment`, `m3` `candidates`), and run `mtf_read` or `strategies_scan` only when it says there is no current briefing.", to: "It gives only a count of working orders, the trend rule, and no scan details: read `list_open_orders` once; take the alignment from the bar briefing (`m15` `alignment`), and run `mtf_read` only when it says there is no current briefing.",
    reason: "fix/skills-match-code: no rules strategy is active: the briefing's setups to check, not a scan's candidates" },
  { from: "The prompt also carries the last 10 closed bars and your last 10 cycle results (with several lanes, per lane: the `runner-lanes` skill): read them, and don't reverse a recent decision without saying what changed.",
    to: "The prompt also carries the last 10 closed bars and your last 10 cycle results (with several lanes, per lane: the `runner-lanes` skill): read them; each bar is decided on its own facts: a past pass is no reason to pass again.",
    reason: "fix/confluence-not-vetoes: \"no new reason since the last cycle\" was a soft veto the baseline passed on; each bar is decided on its own count (owner, 2026-10-21)" },
];
const LATE_STALE = (() => {
  const r = withLate(ALLOWED, LATE, units(require('fs').readFileSync(require('path').join(__dirname, '..', '..', BEFORE), 'utf8')));
  ALLOWED.splice(0, ALLOWED.length, ...r.allowed);
  return r.stale.map(l => l.from);
})();

// New text in the core, not from the old skill, each with its reason: the pointers to the pieces, and the one reaction
// the head trader must always have without loading kill-switch (that skill keeps the details).
const ADDED = [
  { now: 'A bare `VERDICT: APPROVE` with no size on the line → unreadable, even beside a Size line, prose or not ("Size: I\'d go with 3 contracts" with "VERDICT: approve"): not a trade yet → one restate of the Size and VERDICT lines; never a veto.',
    reason: 'feat/bias-bg (the context quiz, Q19): roles-ran.js approvedSize finds no size on a bare approval (an error, not a veto): the runner asks once to restate; then fix/quiz-side-doji (Q19 answered "Yes" 0/5): the prose Size line beside a bare approval said, not a trade yet' },
  { now: "**Phase 2's size.** A risk-manager approval whose Size line is prose (\"Size: I'd go with 3 contracts\") beside `VERDICT: APPROVE - size 3` is a readable approved size.",
    reason: 'feat/bias-bg (the context quiz, Q19): the head trader reads a prose Size line as the approved size, as roles-ran.js approvedSize does; only an unreadable approval is restated' },
  { now: 'Several lanes ("Lanes closed this cycle"), analysts on their own timeframe, or a setup "skipped: lower priority": the `runner-lanes` skill.', reason: 'pointer to runner-lanes' },
  { now: 'Why a setup did or didn\'t fire, and what earlier cycles saw: the `runner-logs` skill.', reason: 'pointer to runner-logs' },
  { now: '**Kill switch and account lock.** On `[kill-switch]`, `[allowed-accounts]` or `[account-lock]`: manage, protect or flatten only, end `blocked`, and never retry or trade another account: the user resolves it.',
    reason: 'kill-switch\'s reaction in one sentence, kept in the core so the head trader always has it; the details stay in kill-switch' },
  { now: 'The details: the `kill-switch` skill.', reason: 'pointer to kill-switch' },
  { now: 'A listed setup you don\'t compose: one line, `SKIP "<its read>": <the deciding fact>`.',
    reason: 'the owner (feat/ppc-setup-rates): "I don\'t like skipping setups, so we need to make sure we have reasons on setup skips"; the runner reads the lines into the cycle record (setup-skips.js)' },
  { now: '`planned`: only when the prompt says the runner runs the entry; else you place it (`trade-session` 4-6).', reason: 'the runner\'s entry (feat/entry-workflow): planned is the head trader\'s result only in an entry cycle the prompt names; on a harness where the runner runs no entry (Claude Code), the head trader places it (fix/confluence-not-vetoes: a Sonnet replay composed, approved and ended planned, and no order was sent)' },
];

// Which home each old unit belongs to: the fixture's line ranges (1-based, inclusive) and single units that moved out
// of a block that stays; every other unit belongs to the core (autonomous-trading).
const MOVED = {
  // Rule 1: several lanes, the policy priority, analysts on their own timeframe, the per-lane results.
  'runner-lanes': { lines: [[22, 52]] },
  // Rule 5: the kill switch, the allow-list, one runner per account.
  'kill-switch': { lines: [[107, 132]] },
  // Rule 3: the logs sentence, and the cycle's log.
  'runner-logs': { units: [
    'To see why a setup did or didn\'t fire, read that bar\'s record in `<FTH_HOME>/logs/scans-<day>.jsonl` (the runner\'s own log is `<FTH_HOME>/logs/autotrader-<day>.log`; your earlier cycles, with their prompts, tool calls, and skills loaded, are in `<FTH_HOME>/logs/cycles-<day>.jsonl` and `logs/cycles/<day>/`; the gate\'s decisions in `logs/gate-log.jsonl`; the runner records every decision point of the day in `<FTH_HOME>/sessions/<day>/`, as a replay is, with the broker field values the strategies read on each bar and an archive of the bars, for the adherence scorecard and training: the user\'s to score, not yours to edit).',
    'The cycle\'s log (`logs/cycles/<day>/`) holds the prompt and what it was built from.'] },
};

/** The old units each home must hold: Map home -> Map unit -> count (the core takes every unit not moved). */
function expectedHomes(beforeText) {
  const lines = beforeText.split('\n');
  const dropped = new Set(ALLOWED.filter(a => !a.copies && !a.now).map(a => a.old));
  const rest = count(units(beforeText).filter(u => !STRUCTURE.includes(u) && !dropped.has(u)));
  const out = new Map();
  for (const [home, m] of Object.entries(MOVED)) {
    const text = (m.lines || []).map(([a, b]) => lines.slice(a - 1, b).join('\n')).join('\n\n');
    const want = count([...units(text), ...(m.units || [])].filter(u => !STRUCTURE.includes(u) && !dropped.has(u)));
    for (const [u, n] of want) {
      if ((rest.get(u) || 0) < n) throw new Error(`${home}: "${u}" is not in the old skill ${n} time(s)`);
      rest.set(u, rest.get(u) - n);
    }
    out.set(home, want);
  }
  out.set(HOMES[0], new Map([...rest].filter(([, n]) => n > 0)));
  return out;
}

/** Old units (a changed one by its old text) outside the home their old section maps to, or missing from it: [] when each is home. */
function homeErrors(beforeText, texts) {
  const expected = expectedHomes(beforeText);
  const old = new Set(units(beforeText));
  const nowToOld = new Map(ALLOWED.flatMap(a => [a.now || []].flat().map(n => [n, a.old])));
  const bad = [];
  HOMES.forEach((home, i) => {
    const got = count(units(texts[i]).map(u => nowToOld.get(u) || u).filter(u => old.has(u) && !STRUCTURE.includes(u)));
    const want = expected.get(home);
    for (const u of new Set([...got.keys(), ...want.keys()])) {
      if ((got.get(u) || 0) !== (want.get(u) || 0)) bad.push(`${home}: ${JSON.stringify(u)} ${got.get(u) || 0} time(s), its old section maps ${want.get(u) || 0} here`);
    }
  });
  return bad;
}

/** New units in the core (neither old text nor an allowed change) beyond ADDED, or ADDED ones missing: [] when they match. */
function addedErrors(beforeText, coreText) {
  const old = new Set(units(beforeText));
  const changed = new Set(ALLOWED.flatMap(a => [a.now || []].flat()));
  const added = units(coreText).filter(u => !old.has(u) && !changed.has(u) && !STRUCTURE.includes(u));
  const want = ADDED.map(a => a.now);
  return [...added.filter(u => !want.includes(u)).map(u => `unlisted new text: ${u}`), ...want.filter(u => !added.includes(u)).map(u => `listed, not in the core: ${u}`)];
}

const homeTexts = () => HOMES.map(s => read(`skills/${s}/SKILL.md`));
const at = name => HOMES.indexOf(name);

test('autonomous-trading split: every unit of the old skill is in exactly one new home, in its old order', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, BEFORE))).digest('hex');
  assert.strictEqual(sha, BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  assert.deepStrictEqual(differences(read(BEFORE), homeTexts(), ALLOWED), []);
  assert.deepStrictEqual(orderErrors(read(BEFORE), homeTexts(), HOMES, ALLOWED), [], 'moved text keeps its old order in each home');
  assert.deepStrictEqual(homeErrors(read(BEFORE), homeTexts()), [], 'each unit is in the home its old section maps to');
  assert.deepStrictEqual(addedErrors(read(BEFORE), homeTexts()[0]), [], 'the core\'s new text is exactly the listed pointers and summary');
  for (const a of [...ALLOWED, ...ADDED]) assert.ok(a.reason, a.old || a.now);
});

test('autonomous-trading split: a unit moved to another home fails, though nothing is lost', () => {
  const old = read(BEFORE);
  const homes = homeTexts();
  const swap = pairs => homes.map((h, i) => (pairs[HOMES[i]] !== undefined ? pairs[HOMES[i]] : h));
  const addTo = (text, s) => text.replace('## Examples', `${s}\n\n## Examples`);
  // Rule 6's "`blocked` only when ..." out of the core into runner-logs.
  const B = /`blocked` only when the order gate, the gateway or the broker refused an\n {3}order this cycle; nothing fired, or you stood aside, is `no-trade`\.\n/.exec(homes[0])[0];
  const out = swap({ 'autonomous-trading': homes[0].replace(B, ''), 'runner-logs': addTo(homes[3], B.trim()) });
  assert.deepStrictEqual(differences(old, out, ALLOWED), [], 'a move loses nothing');
  assert.notDeepStrictEqual(homeErrors(old, out), [], 'but leaves its home');
  // A lane sentence from runner-lanes into the core.
  const L = 'A symbol\'s second lane adds only its own bars and signals; its\ntrend line, plan and day are the first lane\'s.';
  assert.ok(homes[1].includes(L));
  const lane = swap({ 'runner-lanes': homes[1].replace(L, ''), 'autonomous-trading': addTo(homes[0], L) });
  assert.deepStrictEqual(differences(old, lane, ALLOWED), []);
  assert.notDeepStrictEqual(homeErrors(old, lane), []);
  // A kill-switch sentence into the core.
  const K = 'Preflight reports it as a failed `account lock` check.';
  assert.notDeepStrictEqual(homeErrors(old, swap({ 'kill-switch': homes[2].replace(K, ''), 'autonomous-trading': addTo(homes[0], K) })), []);
  // New, unlisted text in the core fails too.
  assert.notDeepStrictEqual(addedErrors(old, addTo(homes[0], 'Retry a kill-switch refusal once.')), []);
});

test('autonomous-trading split: the comparison catches a lost, a doubled, an edited or a reordered sentence', () => {
  const old = read(BEFORE);
  const u = units(old);
  assert.ok(u.length > 70, `the units are fine-grained (${u.length})`);
  assert.ok(u.includes('Preflight reports it as a failed `account lock` check.'), 'a sentence is a unit');
  assert.ok(u.includes('CYCLE RESULT: blocked - [loss-streak] cooldown 18 min'), 'a code line is a unit');
  const homes = homeTexts();
  const swap = (name, text) => homes.map((h, i) => (i === at(name) ? text : h));
  const S = 'Preflight reports it as a failed `account lock` check.';
  const ks = homes[at('kill-switch')];
  assert.ok(ks.includes(S));
  // Lost, doubled, edited.
  assert.notDeepStrictEqual(differences(old, swap('kill-switch', ks.replace(S, '')), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap('runner-logs', `${homes[at('runner-logs')]}\n${S}\n`), ALLOWED), []);
  const edited = ks.replace('the runner starts only\nmanage cycles', 'the runner starts\nmanage cycles');
  assert.notStrictEqual(edited, ks);
  assert.notDeepStrictEqual(differences(old, swap('kill-switch', edited), ALLOWED), []);
  // Reordered: the two paragraphs swapped (nothing lost, the order changed).
  const P1 = /\*\*Kill switch\.\*\*[^]*?\n\n/.exec(ks)[0];
  const P2 = /\*\*One runner per broker account\.\*\*[^]*?\n\n/.exec(ks)[0];
  const swapped = ks.replace(P1, '\u0000').replace(P2, P1).replace('\u0000', P2);
  assert.notStrictEqual(swapped, ks);
  assert.deepStrictEqual(differences(old, swap('kill-switch', swapped), ALLOWED), [], 'a swap loses nothing');
  assert.notDeepStrictEqual(orderErrors(old, swap('kill-switch', swapped), HOMES, ALLOWED), [], 'but changes the order');
  // A pointer reverted to the text it replaced (the exception no longer needed) also fails: the list only shrinks.
  const loose = s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
  const lanes = homes[at('runner-lanes')];
  const reverted = lanes.replace(loose(ALLOWED[3].now), ALLOWED[3].old);
  assert.notStrictEqual(reverted, lanes);
  assert.notDeepStrictEqual(differences(old, swap('runner-lanes', reverted), ALLOWED), []);
  // A section heading dropped: each new skill keeps the format's three sections.
  assert.notDeepStrictEqual(differences(old, swap('runner-logs', homes[at('runner-logs')].replace('## Examples', '## Example')), ALLOWED), []);
});

test('autonomous-trading split: each skill has a short "Use when" index line, and autonomous-trading points to the rest', () => {
  for (const s of HOMES) {
    const d = parseFrontmatter(read(`skills/${s}/SKILL.md`)).data.description;
    assert.ok(d.length <= 160, `${s}: description ${d.length} chars, over 160`);
    assert.match(d, /^Use when /, s);
  }
  const core = flat(read('skills/autonomous-trading/SKILL.md'));
  for (const s of HOMES.slice(1)) assert.match(core, new RegExp(`the \`${s}\` skill`), `autonomous-trading points to ${s}`);
  // The moved jobs left the core: lanes, the kill switch and the lock, the logs.
  assert.doesNotMatch(core, /\*\*Several lanes\.\*\*|<FTH_HOME>\/STOP|One runner per broker account|scans-<day>\.jsonl|gate-log\.jsonl/);
  // Its rule numbers stay (rule 1, rule 4 are named in its text), and the result line is still its own.
  assert.match(core, /5\. \*\*Kill switch and account lock\.\*\* On `\[kill-switch\]`, `\[allowed-accounts\]` or `\[account-lock\]`: manage, protect or flatten only, end `blocked`, and never retry or trade another account: the user resolves it\. The details: the `kill-switch` skill\./);
  assert.match(core, /`CYCLE RESULT: <[^>]+> - <reason>`/);
});

// What these pointers named moved again in the trade-session split (tests/plugin/trade-session-split.test.js): the
// own-timeframe paragraph into runner-lanes, the trigger check stays in trade-session step 2, and step 6's refusal and
// unknown outcome into entry-outcome.
test('autonomous-trading split: the pointers are true (runner-lanes, trade-session step 2 and entry-outcome hold what was dropped)', () => {
  const ts = read('skills/trade-session/SKILL.md');
  const step = n => flat(new RegExp(`### ${n}\\. [^]*?(?=\\n### |\\n## )`).exec(ts)[0]);
  const lanes = flat(read('skills/runner-lanes/SKILL.md'));
  assert.match(lanes, /\*\*An analyst on its own timeframe\.\*\* When the prompt says "Each analyst reads its own timeframe"/);
  assert.match(lanes, /holds until its own timeframe's next bar close, so it may be up to one of its bars old/);
  assert.match(lanes, /You merge every analyst's latest report and decide once for the cycle\./);
  assert.match(step(2), /\*\*The trigger is checked too\.\*\*[^]*?3 bars of its own timeframe ago and never more than 45 minutes ago \(3 min on 1m, 9 min on 3m/);
  assert.match(step(6), /After placing: the `entry-outcome` skill\./);
  const s6 = flat(read('skills/entry-outcome/SKILL.md'));
  assert.match(s6, /`success: false` with an `errorCode` other than 6 \(`OrderPending`\) or 7 \(`UnknownError`\), its brackets included[^]*?\(cycle result `blocked`\); never send the entry again without its bracket/);
  assert.match(s6, /Any other error \(codes 6 and 7 included[^)]*\) is an unknown outcome, not a refusal[^]*?protects or closes any position without a covering stop first, and never re-sends the entry/);
});

test('autonomous-trading split: the per-cycle load shrinks; no role and no gate list changes', () => {
  // The head trader loads autonomous-trading every cycle, and reads every skill's index line (workspace/AGENTS.md).
  // The core and the four index lines together are smaller than the old skill and its one line.
  const indexLine = text => {
    const { data } = parseFrontmatter(text);
    return `- \`${data.name}\` (skills/${data.name}/SKILL.md): ${data.description}`;
  };
  const before = read(BEFORE).length + indexLine(read(BEFORE)).length;
  const after = read('skills/autonomous-trading/SKILL.md').length + homeTexts().reduce((n, t) => n + indexLine(t).length + 1, -1);
  assert.ok(after < before, `the core and the index lines are ${after} characters, not under the old ${before}`);
  const agents = read('workspace/AGENTS.md');
  for (const t of homeTexts()) assert.ok(agents.includes(indexLine(t)), `AGENTS.md lists ${parseFrontmatter(t).data.name}`);
  // No role's body uses the new skills: none loads or indexes them, so no role's prompt grows.
  const { loadRoles } = require('../../scripts/lib/role-skills');
  for (const a of loadRoles(ROOT)) for (const s of HOMES) assert.ok(!a.skills.includes(s) && !a.index.includes(s), `${a.name}: ${s}`);
  // The gate's skill lists are unchanged: the core stays out of them (the prompt says to follow it), and so do the pieces.
  const { REQUIRED_FOR_ENTRY, SITUATIONAL } = require('../../scripts/lib/trading/skills-loaded');
  assert.deepStrictEqual(REQUIRED_FOR_ENTRY, ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks']);
  for (const s of HOMES) assert.ok(!SITUATIONAL.some(x => x.skill === s), s);
  // Every prompt still names the core.
  const A = require('../../scripts/lib/autotrader');
  const p = A.prompts(A.validateConfig({}), new Date('2026-10-07T14:30:00Z'));
  assert.match(p.trade([{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z', c: 1, file: '/b.json', contractId: 'MNQ' } }]), /Follow the autonomous-trading skill\./);
  for (const s of STRUCTURE) for (const t of homeTexts()) assert.ok(t.includes(`## ${s}`));
});

test('autonomous-trading-split: every late edit matches a unit of the homes', () => {
  assert.deepStrictEqual(LATE_STALE, []);
});

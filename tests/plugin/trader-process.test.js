'use strict';

// The trader-process skill: the order a trader thinks in (HTF, context, location, setup, confluence, entry, risk,
// decision, management) and its PLAN block, mapped onto the roles. It orders the thinking and adds no filter: the
// priority order (strategy-library) decides. These tests pin its key sentences, the roles that do its steps, the
// cycle prompt that names it, and its size.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
const { prompts, validateConfig, PLAN_STEPS } = require('../../scripts/lib/autotrader');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SKILL = 'skills/trader-process/SKILL.md';
const flat = t => t.replace(/\s+/g, ' ');

// The size budget (bytes). The skill is embedded in full in every mapped role's opencode prompt, so it stays small;
// the cycle prompt names only the first and last step (the skill holds the block).
const SKILL_MAX = 4800;
const PLAN_BLOCK_MAX = 760;
const PROMPT_ADDED_MAX = 100;

// Each role and its steps (the skill's "Who does which step" table). Analysts never write step 2: their reports
// can be served from the cache, where a window, the news or the account would be stale.
const ROLES = {
  'market-structure-analyst': '1, 3, 4',
  'trend-momentum-analyst': '1, 4',
  'volume-liquidity-analyst': '3, 5',
  'news-calendar-analyst': '2 (news)',
  'risk-manager': '2, 5, 7, 8 (phase 2)',
};
const ANALYSTS = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst'];

/** A briefing built by briefing.js from the parity bars, with one scan candidate (as the runner builds it). */
function realBriefing() {
  const B = require('../../scripts/lib/trading/briefing');
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const bars = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'));
  const scan = [{ name: 'orb', candidate: true, direction: 'long', status: 'active', confluence: { with: [], against: [] }, entryRef: 1, stopDistance: 10, exit: { trailActivateR: 2 } }];
  return B.buildBriefing({ symbol: 'NQ', bars, minutes: 3, scan });
}

const planBlock = text => {
  const m = /```text\nPLAN:\n([^`]*)```/.exec(text);
  return m ? m[1].trim().split('\n') : null;
};

test('trader-process: frontmatter and the required sections', () => {
  const text = read(SKILL);
  const { data } = parseFrontmatter(text);
  assert.strictEqual(data.name, 'trader-process');
  assert.ok(String(data.description || '').length > 40);
  for (const h of ['## When to Use', '## How It Works', '## Examples']) assert.ok(text.includes(`\n${h}\n`), h);
  assert.ok(text.indexOf('## When to Use') < text.indexOf('## How It Works') && text.indexOf('## How It Works') < text.indexOf('## Examples'));
});

test('trader-process: the steps start from the higher timeframe, in the fixed order', () => {
  const text = read(SKILL);
  const names = ['HTF', 'Context', 'Location', 'Setup', 'Confluence', 'Entry', 'Risk', 'Decision', 'Management'];
  let at = -1;
  names.forEach((n, i) => {
    const k = text.indexOf(`${i + 1}. **${n}.**`);
    assert.ok(k > at, `step ${i + 1} ${n} in order`);
    at = k;
  });
});

test('trader-process: it orders the thinking and adds no filter; the priority order decides', () => {
  const t = flat(read(SKILL));
  const pins = [
    'It adds no filter and no veto',
    '**The priority order decides** (strategy-library, "The priority order"): take, skip and size.',
    "Only its hard stops and the gate's end a plan early.",
    '**No setup without a fired strategy.**',
    'are confluence only: they never make a trade on their own.',
    '**Management always runs.** Protecting, managing and exiting an open position, and the end-of-day flatten, go ahead whatever steps 1-8 say; a no-entry window or a wait never blocks an exit or a risk reduction.',
    "**`unknown`, never invented.** A value the briefing or a report doesn't give is written `unknown` (or `unavailable`); never estimate one.",
    'Take, skip or wait, decided with the priority order; write its ONE main reason. The counts never overrule it.',
    'Never loosen the stop.',
    'Its STRATEGY.md and the priority order judge it, not this label.',
    '1. **HTF.** The 4h, 1h and 15m trends and structure frame everything below.',
    "The bias agrees with the gate's `Trend rule:` line; where they differ, the Trend rule wins, and the plan says so.",
    "Continuation is a strategy without `mtf: reversal`, with the Trend rule's prevailing trend;",
    'The three market analysts never write step 2: a cached report would carry a stale window.',
    "In a cached report, take this bar's 3m facts from the briefing.",
    "Phase 2 writes line 2 fresh from this cycle's briefing; phase 1 writes no PLAN line.",
    "The cycle result's reason is line 8's.",
    '| news-calendar-analyst | 2 (news) |',
  ];
  for (const p of pins) assert.ok(t.includes(p), p);
  // No filter of its own: no "stop at the first step", no condition the strategy doesn't have, no restated order.
  assert.doesNotMatch(t, /stop at the first step|counts? (?:may|can) overrule|confluence (?:makes|is) (?:a|the) trade|only at an HTF level after a sweep|`mixed`[^.]*wait/i);
  assert.doesNotMatch(t, /1\. \*\*Hard stops/, 'the priority order is pointed to, never restated');
});

test('trader-process: the PLAN is reasoning, not a claim list, and its fields are the briefing\'s', () => {
  const text = read(SKILL);
  assert.ok(flat(text).includes('Your reasoning, not a claim list. If your role\'s instructions give a fact-claim line, state facts only there, in its forms.'));
  // Nothing tells the model to copy PLAN lines into a FACTS line (not on main) or offers PLAN items as claims.
  assert.doesNotMatch(text, /FACTS/);
  const block = planBlock(text);
  assert.ok(block, 'the template block');
  assert.strictEqual(block.length, PLAN_STEPS.length);
  block.forEach((line, i) => assert.ok(line.startsWith(`${i + 1} ${PLAN_STEPS[i]}: `), line));
  assert.ok(Buffer.byteLength(`PLAN:\n${block.join('\n')}`) <= PLAN_BLOCK_MAX, 'the template stays tiny');
  // Every field the template names resolves, path and all, in a real briefing built by briefing.js (with a candidate
  // from a scan), and the template names exactly these.
  const fields = [...block.join('\n').matchAll(/\b((?:m3|m15|h1|candidate)(?:\.[a-zA-Z0-9]+)+)/g)].map(m => m[1]);
  assert.deepStrictEqual(fields, [
    'h1.h4.trend', 'h1.h1.trend', 'm15.frame.trend', 'm3.trendRule',
    'm3.window', 'm3.windowEntries', 'm3.news.inBlackout', 'm3.regime.primary',
    'm3.vwap.side', 'm3.location.priorValue', 'm3.nearestLiquidity',
    'candidate.name', 'candidate.direction',
    'candidate.inTheWay.R', 'candidate.needR',
  ]);
  const b = realBriefing();
  const roots = { m3: b.sections.m3.data, m15: b.sections.m15.data, h1: b.sections.h1.data, candidate: b.sections.m3.data.candidates[0] };
  for (const f of fields) {
    const [root, ...keys] = f.split('.');
    let at = roots[root];
    for (const k of keys) {
      assert.ok(at && typeof at === 'object' && Object.prototype.hasOwnProperty.call(at, k), `${f}: no ${k}`);
      at = at[k];
    }
    assert.ok(at !== undefined, f);
  }
  // The trend frames the template reads are the trends mtf.js writes; the regime is one of the regime module's.
  assert.ok(['up', 'down', 'range', 'unknown'].includes(b.sections.h1.data.h4.trend));
  const { PRIMARY: REGIMES } = require('../../scripts/lib/trading/regime');
  assert.ok(REGIMES.includes(b.sections.m3.data.regime.primary));
  // The account comes from phase 1's own lines, the only account facts the roles are shown.
  const rm = read('agents/risk-manager.md');
  assert.match(block[1], /account <phase 1 Budget, Attempt>/);
  assert.match(rm, /\nBudget: per trade <\$>/);
  assert.match(rm, /\nAttempt: <account>/);
  const briefing = read('scripts/lib/trading/briefing.js');
  // The example fills every line, with real values (a session window, a regime).
  const example = planBlock(text.slice(text.indexOf('## Examples')));
  assert.ok(example);
  example.forEach((line, i) => assert.ok(line.startsWith(`${i + 1} ${PLAN_STEPS[i]}: `), line));
  const { PRIMARY } = require('../../scripts/lib/trading/regime');
  const regime = /regime ([a-z-]+)/.exec(example[1])[1];
  assert.ok(PRIMARY.includes(regime), regime);
  const win = /window ([a-z ]+?),/.exec(example[1])[1];
  assert.ok(briefing.includes(`'${win}'`), win);
  // The example's setup names a strategy that exists, is active and is a continuation (no `mtf: reversal`).
  const [, strat, kind] = /^4 Setup: ([a-z0-9_]+) (?:long|short) (continuation|reversal)$/.exec(example[3]);
  const doc = read(`strategies/${strat}/STRATEGY.md`);
  const meta = parseFrontmatter(doc).data;
  assert.strictEqual(meta.status, 'active', strat);
  assert.strictEqual(meta.mtf === 'reversal', kind === 'reversal', strat);
  // The example's rule is the briefing's own Trend rule line, as the briefing writes it.
  const rule = /rule (.+)$/.exec(example[0])[1];
  assert.ok(`${b.sections.m3.data.trendRule}`.startsWith(`Trend rule: ${rule}`), rule);
});

test('trader-process: on an analyst\'s own timeframe, m3 is the frame\'s bar part and the trend rule is the runner\'s', () => {
  const B = require('../../scripts/lib/trading/briefing');
  const { candles } = require('../../scripts/lib/trading/mtf');
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const bars = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'));
  const first = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3 });
  const whole = candles(bars, 15).filter(c => c.complete).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
  const f = B.buildFrameBriefing({ symbol: 'NQ', bars: whole, minutes: 15, first });
  const bar = f.sections.bar.data;
  // Every m3 path but the trend rule and the setups resolves on the frame's bar part.
  const block = planBlock(read(SKILL));
  const m3 = [...block.join('\n').matchAll(/\bm3\.([a-zA-Z0-9.]+)/g)].map(m => m[1]).filter(p => p !== 'trendRule');
  assert.ok(m3.length >= 6);
  for (const p of m3) {
    let at = bar;
    for (const k of p.split('.')) { assert.ok(at && Object.prototype.hasOwnProperty.call(at, k), `bar.${p}`); at = at[k]; }
  }
  // The frame carries no trend rule of its own, and the skill says where the rule and the setups come from.
  assert.match(bar.trendRule, /not in a 15m briefing/);
  assert.ok(!('candidates' in bar));
  assert.ok(flat(read(SKILL)).includes("on your own timeframe's briefing `m3` is its `bar`: take `rule` and the candidates from the runner's briefing or the cycle prompt."));
});

test('trader-process: a candidate with nothing in its way has room, not an unknown one', () => {
  const B = require('../../scripts/lib/trading/briefing');
  const r = { name: 'orb', candidate: true, direction: 'long', status: 'active', confluence: { with: [], against: [] }, entryRef: 1, stopDistance: 10, exit: { trailActivateR: 2 } };
  const c = B.candidate(r, 100, [], {});
  // No level ahead, a known stop: inTheWay is null, stopPoints is set (what the skill's guidance reads).
  assert.strictEqual(c.inTheWay, null);
  assert.ok(c.stopPoints > 0);
  assert.ok(flat(read(SKILL)).includes('A null `candidate.inTheWay` with a stop (`stopPoints`) means nothing in its way: room enough, not `unknown`.'));
  // Without a stop, inTheWay is null too: that one is unknown (the guidance names the stop).
  const noStop = B.candidate({ ...r, stopDistance: null }, 100, [['prior RTH high', 120]], {});
  assert.strictEqual(noStop.inTheWay, null);
  assert.ok(!(noStop.stopPoints > 0));
});

test('trader-process: no market numbers (thresholds live in strategies and the rulebook)', () => {
  const how = read(SKILL).split('## Examples')[0];
  assert.doesNotMatch(how.replace(/\b[14]h\b|\b3m\b|\bm3\b|\bm15\b|\bh1\.h[14]\b|steps 1-8/g, ''), /\d+(?:\.\d+)?\s*(?:%|R\b|x\b|ticks?\b|points?\b|pts\b)|\$\d|\b\d{3,}\b/);
});

test('trader-process: every failure category of the scorecard maps to a step', () => {
  const text = read(SKILL);
  const { CATEGORIES } = require('../../scripts/lib/replay/scorecard');
  for (const c of CATEGORIES.filter(x => x !== 'right' && x !== 'unchecked')) {
    assert.match(flat(text), new RegExp(`Scorecard failures, by step: [^\\n]*\\b${c} (?:\\d|the false line's)`), c);
  }
});

test('trader-process: each mapped role lists the skill, says to load it, and names its steps', () => {
  const table = read(SKILL);
  for (const [role, steps] of Object.entries(ROLES)) {
    const { data, body } = parseFrontmatter(read(`agents/${role}.md`));
    // Its core (role-skills, the load sentence), never only in its index (role-index).
    assert.ok(Array.isArray(data['role-skills']) && data['role-skills'].includes('trader-process'), `${role}: role-skills`);
    assert.match(flat(body), /Load the skills? [^.]*`trader-process`/, `${role}: its load sentence`);
    assert.match(body, /trader process/, `${role}: names its steps`);
    assert.ok(table.includes(`| ${role} | ${steps} |`), `${role}: the skill's table`);
  }
  // The analysts' reports carry their PLAN lines under the Data line, and never step 2 (a cached report goes stale).
  for (const role of ANALYSTS) {
    const t = read(`agents/${role}.md`);
    assert.match(t, /```text\n## [^\n]*\nData: [^\n]*\n(?:\d [A-Za-z]+: \/ )*\d [A-Za-z]+: <the PLAN lines, trader-process skill>\n/, role);
    assert.doesNotMatch(t, /\b2 Context\b/, role);
  }
  const rm = flat(read('agents/risk-manager.md'));
  // Phase 2: the PLAN lines (line 2 fresh), then the VERDICT line; a fact-claim line, where the role's instructions
  // give one, comes last (the fact-check reads from it to the end of the report). Phase 1 writes none.
  const order = "PLAN lines first: 2 Context (fresh from this cycle's briefing), 5 Confluence, 7 Risk and 8 Decision (the `trader-process` skill); then your VERDICT line; if your role's instructions give a fact-claim line, it goes last, after the VERDICT. Output exactly one of:";
  assert.ok(rm.includes(order));
  // PLAN before VERDICT, in the instructions and in the output block that follows them.
  const at = rm.indexOf(order);
  assert.ok(at > 0 && rm.indexOf('PLAN lines first') < rm.indexOf('then your VERDICT line') && rm.indexOf('then your VERDICT line') < rm.indexOf('it goes last, after the VERDICT'));
  assert.ok(rm.indexOf('VERDICT: APPROVE', at) > at, 'the verdict block follows the PLAN instruction');
  assert.ok(rm.includes('Phase 1 writes no PLAN line; its output below stays as it is.'));
  const phase1 = rm.slice(rm.indexOf('## Phase 1'), rm.indexOf('## Phase 2'));
  assert.doesNotMatch(phase1, /PLAN|\b2 Context\b/);
  // The news analyst isn't cached (report-cache.js): its report gives the news line of step 2.
  const { ANALYSTS: CACHED } = require('../../scripts/lib/trading/roles-ran');
  assert.ok(!CACHED.includes('news-calendar-analyst'));
  assert.match(read('agents/news-calendar-analyst.md'), /\n2 Context: news <clear\|blackout\|unknown> now; next <HH:MM ET event \| none>\n```/);
  // The gate's news (the briefing's m3.news) wins over the analyst's own read.
  assert.ok(flat(read('agents/news-calendar-analyst.md')).includes("That line is your own read and proposal. The bar briefing's `m3.news` is the gate's and the source of truth: phase 2's line 2 takes the news from it, and it wins when the two differ."));
  assert.match(flat(read('skills/trade-session/SKILL.md')), /Decide top-down in the `trader-process` skill's order[^.]*write its PLAN block before your result line; the checks below fill its lines\. It orders the thinking and adds no filter: the priority order decides\./);
});

test('trader-process: the executor executes; it carries no PLAN and no analysis', () => {
  const { data, body } = parseFrontmatter(read('agents/trade-executor.md'));
  assert.deepStrictEqual([...data['role-skills'], ...(data['role-index'] || [])], ['broker-mcp', 'order-mechanics', 'order-failures', 'order-rationale', 'trade-journal', 'gate-refusals', 'broker-refusals']);
  assert.ok(body.includes("You execute. You don't analyse, re-plan, or second-guess."));
  assert.ok(flat(body).includes('- Entry: enter only on the approved verdict and its fired trigger; never anticipate.'));
  assert.ok(flat(body).includes('- Management: protect and exit, always; move stops or scale out as the plan says.'));
  assert.doesNotMatch(body, /trader-process|trader process|PLAN|\b[1-9] (?:HTF|Context|Location|Setup|Confluence|Risk|Decision)\b/);
  assert.ok(!read('skills/trader-process/SKILL.md').includes('| trade-executor |'));
});

test('trader-process: every trade cycle prompt names the skill and the PLAN steps, within the size budget', () => {
  const now = new Date('2026-04-27T14:33:05Z');
  const steps = `trader-process skill's PLAN (1 ${PLAN_STEPS[0]} to ${PLAN_STEPS.length} ${PLAN_STEPS[PLAN_STEPS.length - 1]})`;
  for (const harness of ['claude', 'codex', 'qwen', 'opencode']) {
    for (const extra of [{}, { paper: true }, { cycle: 'lean' }]) {
      const p = prompts(validateConfig({ harness, premarketAt: '', timeframe: 3, account: '7', ...extra }), now, '/r');
      const trade = p.trade('MNQ');
      assert.ok(trade.includes(steps), `${harness} ${JSON.stringify(extra)}`);
      // Before the result line, which stays last.
      assert.ok(trade.indexOf(steps) < trade.indexOf('Your last line must be exactly'));
      assert.ok(p.trade('MNQ', { manageOnly: true }).includes(steps), 'manage cycles too: step 9');
      // Premarket and end of day are not trade decisions.
      assert.ok(!p.premarket('MNQ').includes('trader-process') && !p.eod().includes('trader-process'));
    }
  }
  const text = prompts(validateConfig({ harness: 'claude', premarketAt: '', timeframe: 3, account: '7' }), now, '/r').trade('MNQ');
  const added = /( Write the trader-process skill's PLAN [^.]*\.)/.exec(text)[1];
  assert.ok(Buffer.byteLength(added) <= PROMPT_ADDED_MAX, `${Buffer.byteLength(added)} bytes added to the cycle prompt`);
  assert.ok(Buffer.byteLength(read(SKILL)) <= SKILL_MAX, `${Buffer.byteLength(read(SKILL))} bytes of skill, embedded in each mapped role`);
});

test('trader-process: the generated opencode roles carry it in full, and the executor does not', () => {
  const generated = JSON.parse(read('workspace/opencode.json'));
  const body = parseFrontmatter(read(SKILL)).body;
  for (const role of Object.keys(ROLES)) {
    assert.ok(generated.agent[role].prompt.includes(`<skill name="trader-process">\n${body.trim()}\n</skill>`), role);
  }
  assert.ok(!generated.agent['trade-executor'].prompt.includes('trader-process'));
});

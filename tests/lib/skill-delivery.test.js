'use strict';

// Every skill reaches the model, proven per skill (the owner: "I want to make sure that all of the skills are loaded
// and confirmed via unit test"), by how skill-coverage.js classifies it: (a) named in every harness's cycle load list,
// (b) its whole current body embedded and attested when its fact is in the briefing, and absent without it, (c) in its
// desk role's prompt, (e) in the head prompt, (d) in no trade cycle's prompt. skills/ is read at run time: a new skill,
// a renamed one or a new trigger without a fixture here fails.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../../scripts/lib/skill-coverage');
const SS = require('../../scripts/lib/situational-skills');
const HP = require('../../scripts/lib/head-prompt');
const CA = require('../../scripts/lib/cycle-skills-attest');
const B = require('../../scripts/lib/trading/briefing');
const { validateConfig, prompts, cycleLoaded } = require('../../scripts/lib/autotrader');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const rows = C.classify(ROOT);
const of = cls => rows.filter(r => r.class === cls).map(r => r.skill);
const NOW = new Date('2026-04-23T14:03:00.000Z');
const ITEMS = [{ symbol: 'MNQ', bar: { t: '2026-04-23T14:00:00.000Z', c: 21500, file: '/tmp/bars.json', contractId: 'MNQ' } }];
const HARNESSES = ['claude', 'opencode', 'qwen', 'codex'];
const cfgOf = harness => validateConfig({ harness, account: '7', sessions: ['09:30-12:00@America/New_York'] });
const FLAT = { id: 7, at: NOW.toISOString(), balance: 50000, positions: [], workingOrders: 0 };
const OPEN = { ...FLAT, positions: [{ contractId: 'MNQ', type: 1, size: 1, averagePrice: 21500 }], workingOrders: 2, openTrades: ['Open trade MNQ long 1 @ 21500.'] };
const LONG_RULE = 'Trend rule: LONG allowed (prevailing 4h up); short only as a reversal';
const brief = (m3 = {}) => ({ symbol: 'MNQ', minutes: 3, sections: { m3: { data: { windowEntries: 'allowed', trendRule: LONG_RULE, ...m3 } } } });
const block = s => HP.block(s, HP.skillBody(ROOT, s));

// Briefings built from the parity bars that hold a setup moment's rejection, and a break (the reactions the line lists).
const bars = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
const built = [];
for (let i = 300; i < bars.length && built.length < 60; i += 5) { try { built.push(B.buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: bars.slice(Math.max(0, i - 500), i + 1), minutes: 3 })); } catch (_err) { /* none */ } }
const SM = require('../../scripts/lib/learning/setup-moments');
const reactionBriefing = rel => {
  const b = built.find(x => {
    const m3 = x.sections.m3.data;
    const m = SM.setupMoment(m3.candles, { barClose: Date.parse(m3.bar.t) + x.minutes * 60000 });
    return m3.windowEntries === 'allowed' && m.moment && m.reactions.some(r => r.rel === rel && (r.dir === 'up' || r.dir === 'down'));
  });
  assert.ok(b, `the parity bars hold a ${rel} setup moment`);
  return b;
};
// The same briefing with its setup candle's reactions gone (no moment): the absent fixture.
const noMoment = b => ({ ...b, sections: { ...b.sections, m3: { ...b.sections.m3, data: { ...b.sections.m3.data, candles: {} } } } });
const expanding = (levels = []) => ({ '15m': { state: 'expanding', box: { low: 21480, high: 21490, levels }, break: { dir: 'up', expansion: true } } });
const CISD = { '15m': { dir: 'bullish', status: 'touched', displacement: 'strong', engulfing: true } };
const DECLARED = { long: { vwapAtr: 1, ema20Atr: 1, overnight: 'inside', dayMoveAtr: 1, regime: 'with' }, short: { vwapAtr: -1, ema20Atr: -1, overnight: 'inside', dayMoveAtr: -1, regime: 'against' } };

/** Per table entry: a situation where its fact is present, and the same without it. */
const FIXTURES = {
  open: { present: { state: OPEN }, absent: { state: FLAT } },
  working: { present: { state: { ...FLAT, entryLines: ['entry MNQ buy 1 @ 21490 (stop 21480, target 21510)'] } }, absent: { state: FLAT } },
  leftover: { present: { state: { ...FLAT, workingOrders: 2 } }, absent: { state: FLAT } },
  cisd: { present: { state: FLAT, briefings: [brief({ cisd: CISD })] }, absent: { state: FLAT, briefings: [brief({ cisd: { '15m': { ...CISD['15m'], status: 'void' } } })] } },
  compression: { present: { state: FLAT, briefings: [brief({ compression: expanding() })] }, absent: { state: FLAT, briefings: [brief({ compression: {} })] } },
  rejected: { present: () => ({ state: FLAT, briefings: [reactionBriefing('rejected')] }), absent: () => ({ state: FLAT, briefings: [noMoment(reactionBriefing('rejected'))] }) },
  broke: { present: () => ({ state: FLAT, briefings: [reactionBriefing('broke')] }), absent: () => ({ state: FLAT, briefings: [noMoment(reactionBriefing('broke'))] }) },
  fvg: { present: { state: FLAT, briefings: [brief({ fvgs: { '5m': [{ retest: 'closed inside' }] } })] }, absent: { state: FLAT, briefings: [brief({ fvgs: { '5m': [{ retest: null }] } })] } },
  'cisd-timing': { present: { state: FLAT, briefings: [brief({ compression: expanding(), cisd: { '3m': { ...CISD['15m'], status: 'bounced' } } })] }, absent: { state: FLAT, briefings: [brief({ compression: expanding() })] } },
  entry: { present: { state: FLAT, briefings: [brief({ compression: expanding() })] }, absent: { state: FLAT, briefings: [brief({})] } },
  risk: { present: { state: FLAT, briefings: [brief({ compression: expanding() })] }, absent: { state: FLAT, briefings: [brief({})] } },
  attempt: { present: { state: { ...FLAT, attempts: [{ account: 'x', status: 'active' }] }, briefings: [brief({ compression: expanding() })] }, absent: { state: FLAT, briefings: [brief({ compression: expanding() })] } },
  level: { present: { state: FLAT, briefings: [brief({ compression: expanding([{ name: 'overnight low', edge: 'top' }]) })] }, absent: { state: FLAT, briefings: [brief({ compression: expanding() })] } },
  sweep: { present: { state: FLAT, briefings: [brief({ sweeps: [{ name: 'equal highs' }] })] }, absent: { state: FLAT, briefings: [brief({ sweeps: [] })] } },
  vwap: { present: { state: FLAT, briefings: [brief({ vwap: { side: 'above' } })] }, absent: { state: FLAT, briefings: [brief({})] } },
  declared: { present: { state: FLAT, briefings: [brief({ declared: DECLARED })] }, absent: { state: FLAT, briefings: [brief({})] } },
  trend: { present: { state: FLAT, briefings: [brief({})] }, absent: { state: OPEN, briefings: [brief({})] } },
  day: { present: { state: FLAT, briefings: [brief({})] }, absent: { state: FLAT } },
  structure: { present: { state: FLAT, briefings: [brief({ lastBreak: { last: { kind: 'BOS' } } })] }, absent: { state: FLAT, briefings: [brief({ lastBreak: { last: null } })] } },
  window: { present: { state: FLAT, briefings: [brief({ windowEntries: 'refused' })] }, absent: { state: FLAT, briefings: [brief({})] } },
};
const situation = f => (typeof f === 'function' ? f() : f);
const LOADED = cycleLoaded(cfgOf('claude'));
const ids = facts => facts.map(f => f.id);

// Each skill's class, written out: a skill moved between classes (a table row dropped, a role's list changed, a skill
// added or retired) is a deliberate edit here, never a silent one.
const EXPECTED = {
  a: ['autonomous-trading', 'confluence-counting', 'day-context', 'htf-to-ltf', 'multi-timeframe-analysis',
    'setup-judgment', 'trade-lifecycle', 'trade-plan', 'trade-session'],
  b: ['bos-vs-choch', 'breakout', 'breakout-vs-fakeout', 'candle-reading', 'cisd', 'compression', 'daily-bias',
    'entry-outcome', 'fair-value-gaps', 'fib-retracement', 'invalidation', 'leftover-orders', 'levels-and-reactions',
    'manage-position', 'momentum-and-volume', 'mtf-bias-filter', 'position-sizing', 'prop-challenge-pacing',
    'pullback-vs-reversal', 'rejection', 'session-timing', 'take-profit', 'top-down-entry', 'trend-vs-range',
    'vwap-volume-profile'],
  c: ['absorption', 'broker-mcp', 'broker-refusals', 'contract-roll', 'exchange-holidays', 'gate-refusals',
    'gate-refusals-cycle', 'gate-refusals-limits', 'gate-refusals-positions', 'harness-root', 'market-snapshot',
    'micro-mini-specs', 'news-blackouts', 'order-failures', 'order-mechanics', 'order-rationale', 'order-types',
    'prop-pacing-judgment', 'reason-check', 'setup-expectancy', 'strategy-authoring', 'strategy-gate-checks',
    'strategy-library', 'strategy-rules', 'strategy-scan', 'strategy-tools', 'tool-arguments', 'trade-journal',
    'trade-review', 'trading-agent-security', 'trend-momentum-indicators'],
  d: ['broker-bar-fields', 'design-self-review', 'end-of-day', 'gate-refusals-skills', 'kill-switch', 'lean-cycle',
    'live-session-records', 'order-plan', 'premarket', 'prop-evaluator', 'replay', 'replay-labels', 'replay-resume',
    'replay-scorecard', 'runner-lanes', 'runner-logs', 'strategy-backtest', 'timeframe-sources', 'training-loop',
    'training-verdict', 'user-commands'],
  e: ['bar-briefing', 'role-round', 'trader-process'],
};

test('the class snapshot: every skill in the class written for it', () => {
  const now = {};
  for (const r of rows) (now[r.class] = now[r.class] || []).push(r.skill);
  for (const k of Object.keys(now)) now[k].sort();
  assert.deepStrictEqual(now, EXPECTED);
});

test('drift guard: every skill classified; every table entry has a delivery fixture, and every fixture an entry', () => {
  const skills = fs.readdirSync(path.join(ROOT, 'skills')).filter(n => fs.existsSync(path.join(ROOT, 'skills', n, 'SKILL.md'))).sort();
  assert.deepStrictEqual(rows.map(r => r.skill), skills);
  assert.deepStrictEqual(rows.filter(r => !r.class).map(r => r.skill), []);
  assert.deepStrictEqual(Object.keys(FIXTURES).sort(), SS.TABLE.map(e => e.id).sort(), 'a table entry needs its fixture here (present and absent)');
});

test('(a) every-cycle skills: named in the cycle prompt\'s load list on every harness the runner drives', () => {
  const skills = of('a');
  assert.ok(skills.length >= 9, skills.join());
  for (const harness of HARNESSES) {
    const p = prompts(cfgOf(harness), NOW, ROOT).trade(ITEMS, { state: FLAT });
    for (const s of skills) assert.ok(new RegExp(`\\b${s}\\b`).test(p), `${harness}: ${s} is not in the cycle prompt`);
  }
});

test('(b) situational skills: each one\'s whole current body embedded and attested where its fact is, never where it isn\'t', () => {
  const proven = new Set();
  const home = tmpDir();
  for (const e of SS.TABLE) {
    const fx = FIXTURES[e.id];
    const present = situation(fx.present);
    const absent = situation(fx.absent);
    assert.ok(ids(SS.factsOf(present)).includes(e.id), `${e.id}: its fact is in the present fixture`);
    assert.ok(!ids(SS.factsOf(absent)).includes(e.id), `${e.id}: its fact is not in the absent fixture`);
    const chosen = SS.choose(ROOT, SS.factsOf(present), { loaded: LOADED });
    const text = SS.situationText(ROOT, chosen);
    const prompt = prompts(cfgOf('claude'), NOW, ROOT).trade(ITEMS, { state: present.state, cycleSkills: text });
    const w = SS.writeSituation(home, ROOT, chosen);
    const att = w ? CA.attestation({ file: w.file, text: w.text, root: ROOT, cycle: '0123456789abcdef' }) : null;
    if (e.section) {
      const part = SS.sectionOf(ROOT, SS.SECTIONS[e.section]);
      assert.ok(part && prompt.includes(part), `${e.id}: the ${e.section} part is in the prompt`);
      proven.add(SS.SECTIONS[e.section].skill);
    }
    for (const s of e.skills || []) {
      if (LOADED.includes(s)) continue;
      assert.ok(prompt.includes(block(s)), `${e.id}: ${s}'s whole body is in the prompt`);
      assert.ok(att && att.skills.includes(s), `${e.id}: ${s} is attested`);
      proven.add(s);
      // Absent: no false embed, unless another fact of the absent fixture owns it.
      const others = SS.factsOf(absent).filter(f => (f.skills || []).includes(s));
      const off = SS.situationText(ROOT, SS.choose(ROOT, SS.factsOf(absent), { loaded: LOADED }));
      if (!others.length) assert.ok(!off.includes(`<skill name="${s}">`), `${e.id}: ${s} is embedded without its fact`);
    }
  }
  assert.deepStrictEqual(of('b').filter(s => !proven.has(s)), [], 'every (b) skill proven by a fixture');
});

test('(c) desk role skills: in the role\'s own prompt (its skills embedded, its index listed)', () => {
  const RP = require('../../scripts/lib/role-prompt');
  const roles = require('../../scripts/lib/role-skills').loadRoles(ROOT);
  const text = Object.fromEntries(roles.map(r => [r.name, RP.claudeRoleText(ROOT, r.name)]));
  for (const s of of('c')) {
    const holders = roles.filter(r => r.skills.includes(s) || r.index.includes(s));
    assert.ok(holders.length, `${s}: no role holds it`);
    for (const r of holders) {
      const t = text[r.name];
      assert.ok(r.skills.includes(s) ? t.includes(block(s)) : new RegExp(`^- ${s}: `, 'm').test(t), `${r.name}: ${s} is not in its prompt`);
    }
  }
});

test('(e) the head prompt\'s CORE skills: embedded whole when the head prompt is on (Claude Code and opencode index mode)', () => {
  const claude = HP.claudeHeadText(ROOT);
  const opencode = JSON.parse(require('../../scripts/lib/harness-sync').expectedFiles(ROOT)['workspace/opencode.json']).agent['fth-head-trader'].prompt;
  for (const s of of('e')) for (const [name, p] of [['claude', claude], ['opencode', opencode]]) assert.ok(p.includes(block(s)), `${name}: ${s}`);
});

test('(d) workflow skills: each with its reason, in no trade cycle\'s prompt', () => {
  const prompts_ = Object.values(FIXTURES).flatMap(fx => [situation(fx.present), situation(fx.absent)]).map(x => {
    const text = SS.situationText(ROOT, SS.choose(ROOT, SS.factsOf(x), { loaded: LOADED }));
    return prompts(cfgOf('claude'), NOW, ROOT).trade(ITEMS, { state: x.state, cycleSkills: text });
  });
  for (const s of of('d')) {
    assert.ok(typeof C.WORKFLOW[s] === 'string' && C.WORKFLOW[s].length, s);
    for (const p of prompts_) assert.ok(!p.includes(`<skill name="${s}">`), `${s} is embedded in a trade cycle`);
  }
});

test('the budget: with every trigger that can hold at once, nothing is pushed to the Also relevant line', () => {
  // A window refusing entries lists no setup (setupChecks, the setup moment): its trigger never holds beside the setup
  // stages, so it is judged on its own below.
  const flatFacts = Object.entries(FIXTURES).filter(([id]) => id !== 'window').map(([, fx]) => situation(fx.present)).filter(x => x.state === FLAT || (x.state && !x.state.positions.length));
  const everything = { state: { ...FLAT, attempts: [{ account: 'x', status: 'active' }] }, briefings: flatFacts.flatMap(x => x.briefings || []) };
  const all = SS.choose(ROOT, SS.factsOf(everything), { loaded: LOADED });
  assert.deepStrictEqual(all.over, [], `over the budget: ${all.over.join(', ')}`);
  const managed = SS.choose(ROOT, SS.factsOf({ state: { ...OPEN, entryLines: ['entry'] }, briefings: everything.briefings }), { loaded: LOADED });
  assert.deepStrictEqual(managed.over, [], `managed, over the budget: ${managed.over.join(', ')}`);
  const refused = SS.choose(ROOT, SS.factsOf({ state: FLAT, briefings: [...everything.briefings, situation(FIXTURES.window.present).briefings[0]].map(x => ({ ...x, sections: { ...x.sections, m3: { ...x.sections.m3, data: { ...x.sections.m3.data, windowEntries: 'refused' } } } })) }), { loaded: LOADED });
  assert.ok(refused.skills.includes('session-timing') && !refused.over.length, `a refused window: ${refused.over.join(', ')}`);
});

test('a fill reported late (positions read flat, a fill shows a long 9, its bracket stop working) delivers leftover-orders with its [cancel-protection] line', () => {
  // The account as the runner's snapshot shows it in that state: no position listed, the bracket stop working.
  const late = { state: { ...FLAT, workingOrders: 1 } };
  const facts = SS.factsOf(situation(late));
  assert.ok(ids(facts).includes('leftover'), ids(facts).join());
  const chosen = SS.choose(ROOT, facts, { loaded: LOADED });
  const prompt = prompts(cfgOf('claude'), NOW, ROOT).trade(ITEMS, { state: late.state, cycleSkills: SS.situationText(ROOT, chosen) });
  assert.ok(prompt.includes(block('leftover-orders')), 'leftover-orders\' whole body is in the cycle prompt');
  const line = /A stop is never a leftover while fills or an order's status show the\s+position, even if positions read flat: `\[cancel-protection\]` refuses it; keep it\./;
  assert.match(fs.readFileSync(path.join(ROOT, 'skills', 'leftover-orders', 'SKILL.md'), 'utf8'), line);
  assert.match(prompt, line, 'the new line reaches the prompt');
});

'use strict';

// A cycle's situational skills (scripts/lib/situational-skills.js): the skills each fact of the account and the bar
// briefing needs, by decision stage, embedded whole in the cycle's prompt within a byte budget, attested by the run's
// environment; a cycle in no situation as before, byte for byte.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SS = require('../../scripts/lib/situational-skills');
const HP = require('../../scripts/lib/head-prompt');
const SM = require('../../scripts/lib/learning/setup-moments');
const { validateConfig, prompts, childEnv, cycleLoaded } = require('../../scripts/lib/autotrader');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const NOW = new Date('2026-04-23T14:03:00.000Z');
const ITEMS = [{ symbol: 'MNQ', bar: { t: '2026-04-23T14:00:00.000Z', c: 21500, file: '/tmp/bars.json', contractId: 'MNQ' } }];
const FLAT = { id: 7, at: NOW.toISOString(), balance: 50000, positions: [], workingOrders: 0 };
const OPEN = { ...FLAT, positions: [{ contractId: 'MNQ', type: 1, size: 1, averagePrice: 21500 }], workingOrders: 2, openTrades: ['Open trade MNQ long 1 @ 21500.'] };
const LONG_RULE = 'Trend rule: LONG allowed (prevailing 4h up); short only as a reversal';
const brief = m3 => ({ symbol: 'MNQ', minutes: 3, sections: { m3: { data: { windowEntries: 'allowed', trendRule: LONG_RULE, ...m3 } } } });
const expanding = (dir, levels = []) => ({ '15m': { state: 'expanding', box: { low: 21480, high: 21490, levels }, break: { dir, expansion: true } } });
const ids = facts => facts.map(f => f.id);
const LOADED = cycleLoaded(validateConfig({ harness: 'claude' }));

test('the table: every entry a known stage, its skills real skills, its facts fields a built briefing produces', () => {
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const B = require('../../scripts/lib/trading/briefing');
  const bars = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
  const m3 = B.buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: bars.slice(0, 400), minutes: 3 }).sections.m3.data;
  for (const e of SS.TABLE) {
    assert.ok(SS.STAGES.includes(e.stage), e.id);
    for (const s of e.skills || []) assert.ok(fs.existsSync(path.join(ROOT, 'skills', s, 'SKILL.md')), `${e.id}: ${s}`);
    for (const f of e.facts) assert.ok(f === 'account' || f in m3, `${e.id}: ${f} is no briefing field`);
  }
  assert.deepStrictEqual(SS.STAGES, ['management', 'setup', 'entry', 'risk', 'location', 'bias']);
  // The section is read from the skill itself: the "Declared yet?" part of trend-vs-range, whole, nothing after it.
  const text = SS.sectionOf(ROOT, SS.SECTIONS.declared);
  assert.ok(text.startsWith('**Declared yet?**') && HP.skillBody(ROOT, 'trend-vs-range').includes(text) && !text.includes('## Examples'), text);
});

test('each situation\'s facts: an open position is management only; a listed setup brings its setup, entry, risk and location stages; a refused window, bias only', () => {
  assert.deepStrictEqual(ids(SS.factsOf({ state: OPEN })), ['open']);
  assert.deepStrictEqual(ids(SS.factsOf({ state: OPEN, briefings: [brief({ compression: expanding('up') })] })), ['open', 'day'], 'no flat stage while a trade is open');
  assert.deepStrictEqual(ids(SS.factsOf({ state: FLAT, briefings: [brief({ compression: expanding('up') })] })), ['compression', 'entry', 'risk', 'trend', 'day']);
  assert.deepStrictEqual(ids(SS.factsOf({ state: FLAT, briefings: [brief({ compression: expanding('up', [{ name: 'overnight low', edge: 'top' }]) })] })), ['compression', 'entry', 'risk', 'level', 'trend', 'day'], 'at a key level: its location stage too');
  assert.deepStrictEqual(ids(SS.factsOf({ state: FLAT, briefings: [brief({ compression: expanding('down') })] })), ['trend', 'day'], 'a break against the trend rule lists nothing');
  assert.deepStrictEqual(ids(SS.factsOf({ state: FLAT, briefings: [brief({ cisd: { '15m': { dir: 'bullish', status: 'touched' } } })] })), ['cisd', 'entry', 'risk', 'trend', 'day']);
  assert.deepStrictEqual(ids(SS.factsOf({ state: FLAT, briefings: [brief({ cisd: { '15m': { dir: 'bullish', status: 'waiting' } } })] })), ['trend', 'day'], 'a CISD not yet live lists nothing');
  assert.deepStrictEqual(ids(SS.factsOf({ state: { ...FLAT, attempts: [{ account: 'x' }] }, briefings: [brief({ compression: expanding('up') })] })), ['compression', 'entry', 'risk', 'attempt', 'trend', 'day']);
  assert.deepStrictEqual(ids(SS.factsOf({ state: FLAT, briefings: [brief({ windowEntries: 'refused', compression: expanding('up') })] })), ['day', 'window']);
  assert.deepStrictEqual(ids(SS.factsOf({ state: FLAT, briefings: [brief({ fvgs: { '5m': [{ retest: 'closed inside' }] }, sweeps: [{ name: 'equal highs' }], vwap: { side: 'above' }, lastBreak: { last: { kind: 'BOS' } } })] })), ['fvg', 'sweep', 'vwap', 'trend', 'day', 'structure']);
  assert.deepStrictEqual(ids(SS.factsOf({ state: FLAT, briefings: [brief({ declared: { long: { vwapAtr: 1, ema20Atr: 1, overnight: 'inside', dayMoveAtr: 1, regime: 'with' }, short: { vwapAtr: -1, ema20Atr: -1, overnight: 'inside', dayMoveAtr: -1, regime: 'against' } } })] })), ['declared', 'trend', 'day']);
  // No briefing and flat: nothing. An entry working: its outcome; flat with working orders: the leftovers.
  assert.deepStrictEqual(SS.factsOf({ state: FLAT }), []);
  assert.deepStrictEqual(ids(SS.factsOf({ state: { ...FLAT, entryLines: ['entry MNQ buy 1 @ 21490'] } })), ['open', 'working']);
  assert.deepStrictEqual(ids(SS.factsOf({ state: { ...FLAT, workingOrders: 2 } })), ['leftover']);
});

test('choose: stage order under the budget, nothing the prompt already holds, the rest named (never dropped)', () => {
  const facts = SS.factsOf({ state: FLAT, briefings: [brief({ compression: expanding('up', [{ name: 'overnight low', edge: 'top' }]), vwap: { side: 'above' } })] });
  const all = SS.choose(ROOT, facts, { budget: 1e9, loaded: LOADED });
  assert.deepStrictEqual(all.skills, ['compression', 'candle-reading', 'momentum-and-volume', 'top-down-entry', 'invalidation', 'take-profit', 'position-sizing', 'levels-and-reactions', 'vwap-volume-profile', 'mtf-bias-filter', 'daily-bias']);
  assert.deepStrictEqual(all.stages, ['setup', 'entry', 'risk', 'location', 'bias']);
  for (const s of all.skills) assert.ok(!LOADED.includes(s), `${s} is in the prompt already`);
  assert.strictEqual(all.bytes, all.skills.reduce((n, s) => n + Buffer.byteLength(HP.block(s, HP.skillBody(ROOT, s))), 0));
  // The head prompt's CORE holds invalidation: with it, never embedded twice.
  assert.ok(!SS.choose(ROOT, facts, { budget: 1e9, loaded: [...LOADED, ...HP.CORE] }).skills.includes('invalidation'));
  // A budget for the setup and its entry only: the rest named, in order.
  const size = s => Buffer.byteLength(HP.block(s, HP.skillBody(ROOT, s)));
  const small = SS.choose(ROOT, facts, { budget: size('compression') + size('candle-reading') + size('momentum-and-volume'), loaded: LOADED });
  assert.deepStrictEqual(small.skills, ['compression', 'candle-reading', 'momentum-and-volume']);
  assert.deepStrictEqual(small.over, ['top-down-entry', 'invalidation', 'take-profit', 'position-sizing', 'levels-and-reactions', 'vwap-volume-profile', 'mtf-bias-filter', 'daily-bias']);
  const text = SS.situationText(ROOT, small);
  assert.ok(text.endsWith(' Also relevant now, read with your skill tool: `top-down-entry`, `invalidation`, `take-profit`, `position-sizing`, `levels-and-reactions`, `vwap-volume-profile`, `mtf-bias-filter`, and `daily-bias`.'), text.slice(-200));
  // Management first: an open trade's exit skills before any context.
  const open = SS.choose(ROOT, SS.factsOf({ state: OPEN, briefings: [brief({})] }), { budget: size('manage-position') + size('pullback-vs-reversal') + size('take-profit'), loaded: LOADED });
  assert.deepStrictEqual([open.skills, open.over, open.stages], [['manage-position', 'pullback-vs-reversal', 'take-profit'], ['daily-bias'], ['management']]);
  // The committed budget.
  assert.strictEqual(require('../../scripts/lib/tunables').runner().prompt.situationalSkillBytes, 24000);
});

test('the Setups-to-check line: a compression break on an allowed side (at its key level when its box sits at one) and a live CISD; nothing against the trend rule or outside the window', () => {
  const m3 = brief({ compression: expanding('up', [{ name: 'prior rth high', edge: 'inside' }, { name: 'overnight low', edge: 'top' }]), cisd: { '5m': { dir: 'bullish', status: 'bounced' }, '3m': { dir: 'bearish', status: 'touched' } } }).sections.m3.data;
  assert.deepStrictEqual(SM.setupChecks(m3), [
    { kind: 'compression', tf: '15m', dir: 'up', side: 'long', read: '15m compression break up', level: 'overnight low' },
    { kind: 'cisd', tf: '5m', dir: 'up', side: 'long', read: '5m cisd up' },
  ], 'the short CISD is against the trend rule; an inside level is no edge');
  assert.strictEqual(SM.checkLine({}, { barClose: 0, checks: SM.setupChecks(m3) }), '- Setups to check: "15m compression break up" (long, at overnight low); "5m cisd up" (long). Compose and check each (trade-lifecycle, compression, cisd); pass unless every read is true; SKIP each one you don\'t compose, with its reason.');
  assert.deepStrictEqual(SM.setupChecks({ ...m3, compression: expanding('up', [{ name: 'prior rth high', edge: 'inside' }]) }).map(c => c.level), [undefined, undefined], 'no level at an edge: none named');
  assert.deepStrictEqual(SM.setupChecks({ ...m3, windowEntries: 'refused' }), []);
  assert.deepStrictEqual(SM.setupChecks({ ...m3, trendRule: 'Trend rule: SHORT allowed (prevailing 4h down); long only as a reversal' }).map(c => c.read), ['3m cisd down']);
  assert.strictEqual(SM.checkLine({}, { barClose: 0, checks: [] }), null);
});

test('the cycle prompt: a cycle in no situation is byte-identical to the prompt without a section; a situation\'s section sits before the result line', () => {
  const cfg = validateConfig({ harness: 'claude', account: '7', sessions: ['09:30-12:00@America/New_York'] });
  const P = prompts(cfg, NOW, ROOT);
  const flat = P.trade(ITEMS, { state: FLAT });
  assert.strictEqual(P.trade(ITEMS, { state: FLAT, cycleSkills: '' }), flat, 'no section: as before, byte for byte');
  assert.doesNotMatch(flat, /<skill name=/);
  assert.match(flat, /also load htf-to-ltf, confluence-counting, setup-judgment, trade-plan, and day-context before deciding/, 'day-context on the every-cycle load list');
  const chosen = SS.choose(ROOT, SS.factsOf({ state: OPEN }), { loaded: LOADED });
  const text = SS.situationText(ROOT, chosen);
  const managed = P.trade(ITEMS, { state: OPEN, cycleSkills: text });
  assert.ok(managed.includes(text) && /CYCLE RESULT: <[^>]+> - <reason>\.$/.test(managed));
  assert.deepStrictEqual(HP.embeddedSkills(managed, ROOT), ['manage-position', 'pullback-vs-reversal', 'take-profit']);
  assert.strictEqual(managed.length, P.trade(ITEMS, { state: OPEN }).length + text.length);
});

test('childEnv: the run that has a section writes and attests it for its cycle; never a role run, a probe, an inherited value, or without one', () => {
  const cfg = validateConfig({ harness: 'claude' });
  const home = tmpDir();
  const base = { FTH_HOME: home, FTH_CYCLE_SKILLS: 'stale' };
  const chosen = SS.choose(ROOT, SS.factsOf({ state: OPEN }), { loaded: LOADED });
  assert.ok(!('FTH_CYCLE_SKILLS' in childEnv(cfg, ROOT, base, {})), 'none: an inherited one dropped');
  const env = childEnv(cfg, ROOT, base, { cycleSkills: chosen });
  const att = SS.parseAttestation(env.FTH_CYCLE_SKILLS);
  assert.ok(att, env.FTH_CYCLE_SKILLS);
  assert.deepStrictEqual(att.skills, chosen.skills);
  assert.strictEqual(att.cycle, require('../../scripts/lib/trading/check-order').cycleId(env));
  assert.strictEqual(fs.readFileSync(att.config, 'utf8'), SS.situationText(ROOT, chosen));
  for (const context of [{ cycleSkills: chosen, roleRun: 'trade-executor' }, { cycleSkills: chosen, probe: true }, { cycleSkills: 'yes' }]) {
    assert.ok(!('FTH_CYCLE_SKILLS' in childEnv(cfg, ROOT, base, context)), JSON.stringify(context).slice(0, 60));
  }
  assert.ok(SS.parseAttestation(childEnv(validateConfig({ harness: 'opencode' }), ROOT, base, { cycleSkills: chosen }).FTH_CYCLE_SKILLS));
  for (const harness of ['qwen', 'codex']) assert.ok(!('FTH_CYCLE_SKILLS' in childEnv(validateConfig({ harness }), ROOT, base, { cycleSkills: chosen })), harness);
  // A section only (no whole skill): written, but nothing to attest.
  assert.ok(!('FTH_CYCLE_SKILLS' in childEnv(cfg, ROOT, base, { cycleSkills: { skills: [], sections: ['declared'] } })));
});

test('the attestation: one cycle, the runner\'s file name, the table\'s skills only; malformed values parse to null', () => {
  const home = tmpDir();
  const chosen = { skills: ['compression'], sections: [], over: [], why: ['a compression break on the Setups to check'] };
  const { file, text } = SS.writeSituation(home, ROOT, chosen);
  assert.match(path.basename(file), /^cycle-skills-[0-9a-f]{64}\.md$/);
  assert.strictEqual(SS.writeSituation(home, ROOT, chosen).file, file);
  assert.strictEqual(SS.writeSituation(home, ROOT, { skills: [] }), null);
  const att = SS.attestation({ file, text, root: ROOT, cycle: '0123456789abcdef' });
  assert.deepStrictEqual(SS.parseAttestation(JSON.stringify(att)), att);
  assert.strictEqual(SS.attestation({ file, text, root: ROOT, cycle: 'nope' }), null);
  for (const bad of ['', '{', '[]', JSON.stringify({ ...att, kind: 'x' }), JSON.stringify({ ...att, skills: [] }), JSON.stringify({ ...att, cycle: 'x' }), JSON.stringify({ ...att, sha256: 'abc' })]) {
    assert.strictEqual(SS.parseAttestation(bad), null, bad);
  }
});

test('the prompt\'s section sizes: a managed, a setup and a context-only cycle, each within the budget', () => {
  const budget = require('../../scripts/lib/tunables').runner().prompt.situationalSkillBytes;
  const cases = {
    managed: SS.factsOf({ state: OPEN, briefings: [brief({})] }),
    setup: SS.factsOf({ state: FLAT, briefings: [brief({ compression: expanding('up', [{ name: 'overnight low', edge: 'top' }]), vwap: { side: 'above' } })] }),
    context: SS.factsOf({ state: FLAT, briefings: [brief({ vwap: { side: 'above' } })] }),
  };
  for (const [name, facts] of Object.entries(cases)) {
    const chosen = SS.choose(ROOT, facts, { loaded: LOADED });
    assert.ok(chosen.bytes > 0 && chosen.bytes <= budget, `${name}: ${chosen.bytes}`);
    assert.ok(Buffer.byteLength(SS.situationText(ROOT, chosen)) < budget + 1000, name);
  }
});

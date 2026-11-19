'use strict';

// P1 (coordinator 2026-11-18, item 3): in an mtf_only arm (A, B, AB) the only entry offers are the MTF candidate lines.
// Today's setups print as context: the "Setups to check" line keeps its facts with a context clause in place of its
// compose instruction, the Standard plan line is gone, the fired rules setups are names only; prepare-ahead's "Possible at
// the next close" prepares none of them; the cycle prompt's fired line says context only. Arm D (today) is unchanged:
// the same bars print the same offers as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const GF = require('../../scripts/lib/eval/goal-fixture');
const B = require('../../scripts/lib/trading/briefing');
const ME = require('../../scripts/lib/trading/mtf-entry');
const NC = require('../../scripts/lib/trading/next-close');

const REPO = path.join(__dirname, '..', '..');
const DOC = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'goal', 'bars.json.gz'))));
const etHm = ms => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const REPLAY = { isReplay: () => true };
const mode = arm => ME.modeOf({ arm, exitMode: 'trail', minStage: 'potential' }, {}, REPLAY);

// 2021-05-25 09:45 ET: today's briefing offers a setup to check and its Standard plan (a real fixture bar).
const DAY = '2021-05-25';
const BARS = GF.decodeBars(DOC.blocks.find(x => x.sessions.includes(DAY)).bars);
const J = BARS.findIndex(x => x.t.startsWith(DAY) && etHm(Date.parse(x.t) + 180000) === '09:45');
const T = Date.parse(BARS[J].t);
const W = BARS.filter((x, k) => k <= J && Date.parse(x.t) >= T - DOC.historyHours * 3600000);
const NOW = new Date(T + 180000);
const FINE = W.slice(-700).flatMap(b => [0, 1, 2].map(i => ({ t: new Date(Date.parse(b.t) + i * 60000).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: Math.round(b.v / 3) })));
const SCAN = [{ name: 'orb', status: 'active', candidate: true, direction: 'long', signal: 'rules', stopDistance: 5, confluence: { with: [], against: [] } }];
const build = m => B.buildBriefing({ symbol: 'NQ', bars: W, minutes: 3, now: NOW, scan: SCAN, ...(m ? { mtfMode: m, fineBars: FINE } : {}) });
const OFFER = /Standard plan|Compose and check each|a composed setup is yours|aims for|cite it in compose_check/;

test('arm D (today): the bar offers its setups as before (the Setups to check instruction, the Standard plan, the fired setup\'s stop and target)', () => {
  const text = B.renderBriefing(build(null), { now: NOW });
  assert.ok(J > 0);
  assert.match(text, /- Setups to check[^\n]*Compose and check each/);
  assert.match(text, /- Standard plan \(code, as compose_check plans it\)/);
  assert.match(text, / {2}- orb long: [^\n]*aims for/);
});

for (const arm of ['A', 'B', 'AB']) {
  test(`arm ${arm} (mtf_only): no non-MTF entry offer in the briefing; today's setups print as context; the MTF candidate lines stay`, () => {
    const b = build(mode(arm));
    const text = B.renderBriefing(b, { now: NOW });
    // The summary (the offers' home); the detail below it is the sections' data, read as facts.
    const lines = text.split('\nDetail by timeframe:')[0].split('\n');
    assert.ok(!lines.some(l => OFFER.test(l)), lines.filter(l => OFFER.test(l)).join('\n'));
    const check = lines.find(l => l.startsWith('- Setups to check'));
    assert.ok(check && check.endsWith(`Context only: MTF entry arm ${arm} enters only on an MTF candidate line.`), check);
    assert.ok(lines.includes(`- Rules setups: fired orb long. Context only: MTF entry arm ${arm} enters only on an MTF candidate line.`));
    assert.ok(lines.some(l => /^- MTF (candidate|waiting)/.test(l)), 'the MTF lines are the offers');
    // Prepare-ahead: none of today's setups prepared.
    const pre = NC.possibleAtNextClose({ symbol: 'NQ', bars: W, minutes: 3, briefing: b, flat: true });
    assert.deepEqual([pre.candidates, pre.none], [[], `MTF entry arm ${arm}: only an MTF candidate line is an entry, read at the close; today's setups are not prepared`]);
  });
}

test('the cycle prompt\'s fired line: an mtf_only arm names the fired setups as context only; arm D as before', () => {
  const { prompts, validateConfig } = require('../../scripts/lib/autotrader');
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', symbols: ['MNQ'], timeframe: 3, account: 1 });
  const bar = { t: '2026-10-08T14:30:00.000Z', c: 21505.25, file: '/b.json', contractId: 'MNQ' };
  const orb = { name: 'orb', status: 'active', candidate: true, direction: 'long', signal: 'rules', confluence: { with: [], against: [] } };
  const at = new Date('2026-10-08T14:33:20Z');
  const a = prompts({ ...cfg, mtfMode: mode('B') }, at, '/r').trade([{ symbol: 'MNQ', bar, scan: [orb] }]);
  assert.match(a, / MNQ: MTF entry arm B: the only entries are the briefing's MTF candidate lines; rules setups fired \(orb long\): context only\./);
  assert.doesNotMatch(a, /MNQ fired on this bar|a setup you compose and check is still open/);
  assert.match(prompts({ ...cfg, mtfMode: mode('A') }, at, '/r').trade([{ symbol: 'MNQ', bar, scan: [] }]), / MNQ: MTF entry arm A: the only entries are the briefing's MTF candidate lines\./);
  const d = prompts({ ...cfg, mtfMode: ME.modeOf({ arm: 'D', exitMode: 'trail', minStage: 'established' }, {}, REPLAY) }, at, '/r').trade([{ symbol: 'MNQ', bar, scan: [orb] }]);
  assert.equal(d, prompts(cfg, at, '/r').trade([{ symbol: 'MNQ', bar, scan: [orb] }]), 'arm D: the prompt as without a mode');
  assert.match(d, /MNQ fired on this bar/);
});

test('a whole MTF read unavailable in arm A still names the arm: the setups stay context only, the MTF line says unavailable', () => {
  const b = build(mode('A'));
  b.sections.m3.data.mtfStructure = { unavailable: 'the MTF read failed: test', mode: ME.recordMode(mode('A')) };
  const lines = B.renderBriefing(b, { now: NOW }).split('\nDetail by timeframe:')[0].split('\n');
  assert.ok(lines.includes('- MTF structure: unavailable (the MTF read failed: test).'), lines.filter(l => /MTF/.test(l)).join('\n'));
  assert.ok(!lines.some(l => OFFER.test(l)), lines.filter(l => OFFER.test(l)).join('\n'));
  assert.equal(NC.possibleAtNextClose({ symbol: 'NQ', bars: W, minutes: 3, briefing: b, flat: true }).candidates.length, 0);
});

test('through the real briefing: an MTF read that throws in arm A (here a mode the module refuses) is unavailable AND keeps the arm, so today\'s setups stay context only', () => {
  const bad = { ...mode('A'), minStage: 'nonsense' };
  const b = build(bad);
  const rec = b.sections.m3.data.mtfStructure;
  assert.match(rec.unavailable, /the MTF read failed: .*minStage/);
  assert.equal(rec.mode && rec.mode.arm, 'A');
  const lines = B.renderBriefing(b, { now: NOW }).split('\nDetail by timeframe:')[0].split('\n');
  assert.ok(!lines.some(l => OFFER.test(l)), lines.filter(l => OFFER.test(l)).join('\n'));
});

test('the reading lesson (the six mornings: 7 of 13 SELECTION lines): an MTF arm\'s trade prompt asks for the SELECTION line right before the result line, after the PLAN; arm D\'s prompt is unchanged, its PLAN text as before', () => {
  const { prompts, RESULT_LINE } = require('../../scripts/lib/autotrader');
  const cfg = require('../../scripts/lib/autotrader').validateConfig({ harness: 'claude', symbols: ['MNQ'], timeframe: 3 });
  const at = new Date('2026-10-07T14:00:02Z');
  const bar = { t: '2026-10-07T13:57:00.000Z', c: 21540 };
  for (const arm of ['A', 'B', 'AB']) {
    const p = prompts({ ...cfg, mtfMode: mode(arm) }, at, '/r').trade([{ symbol: 'MNQ', bar, scan: [] }]);
    assert.ok(p.endsWith(RESULT_LINE), arm);
    assert.match(p, /Write the trader-process skill's PLAN \(1 HTF to 9 Manage\), then, with an MTF candidate line printed, your SELECTION line on its own line \(`SELECTION: ENTER\|WAIT\|PASS - <reason>`, the mtf-entry skill: the one that counts\), then the result line\./, arm);
  }
  const d = prompts(cfg, at, '/r').trade([{ symbol: 'MNQ', bar, scan: [] }]);
  assert.match(d, / Write the trader-process skill's PLAN \(1 HTF to 9 Manage\) before the result line\./);
  assert.doesNotMatch(d, /SELECTION/, 'arm D: no SELECTION instruction');
  const dm = prompts({ ...cfg, mtfMode: ME.modeOf({ arm: 'D', exitMode: 'trail', minStage: 'established' }, {}, REPLAY) }, at, '/r').trade([{ symbol: 'MNQ', bar, scan: [] }]);
  assert.equal(dm, d, 'arm D: the prompt as without a mode');
});

test('the reading audit (E1): in an MTF arm the Trend rule line drops its refusal clause (no X against it) and the Bias line names no refused side; arm D\'s lines as before', () => {
  const lineOf = (text, re) => text.split('\n').find(l => re.test(l)) || '';
  const d = B.renderBriefing(build(null), { now: NOW });
  const dRule = lineOf(d, /^- Trend rule: /);
  assert.match(dRule, /; no (long|short) against it\.$/, dRule);
  assert.match(lineOf(d, /^- Bias: /), /; (long|short) refused\)\.$/, 'arm D: the Bias line names the refused side');
  assert.match(lineOf(d, /^- Alignment/), /^- Alignment: /, 'arm D: the Alignment line as before');
  for (const arm of ['A', 'B', 'AB']) {
    const t = B.renderBriefing(build(mode(arm)), { now: NOW });
    const rule = lineOf(t, /^- Trend rule: /);
    assert.equal(rule, dRule.replace(/; no (long|short) against it\.$/, '.'), arm);
    assert.doesNotMatch(lineOf(t, /^- Bias/), /refused| only /, arm);
    assert.match(lineOf(t, /^- Bias/), /^- Bias \(context here\): /, arm);
    assert.match(lineOf(t, /^- Alignment/), /^- Alignment \(context here\): /, arm);
    // The 3m detail's trendRule field too: no refusal clause anywhere in an MTF arm's briefing.
    assert.equal(lineOf(t, /^ {2}trendRule: /), lineOf(d, /^ {2}trendRule: /).replace(/; no (long|short) against it\.$/, '.'), arm);
    assert.doesNotMatch(t, /no (long|short) against it/, arm);
  }
  assert.match(lineOf(d, /^ {2}trendRule: /), /; no (long|short) against it\.$/, 'arm D: the detail keeps it');
  assert.equal(require('../../scripts/lib/trading/mtf-entry').mtfBiasText('Bias: long only (4h up, 1h up; short refused)'), 'Bias (context here): long (4h up, 1h up)');
  // Both sides, both helpers (a mutant that handles one side only survived without these).
  const MEx = require('../../scripts/lib/trading/mtf-entry');
  assert.equal(MEx.mtfBiasText('Bias: short only (4h down, 1h down; long refused)'), 'Bias (context here): short (4h down, 1h down)');
  assert.equal(MEx.mtfTrendRuleText('Trend rule: SHORT allowed (prevailing 4h down); no long against it.'), 'Trend rule: SHORT allowed (prevailing 4h down).');
  assert.equal(MEx.mtfTrendRuleText('Trend rule: LONG allowed (prevailing 4h up); no short against it'), 'Trend rule: LONG allowed (prevailing 4h up)');
  assert.equal(MEx.mtfBiasText('Bias: no side yet (15m down, declared short: no)'), 'Bias (context here): no side yet (15m down, declared short: no)', 'nothing to drop: labelled context');
  // The cycle prompt's bar line (the record for the gate) carries the same fence in an MTF arm, none in arm D.
  const { prompts, validateConfig } = require('../../scripts/lib/autotrader');
  const cfg = validateConfig({ harness: 'claude', symbols: ['MNQ'], timeframe: 3 });
  const bar = { t: '2026-10-07T13:57:00.000Z', c: 21540, trend: 'Trend rule: LONG allowed (prevailing 4h up); no short against it.' };
  const at = new Date('2026-10-07T14:00:02Z');
  assert.match(prompts(cfg, at, '/r').trade([{ symbol: 'MNQ', bar, scan: [] }]), /MNQ Trend rule: LONG allowed \(prevailing 4h up\); no short against it \(recorded for the order gate, which enforces it\)\./);
  assert.match(prompts({ ...cfg, mtfMode: mode('B') }, at, '/r').trade([{ symbol: 'MNQ', bar, scan: [] }]), /MNQ Trend rule: LONG allowed \(prevailing 4h up\) \(recorded for the order gate, which enforces it\)\./);
});

test('the conflict audit (A1, with E2-E4): an MTF arm\'s prompt ends with the precedence paragraph, right before the result line and after this cycle\'s reads; arm D has none, its reads before its result line as before', () => {
  const { prompts, RESULT_LINE, MTF_PRECEDENCE, withCycleData } = require('../../scripts/lib/autotrader');
  const cfg = require('../../scripts/lib/autotrader').validateConfig({ harness: 'claude', symbols: ['MNQ'], timeframe: 3 });
  const at = new Date('2026-10-07T14:00:02Z');
  const bar = { t: '2026-10-07T13:57:00.000Z', c: 21540 };
  assert.equal(MTF_PRECEDENCE, ' An MTF candidate printed: `mtf-entry` decides it. Its side, class and pullback rules override every other skill\'s. The window, account, size and management rules still apply. Side: the 1h structure\'s. These are arm D\'s rules, facts here and never refusals: the 4h; the Trend rule, Bias and Alignment lines; the Market state class and the class table; the take rule (your 4h and 1h too); never counter the 4h; the Pullback setup (wait for the 15m turn); today\'s 3m pullback trigger. The candidate\'s own line gives its stage, trigger, age, drift and stop. No entry when it is against the 1h structure, when it is void, or when the gate refuses it. Else select ENTER, WAIT (a 3m trigger only) or PASS, with your reason, on the SELECTION line.');
  const READS = '\n=== end of this cycle\'s reads ===\n';
  for (const arm of ['A', 'B', 'AB']) {
    const p = prompts({ ...cfg, mtfMode: mode(arm) }, at, '/r').trade([{ symbol: 'MNQ', bar, scan: [] }]);
    assert.ok(p.endsWith(`${MTF_PRECEDENCE}${RESULT_LINE}`), arm);
    assert.equal(p.split(MTF_PRECEDENCE).length, 2, `${arm}: once`);
    const w = withCycleData(p, READS);
    assert.ok(w.endsWith(`${READS}${MTF_PRECEDENCE}${RESULT_LINE}`), `${arm}: after the reads`);
  }
  const d = prompts(cfg, at, '/r').trade([{ symbol: 'MNQ', bar, scan: [] }]);
  assert.ok(!d.includes(MTF_PRECEDENCE) && !d.includes('decides it.'), 'arm D: no paragraph');
  assert.ok(withCycleData(d, READS).endsWith(`${READS}${RESULT_LINE}`), 'arm D: the reads, then the result line');
});

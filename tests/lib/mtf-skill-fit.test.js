'use strict';

// Context is never cut silently (the owner's rule; the conflict audit's trim, 2026-11-19): in an MTF arm's cycle prompt,
// on every session bar of the real MTF fixtures (tests/fixtures/mtf-structure, their last 50 bars) that prints a chosen candidate, the situational
// skills fit the hard prompt limit (prompt.maxPromptBytes, with the cycle data's reserve) without pushing bos-vs-choch
// (the MTF lines' reading skill) or mtf-entry to the "Also relevant" line. Text that grows the MTF prompt past it fails
// here instead of dropping a skill. (An offline check over 139 rendered real moments, outside the repo: none dropped.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..', '..');
const AT = require('../../scripts/lib/autotrader');
const B = require('../../scripts/lib/trading/briefing');
const ME = require('../../scripts/lib/trading/mtf-entry');
const SS = require('../../scripts/lib/situational-skills');
const GF = require('../../scripts/lib/eval/goal-fixture');
const P = require('../../scripts/lib/tunables').runner().prompt;
const RW = require('../../scripts/lib/runner-wiring');
const SC = require('../../scripts/lib/trading/session-context');

const cfg = AT.validateConfig({ harness: 'claude', symbols: ['MNQ'], account: '1', timeframe: 3, lanes: [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'data' }], roleSkillsInPrompt: true, cycleDataInPrompt: true, deskBriefReports: true, headSkillsInPrompt: true, sessions: ['09:30-12:00@America/New_York'] });
const mode = ME.modeOf({ arm: 'A', exitMode: 'trail', minStage: 'potential' }, {}, { isReplay: () => true });
const FLAT = { id: '1', balance: 100000, positions: [], orders: [], workingOrders: 0, attempts: [] };
const W = AT.historyBars(3);
// The worst of the 139 rendered real MTF-arm moments (the reading audit's re-ask set, rendered offline with the real
// runner calls) leaves 3,612 bytes less room than these fixtures' worst bar (at the lessons tip: 320 real, 3,932 here).
// A fixture margin under this means a real cycle would push a skill out: the test fails instead of cutting context.
const REAL_GAP = 3612;

test('an MTF arm\'s cycle prompt keeps bos-vs-choch and mtf-entry in the prompt on every real fixture bar with a chosen candidate (the hard limit, the cycle data reserved)', () => {
  const dir = path.join(ROOT, 'tests', 'fixtures', 'mtf-structure');
  let cycles = 0; let margin = Infinity; const dropped = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json.gz'))) {
    const bars = GF.decodeBars(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, f)))).bars);
    // The fixture day's last 50 bars (its session; the rest is history).
    for (let j = bars.length - 50; j < bars.length; j += 1) {
      const now = new Date(Date.parse(bars[j].t) + 180000);
      const b = B.buildBriefing({ symbol: 'MNQ', bars: bars.slice(Math.max(0, j + 1 - W), j + 1), minutes: 3, now, mtfMode: mode });
      const text = B.renderBriefing(b, { now });
      if (!/^- MTF candidate (LONG|SHORT) \(chosen\)/m.test(text)) continue;
      cycles += 1;
      // The cycle prompt as the runner builds it: the day line, the premarket plan, the news line.
      const w = bars.slice(Math.max(0, j + 1 - W), j + 1);
      let day = null; try { day = RW.dayLine({ symbol: 'MNQ', tickSize: 0.25 }, w); } catch (_e) { day = null; }
      const items = [{ symbol: 'MNQ', verdicts: [], scan: [], notEntries: [], entryBlocked: null, cited: [], bar: { t: bars[j].t, c: bars[j].c, contractId: 'MNQ', trend: (b.sections.m3.data || {}).trendRule, day, recent: bars.slice(j - 9, j + 1), plan: SC.premarketPlan([], 'MNQ', now) } }];
      const opts = { state: { ...FLAT, at: now.toISOString() }, entry: true, journalRead: true, news: SC.newsLine({ items: [] }, now), history: [], lessons: [], trades: [], unavailable: [] };
      const base = Buffer.byteLength(AT.prompts({ ...cfg, mtfMode: mode }, now, ROOT).trade(items, opts));
      const chosen = SS.fit(ROOT, SS.factsOf({ state: opts.state, briefings: [b] }), { loaded: AT.cycleLoaded(cfg), base, max: P.maxPromptBytes, reserve: P.cycleDataMaxBytes });
      for (const s of ['bos-vs-choch', 'mtf-entry']) if (chosen.over.includes(s)) dropped.push(`${f} ${bars[j].t}: ${s}`);
      margin = Math.min(margin, P.maxPromptBytes - P.cycleDataMaxBytes - base - Buffer.byteLength(SS.situationText(ROOT, chosen)));
    }
  }
  assert.ok(cycles >= 5, `too few candidate bars in the fixtures (${cycles})`);
  assert.deepEqual(dropped, []);
  assert.ok(margin >= REAL_GAP, `the fixtures' margin ${margin} bytes is under ${REAL_GAP}: a real MTF cycle would drop a skill (trim the MTF text; never raise maxPromptBytes)`);
});

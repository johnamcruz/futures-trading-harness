'use strict';

// Setup-focused practice in the runner's config and wiring (autotrader.js validateConfig, runner-wiring.js
// practiceSelector): only a replay of a practice learning run gets a selector, and it reads the bar's own briefing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../fixtures/golden-bars');
const { tmpDir } = require('../helpers');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { practiceSelector } = require('../../scripts/lib/runner-wiring');
const { buildBriefing, writeBriefing } = require('../../scripts/lib/trading/briefing');

const BASE = { harness: 'opencode', symbols: ['MNQ'], timeframe: 3, premarketAt: '', account: '7' };
const learningRun = (home, run) => fs.writeFileSync(path.join(home, 'learning-run.json'), JSON.stringify(run));

test('validateConfig: practice is checked and filled; it needs an account; absent leaves the config as before', () => {
  assert.ok(!('practice' in validateConfig(BASE)));
  assert.deepStrictEqual(validateConfig({ ...BASE, practice: { seed: 2 } }).practice, { mode: 'setup-focus', setupTf: 15, quietSample: 0.15, seed: 2, levels: 'key', reactions: ['rejected', 'broke'] });
  assert.throws(() => validateConfig({ ...BASE, practice: { setupTf: 2 } }), /practice.setupTf/);
  assert.throws(() => validateConfig({ ...BASE, account: undefined, practice: {} }), /practice: needs an account/);
});

test('practiceSelector: none without practice; refused live, without a learning run, and on test, final or a run not learning', () => {
  const home = tmpDir();
  const cfg = validateConfig({ ...BASE, practice: {} });
  assert.strictEqual(practiceSelector(validateConfig(BASE), home, {}), null);
  assert.throws(() => practiceSelector(cfg, home, {}), /only in a replay: live runs every bar/);
  const env = { FTH_REPLAY_NOW: '2022-03-02T15:00:00Z' };
  assert.throws(() => practiceSelector(cfg, home, env), /no learning-run.json/);
  for (const [run, why] of [[{ learning: true, role: 'test' }, /this run: test/], [{ learning: true, role: 'final' }, /this run: final/], [{ learning: false, role: null }, /not a learning run/]]) {
    learningRun(home, run);
    assert.throws(() => practiceSelector(cfg, home, env), why);
  }
  for (const role of ['practice-train', 'practice-validate']) {
    learningRun(home, { learning: true, role });
    assert.strictEqual(typeof practiceSelector(cfg, home, env), 'function');
  }
});

test('practiceSelector: reads the bar\'s own briefing; an older or missing briefing is unavailable, and the bar runs', () => {
  const home = tmpDir();
  learningRun(home, { learning: true, role: 'practice-train' });
  const cfg = validateConfig({ ...BASE, practice: { quietSample: 0 } });
  const select = practiceSelector(cfg, home, { FTH_REPLAY_NOW: 'x' });
  const bars = G.load(G.SERIES[0]).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
  const item = i => ({ symbol: 'MNQ', bar: { t: bars[i].t }, minutes: 3 });
  assert.strictEqual(select(item(900), false).why, 'unavailable', 'no briefing yet');
  const brief = i => writeBriefing(home, buildBriefing({ symbol: 'MNQ', bars: bars.slice(i - 500, i + 1), minutes: 3, now: new Date(Date.parse(bars[i].t) + 180000) }));
  brief(900);
  const s = select(item(900), false);
  assert.ok(['moment', 'none'].includes(s.why), s.reason);
  assert.strictEqual(select(item(900), true).why, 'manage');
  assert.strictEqual(select(item(905), false).why, 'unavailable', 'a briefing of an older bar is never read as this bar\'s');
});

'use strict';

// The timeframe audit (feat/bias-bg; the owner: "get it all correct so there is timeframe alignment for the fractal"):
// every place the harness names a bias, levels, setup or entry timeframe either reads the chain (chain.js) or is
// pinned here to agree with it. The shipped chain 4h/15m/3m: bias 4h + 1h (BG), levels 1h (and the daily/session HTF
// levels), setup 15m, entry 3m. A reference that disagrees fails this test; one left as it is says why below.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../../scripts/lib/trading/chain');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CHAIN = C.chainOf(C.SHIPPED);
const idx = tf => C.LADDER.indexOf(tf);
const flat = t => t.replace(/\s+/g, ' ');
const MIN = { 1: '1m', 3: '3m', 5: '5m', 15: '15m', 60: '1h', 240: '4h' };

test('code: each frame a module names is the chain\'s, or derived from it', () => {
  // The entry rule's bias frames, the trail target's and the timing line's (entry-rule.js BIAS_FRAMES): the chain's bias.
  assert.deepStrictEqual([...require('../../scripts/lib/trading/entry-rule').BIAS_FRAMES], [...CHAIN.bias]);
  // The briefing's setup listings (setup-moments.js): a CISD from the setup frame to the levels frame, a compression
  // break from the setup frame up; nothing under the setup frame.
  const SM = require('../../scripts/lib/learning/setup-moments');
  assert.deepStrictEqual([...SM.CISD_FRAMES], C.LADDER.slice(idx(CHAIN.setup), idx(CHAIN.levels) + 1));
  assert.ok(SM.COMPRESSION_FRAMES.every(tf => idx(tf) >= idx(CHAIN.setup)) && SM.COMPRESSION_FRAMES.includes(CHAIN.setup));
  // The multi-timeframe read builds the setup, levels and bias frames (mtf.js mtfRead's default frames, its rule frames).
  const mtf = require('../../scripts/lib/trading/mtf');
  const ruleFrames = mtf.RULE_FRAMES.map(m => MIN[m]);
  for (const tf of [...CHAIN.bias, CHAIN.levels, CHAIN.setup]) assert.ok(ruleFrames.includes(tf), `the trend rule reads the ${tf}`);
  // The runner's base lane (config/runner.json bars.timeframe) is the chain's entry frame.
  assert.strictEqual(MIN[require('../../scripts/lib/tunables').runner().bars.timeframe], CHAIN.entry);
  // The practice setup moments' default setup frame (config/replay.json setupMoments.setupTf) is the chain's setup.
  assert.strictEqual(MIN[require('../../scripts/lib/tunables').replay().setupMoments.setupTf], CHAIN.setup);
  // composed-reads: the setup minimum reads the policy's chain (its message names the chain's setup frame).
  assert.match(read('scripts/lib/trading/composed-reads.js'), /entryRule\.chain\.setup/);
  // ltf-timing times the briefing's base frame, which the entry rule holds to the chain's entry frame (the lane check).
  assert.match(read('scripts/lib/trading/entry-rule.js'), /base !== rule\.chain\.entry/);
});

test('documents: the strategy, the agents and the RULEBOOK agree with the chain (a mismatch reported, not silently edited)', () => {
  // momentum_continuation (S2): its candle frame is the chain's entry frame.
  const mc = parseFrontmatter(read('strategies/momentum_continuation/STRATEGY.md')).data;
  assert.strictEqual(mc.timeframe, CHAIN.entry);
  // Reported, left as it is (a strategy's rules are its source's): its side is the trend rule's prevailing frame, the
  // first of 4h, 1h, 15m with a trend, so the 15m can set it where the chain's bias frames (4h, 1h) both range; under a
  // policy the entry rule (BG) still decides the side.
  assert.match(flat(read('strategies/momentum_continuation/STRATEGY.md')), /the first of 4h, 1h, 15m with a/);
  // The desk analysts read the base lane's briefing (no `timeframe` key: the first lane's, the chain's entry frame),
  // which carries the 15m, 1h and 4h sections.
  for (const a of ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst']) {
    const fm = parseFrontmatter(read(`agents/${a}.md`)).data;
    assert.ok(fm.timeframe === undefined || fm.timeframe === CHAIN.entry || idx(fm.timeframe) >= idx(CHAIN.setup), `${a}: ${fm.timeframe}`);
  }
});

test('skills: the side rule, the setup frame and the entry frame are stated as the chain\'s', () => {
  const htf = flat(read('skills/htf-to-ltf/SKILL.md'));
  assert.ok(htf.includes(`each trending ${CHAIN.bias[0]} or ${CHAIN.bias[1]} your way, neither against`), 'htf-to-ltf: the bias frames');
  assert.ok(htf.includes(`The setup is the ${CHAIN.setup} (or higher)`), 'htf-to-ltf: the setup frame');
  assert.ok(htf.includes(`the ${CHAIN.entry} only times the entry`), 'htf-to-ltf: the entry frame');
  const tl = flat(read('skills/trade-lifecycle/SKILL.md'));
  assert.ok(tl.includes(`in an attempt the ${CHAIN.setup} or higher (the ${CHAIN.entry} only times the entry)`), 'trade-lifecycle: the setup row');
  // No skill tells the model a frame under the setup frame sets the side.
  for (const s of fs.readdirSync(path.join(ROOT, 'skills'))) {
    const f = path.join('skills', s, 'SKILL.md');
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    for (const tf of C.LADDER.slice(0, idx(CHAIN.setup))) assert.doesNotMatch(flat(read(f)), new RegExp(`the ${tf} sets the side`), `${f}: ${tf}`);
  }
});

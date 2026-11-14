'use strict';

// The pullback entry the pullback-vs-reversal skill teaches (feat/pullback-concept, owner-approved 2026-11-14), held
// against the trade-lifecycle reads checker (scripts/lib/trading/composed-reads.js) under the committed entry rule's
// top-down chain: the 15m turn is the setup read (a live 15m CISD the side's way, or a 15m reaction still on the last
// 15m candle), the 3m BOS is stated in the bias step and the 3m CISD in the setup step beside the 15m read, and a 3m read
// alone is no setup. So what the skill tells the model to compose is what compose_check accepts, and what it says is
// gone (a weak or dead CISD, a 3m read alone, a break read in the entry step) is what compose_check refuses.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const CR = require('../../scripts/lib/trading/composed-reads');
const { entryRuleOf } = require('../../scripts/lib/trading/entry-rule');
const { scenario1 } = require('../fixtures/trade-lifecycle-scenario');

const ROOT = path.resolve(__dirname, '..', '..');
// The committed policy's entry rule (accounts/*/RULEBOOK.md): the 4h chain, the 4h and 1h, neutral-15m-declared.
const RULE = entryRuleOf({ chain: '4h', bias_frames: ['4h', '1h'], bias_agree: 'neutral-15m-declared', regime_against: 'off', leg_turned: 'off' });

/** scenario 1's briefing inside an open 15m pullback: a live strong 15m CISD up, the 3m's last break a BOS up, a 3m CISD up. */
function pullbackBriefing() {
  const b = scenario1();
  const m3 = b.sections.m3.data;
  m3.cisd['15m'] = { dir: 'bullish', level: 21520, status: 'waiting', priceInOte: false, displacement: 'strong' };
  m3.cisd['3m'] = { dir: 'bullish', level: 21536, status: 'waiting', priceInOte: false, displacement: 'strong' };
  m3.lastBreak = { last: { kind: 'BOS', direction: 'up', level: 21538.5, barsAgo: 0 }, previous: { kind: 'CHoCH', direction: 'up', level: 21531.25, barsAgo: 2 } };
  return b;
}
const r = (step, skill, read) => ({ step, skill, read, why: 'x' });
const BASE = [r('bias', 'bos-vs-choch', '1h bos up'), r('location', 'vwap-volume-profile', 'at prior VAH'), r('stop', 'invalidation', 'stop 15m low 21512.75'), r('target', 'take-profit', 'target trail')];
const check = (reads, b = pullbackBriefing()) => CR.checkReads({ reads: [...BASE, ...reads], side: 'long', briefing: b, entryRule: RULE });
const setupProblem = x => x.problems.some(p => /setup/.test(p));

test('pullback entry: the 15m CISD up as the setup and the 3m BOS up in the bias step compose under the top-down rule', () => {
  const x = check([r('setup', 'cisd', '15m cisd up'), r('bias', 'bos-vs-choch', '3m bos up')]);
  assert.ok(!setupProblem(x), x.problems.join('; '));
  for (const read of ['15m cisd up', '3m bos up']) assert.strictEqual(x.reads.find(y => y.read === read).check, true, read);
});

test('pullback entry: a 3m CISD up stated beside the 15m read is a true setup read; a 3m read alone is no setup', () => {
  const both = check([r('setup', 'cisd', '15m cisd up'), r('setup', 'cisd', '3m cisd up')]);
  assert.ok(!setupProblem(both), both.problems.join('; '));
  assert.strictEqual(both.reads.find(y => y.read === '3m cisd up').check, true);
  const alone = check([r('setup', 'cisd', '3m cisd up'), r('bias', 'bos-vs-choch', '3m bos up')]);
  assert.ok(alone.problems.some(p => /15m or higher/.test(p)), alone.problems.join('; '));
});

test('pullback entry: the 3m BOS in the entry step is refused (a break read belongs to the bias step)', () => {
  const x = check([r('setup', 'cisd', '15m cisd up'), r('entry', 'bos-vs-choch', '3m bos up')]);
  assert.ok(x.problems.some(p => /3m bos up/.test(p)), x.problems.join('; '));
});

test('pullback entry: a weak, void or expired 15m CISD is no setup read; the 15m reaction read is true only on its own candle', () => {
  for (const status of ['weak', 'void', 'expired']) {
    const b = pullbackBriefing();
    b.sections.m3.data.cisd['15m'].status = status;
    const x = check([r('setup', 'cisd', '15m cisd up'), r('bias', 'bos-vs-choch', '3m bos up')], b);
    assert.strictEqual(x.ok, false, status);
    assert.strictEqual(x.reads.find(y => y.read === '15m cisd up').check, false, status);
  }
  // scenario 1's last 15m candle rejected the prior VAH up: true; the next 15m candle met no level: false.
  const b = pullbackBriefing();
  assert.strictEqual(check([r('setup', 'rejection', '15m rejected prior VAH up')], b).reads.find(y => y.read === '15m rejected prior VAH up').check, true);
  b.sections.m3.data.candles['15m'].relations = [];
  b.sections.m3.data.candles['15m'].levels = {};
  assert.strictEqual(check([r('setup', 'rejection', '15m rejected prior VAH up')], b).reads.find(y => y.read === '15m rejected prior VAH up').check, false);
});

test('pullback entry: the skill states these forms and steps', () => {
  const t = fs.readFileSync(path.join(ROOT, 'skills', 'pullback-vs-reversal', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(t.includes('the setup `15m cisd up` (or the reaction)'), 'the setup read named');
  assert.ok(t.includes('`3m bos up` in the bias step'), 'the BOS read and its step named');
  assert.ok(t.includes('`3m cisd up` in the setup step'), 'the 3m CISD read and its step named');
});

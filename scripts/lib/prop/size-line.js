'use strict';

/**
 * The prompt's Size and Min lines for a running prop attempt: what the sizing code will do, said as facts so the model
 * never works a size out. From the code that decides it: phase 2's pacing rules (phase2-cut.js rulesHolding, the
 * conditions a cut stands on) and the floor stretch's health (size-translate.js attemptHealth). Pure: no files.
 *
 *   sizeLines({ facts, riskUsd, minContracts, stretchUsd, capUsd })
 *       [size, min]: "Size (prop attempt): the full verdict size; ... none holds now (...)", or "Size (prop
 *       attempt): phase 2 may cut (pacing: after-loss, drawdown)"; "Min: 3 contracts at the stop. Fewer fit under the $300 cap →
 *       skip, unless the floor stretch applies (balance ≥ start, no loss today): then exactly 3, up to the stretch all in,
 *       never fewer" (the dollars the caller's). Each line names its own condition, as its code defines it: the Size
 *       line rulesHolding's (phase2-cut.js), the Min line attemptHealth's (size-translate.js). `facts`: phase2-cut.js
 *       cutFacts' shape; `riskUsd`: the risk a loss is measured at for the soft-stop rule (worstRisk). The plan's stop
 *       is not known per bar: the Min line states the rule.
 *   worstRisk({ capUsd, stretchUsd, budgetUsd })   the most one entry may risk: the floor stretch when it is above the
 *       composed cap (it can trade up to it), else the cap; the size budget when no cap is known. The gate's phase-2
 *       check measures the translated size at its stop, never above this, so a soft stop that holds there holds here.
 */

const { rulesHolding } = require('./phase2-cut');
const { attemptHealth } = require('./size-translate');

const usd = x => `$${Math.round(x)}`;
const num = x => typeof x === 'number' && Number.isFinite(x);

function sizeLines({ facts, riskUsd, minContracts, stretchUsd = null, capUsd = null }) {
  const held = rulesHolding(facts, riskUsd);
  const size = held.includes('unknown') ? 'Size (prop attempt): phase 2 may cut (the attempt\'s pacing facts can\'t all be read)'
    : held.length ? `Size (prop attempt): phase 2 may cut (pacing: ${held.join(', ')})`
      : 'Size (prop attempt): the full verdict size; a serious factor against never cuts it. Phase 2 cuts only on a pacing rule; none holds now (no loss today or streak; balance at or above start and peak; room to the soft and daily stops; not near the target)';
  if (!(Number.isInteger(minContracts) && minContracts >= 1)) return [size];
  const f = facts || {};
  const h = attemptHealth({ balance: f.balance, start: f.start, lossesToday: f.lossesToday });
  // One sentence, so it can't be read as leave to trade fewer (size-translate.js floorStretch, the gate's
  // [min-contracts]): fewer than the floor is a skip; the stretch only ever takes exactly the floor.
  const m = minContracts;
  const head = `Min: ${m} contracts at the stop`;
  // No closing period: the prompt (autotrader.js accountText) and the quiz's excerpt end each line with one.
  if (!(num(stretchUsd) && num(capUsd) && stretchUsd > capUsd)) return [size, `${head}; fewer → skip`];
  const under = `Fewer fit under the ${usd(capUsd)} cap → skip`;
  return [size, h.healthy
    ? `${head}. ${under}, unless the floor stretch applies (balance ≥ start, no loss today): then exactly ${m}, up to ${usd(stretchUsd)} all in, never fewer`
    : `${head}. ${under}; no floor stretch now (${h.why})`];
}

function worstRisk({ capUsd = null, stretchUsd = null, budgetUsd = null }) {
  if (num(capUsd) && capUsd > 0) return num(stretchUsd) && stretchUsd > capUsd ? stretchUsd : capUsd;
  return num(budgetUsd) && budgetUsd > 0 ? budgetUsd : null;
}

module.exports = { sizeLines, worstRisk };

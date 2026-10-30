'use strict';

/**
 * The prompt's Size and Min lines for a running prop attempt: what the sizing code will do, said as facts so the model
 * never works a size out. From the code that decides it: phase 2's pacing rules (phase2-cut.js rulesHolding, the
 * conditions a cut stands on) and the floor stretch's health (size-translate.js attemptHealth). Pure: no files.
 *
 *   sizeLines({ facts, riskUsd, minContracts, stretchUsd, capUsd })
 *       [size, min]: "Size: full verdict (healthy: balance ≥ start, no loss streak); phase 2 cuts only on a pacing rule",
 *       or "Size: phase 2 may cut (pacing: after-loss, drawdown)"; "Min: 3 contracts at the stop, else skip; ..." with
 *       the floor stretch when it applies. `facts`: phase2-cut.js cutFacts' shape; `riskUsd`: the risk a loss is
 *       measured at for the soft-stop rule (worstRisk). The plan's stop is not known per bar: the Min line states the
 *       rule.
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
  const size = held.includes('unknown') ? 'Size: phase 2 may cut (the attempt\'s pacing facts can\'t all be read)'
    : held.length ? `Size: phase 2 may cut (pacing: ${held.join(', ')})`
      : 'Size: full verdict (healthy: balance ≥ start, no loss streak); phase 2 cuts only on a pacing rule';
  if (!(Number.isInteger(minContracts) && minContracts >= 1)) return [size];
  const f = facts || {};
  const h = attemptHealth({ balance: f.balance, start: f.start, lossesToday: f.lossesToday });
  const stretch = num(stretchUsd) && num(capUsd) && stretchUsd > capUsd
    ? (h.healthy ? `; where the ${usd(capUsd)} cap fits fewer, code stretches to ${usd(stretchUsd)} all in for exactly ${minContracts}` : `; no floor stretch now (${h.why})`)
    : '';
  return [size, `Min: ${minContracts} contracts at the stop, else skip${stretch}`];
}

function worstRisk({ capUsd = null, stretchUsd = null, budgetUsd = null }) {
  if (num(capUsd) && capUsd > 0) return num(stretchUsd) && stretchUsd > capUsd ? stretchUsd : capUsd;
  return num(budgetUsd) && budgetUsd > 0 ? budgetUsd : null;
}

module.exports = { sizeLines, worstRisk };

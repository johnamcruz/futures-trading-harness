'use strict';

/**
 * The goal regression's sizing check (tier 2; docs/TRAINING.md, "The goal regression"): every trade on a tier 2 day
 * sized as the account rulebook plans it, recomputed from the day's own facts (the attempt's closed days, the day's
 * fills), never from the runner's snapshot or its translation. Pure: the day's result (tests/goal/tier2-day.js) and the
 * shipped pieces come in as data.
 *
 * A moment is an entry the day sized or skipped: each trade (goal-path.js dayTrades: its fill, its compose record's stop)
 * and each compose record refused "no size fits" or skipped by the size translation. At each moment the account state is
 * rebuilt from a fresh attempt (combine.start): the attempt's earlier closed days (a state day's), then the day's round
 * trips closed before it (their gross P&L and every fill's fees, as the exchange books them). The rulebook's plan there is
 * the rule (prop/size-translate.js entryPlan in the selected leg's mode: the most the composed cap fits all in, or the
 * healthy cap while healthy when on; lowered by the budget and the room, the broker's max order size, near the target;
 * under the floor the floor stretch while healthy).
 *
 *   roundTrips(day)                  [{ closedAt, gross, net }]: the day's closed trades from its fills, in order
 *   stateAt(day, account, atMs)      { cs, lossesToday }: the combine state just before `atMs`
 *   moments(day, { tick })           [{ key, kind: 'trade' | 'skip', atMs, stopTicks, filled, translated, approved, why }]
 *   planAt(day, m, ctx)              the live plan at moment m ({ root, size, riskPerContract } or null)
 *   simSizes(day, ctx)               { key: plan | null }: the simulator's size at each moment (prop/attempts.js
 *                                    defaultSize in the policy's own `contracts` mode, as the goal tier 1, the training
 *                                    Monte Carlo and the studies size): the day's process records it, so a break there
 *                                    patches it (tests/goal/breaks.js no-micro-fallback)
 *   sizingChecks(day, ctx)           [problem]: a fill not the plan's size (or phase 2's recorded cut), the translation not
 *                                    the plan, a dollar risk over the cap (over the stretch, or a stretch not exactly the
 *                                    floor while healthy), a size under the floor, a skip where the plan sizes, and the
 *                                    simulator sizing differently (a skip where live sizes, a size where live finds none,
 *                                    or its own risk over the same bounds)
 *   ctxOf(day, shipped, account)     ctx from the shipped pieces (goal-trades.js shippedOf) and the day's `sizing` facts
 * ctx: { account, policy, capUsd, symbol, selected, orderMax }: the shipped account and policy (its rulebook sizing; its
 * multipliers none: the verdict's 1, else every moment is a problem), the composed cap, the traded contract and the
 * selected ones (the runner's symbols), the broker's max order size as the day recorded it (the gate's own read).
 */

const combine = require('../trading/combine');
const { familyOf, specFor } = require('../trading/contracts');
const { feePerSide } = require('../trading/accounts');

const ms = t => Date.parse(t);
const r2 = x => Math.round(x * 100) / 100;

function roundTrips(day) {
  const out = [];
  let open = null;
  for (const f of [...(day.fills || [])].filter(x => !x.voided).sort((a, b) => a.id - b.id)) {
    const fee = Number(f.fees) || 0;
    if (!open) { open = { side: f.side, left: f.size, gross: Number(f.profitAndLoss) || 0, fees: fee }; continue; }
    open.fees += fee;
    if (f.profitAndLoss !== null && f.profitAndLoss !== undefined) open.gross += f.profitAndLoss;
    open.left += f.side === open.side ? f.size : -f.size;
    if (open.left <= 0) { out.push({ closedAt: f.creationTimestamp, gross: r2(open.gross), net: r2(open.gross - open.fees) }); open = null; }
  }
  return out;
}

function stateAt(day, account, atMs) {
  let cs = combine.start(account);
  const prior = ((day.attempt && day.attempt.days) || []).filter(d => d.day < day.day).sort((a, b) => (a.day < b.day ? -1 : 1));
  for (const d of prior) cs = combine.endDay(combine.applyClose(cs, r2(d.balance - cs.balance)));
  let lossesToday = 0;
  for (const rt of roundTrips(day)) {
    if (!(ms(rt.closedAt) < atMs)) continue;
    cs = combine.applyClose(cs, rt.net, rt.gross);
    if (rt.gross < 0) lossesToday += 1;
  }
  return { cs, lossesToday };
}

const cycleOf = (day, id) => (day.cycles || []).find(c => c.entry && c.entry.record === id) || null;

function moments(day, { tick }) {
  const GP = require('./goal-path');
  const out = GP.dayTrades(day, { tick }).filter(t => t.record).map(t => {
    const e = (cycleOf(day, t.record) || {}).entry || {};
    const sz = e.size || {};
    return { key: `trade|${t.key}`, kind: 'trade', atMs: ms(t.entryTime), stopTicks: t.stopTicks, filled: t.size, translated: sz.translated ?? null, approved: sz.approved ?? null };
  });
  for (const r of day.records || []) {
    if (!r.plan || !r.plan.stop) continue;
    const e = (cycleOf(day, r.id) || {}).entry;
    const noFit = !r.ok && (r.problems || []).some(p => /^no size fits/.test(p));
    const skipped = Boolean(r.ok && e && e.translated && e.translated.skip);
    if (noFit || skipped) out.push({ key: `skip|${r.id}`, kind: 'skip', atMs: ms(r.at), stopTicks: r.plan.stop.ticks, why: noFit ? 'compose_check: no size fits' : `the translation skipped it (${e.translated.reason})` });
  }
  return out;
}

/** The legs of the traded family and the mode a selection gives (the selected leg's; none: the policy's own). */
function legsOf(ctx, mode) {
  const at = require('../prop/attempts');
  const { legs, ratio } = at.legsFor(ctx.account, ctx.symbol);
  const fam = familyOf(ctx.symbol);
  const pick = fam && Array.isArray(ctx.selected) ? ctx.selected.find(x => x === fam.micro || x === fam.mini) : null;
  return { legs, ratio, mode: mode || (pick ? (pick === fam.micro ? 'micro' : 'mini') : ctx.policy.contracts || 'auto') };
}

function argsAt(day, m, ctx, mode) {
  const z = ctx.policy.sizing;
  const { cs, lossesToday } = stateAt(day, ctx.account, m.atMs);
  const { legs, ratio, mode: md } = legsOf(ctx, mode);
  return {
    cs, lossesToday, mode: md,
    args: { dollars: combine.budget(cs, z), room: combine.room(cs), stopTicks: m.stopTicks, legs, mode: md, guard: z.min_size_guard, fraction: 1, ratio, slipTicks: z.stop_slippage_ticks, minContracts: z.min_contracts },
    opts: { limits: { capUsd: ctx.capUsd, orderMax: ctx.orderMax ?? null }, healthyUsd: z.healthy_risk_usd, stretchUsd: z.floor_stretch_max_usd, state: { ...cs, lossesToday }, nearTargetUsd: z.near_target_usd },
  };
}

function planAt(day, m, ctx) {
  const a = argsAt(day, m, ctx, null);
  return require('../prop/size-translate').entryPlan(a.args, a.opts);
}

function simSizes(day, ctx) {
  const at = require('../prop/attempts');
  const out = {};
  for (const m of moments(day, { tick: day.tick })) {
    const a = argsAt(day, m, ctx, ctx.policy.contracts || 'auto');
    out[m.key] = at.defaultSize({ cs: a.cs, trade: { stopTicks: m.stopTicks }, sizing: ctx.policy.sizing, legs: a.args.legs, mode: a.mode, ratio: a.args.ratio, fraction: 1, limits: a.opts.limits, lossesToday: a.lossesToday });
  }
  return out;
}

/** A contract's all-in risk by hand: (the stop + the rulebook's slippage) x its tick value, plus its fee both ways. */
function perContract(ctx, root, stopTicks) {
  const spec = specFor(root);
  const slip = Math.max(combine.MIN_STOP_SLIPPAGE_TICKS, ctx.policy.sizing.stop_slippage_ticks);
  return (stopTicks + slip) * spec.tickValue + 2 * feePerSide(ctx.account, root);
}

/** Why `size` of `root` at moment m breaks the bounds (the cap; the stretch only as exactly the floor, while healthy). */
function boundsProblem(day, m, ctx, root, size) {
  const z = ctx.policy.sizing;
  const fam = familyOf(root);
  const each = fam && root === fam.mini ? legsOf(ctx).ratio : 1;
  const risk = size * perContract(ctx, root, m.stopTicks);
  const floorIn = Math.ceil(z.min_contracts / each);
  if (size * each < z.min_contracts) return `${size} ${root} is under the floor of ${z.min_contracts} micro-equivalents`;
  const { cs, lossesToday } = stateAt(day, ctx.account, m.atMs);
  const healthy = cs.balance >= cs.start && lossesToday === 0;
  // The cap in force: the composed cap, or the rulebook's healthy cap while healthy (when on).
  const cap = healthy && z.healthy_risk_usd > ctx.capUsd ? z.healthy_risk_usd : ctx.capUsd;
  if (risk <= cap + 1e-9) return null;
  if (size === floorIn && healthy && z.floor_stretch_max_usd > cap && risk <= z.floor_stretch_max_usd + 1e-9) return null;
  return `${size} ${root} risk $${r2(risk).toFixed(2)} all in, over the $${cap} cap${size === floorIn ? (healthy ? ` and the $${z.floor_stretch_max_usd} stretch` : ' with the attempt not healthy') : ' and not exactly the floor'}`;
}

function sizingChecks(day, ctx) {
  const out = [];
  const z = ctx.policy && ctx.policy.sizing;
  const all = moments(day, { tick: day.tick });
  if (!all.length) return out;
  if (!z || (ctx.policy.multipliers || []).length) return [`${day.day}: sizing: the check needs the policy's whole sizing and no verdict multipliers (the verdict's 1)`];
  const sims = day.simSizes || null;
  for (const m of all) {
    const at = `${day.day} sizing ${m.key}`;
    const plan = planAt(day, m, ctx);
    const said = p => (p ? `${p.size} ${p.root}` : 'no size');
    if (m.kind === 'trade') {
      if (!plan) { out.push(`${at}: filled ${m.filled}, but the rulebook plans no size at the ${m.stopTicks}-tick stop`); continue; }
      const cut = Number.isInteger(m.approved) && Number.isInteger(m.translated) && m.approved < m.translated && m.filled === m.approved;
      if (plan.root !== ctx.symbol) out.push(`${at}: the plan trades ${plan.root}, the fill ${ctx.symbol}`);
      if (m.filled !== plan.size && !cut) out.push(`${at}: filled ${m.filled}, the rulebook's plan at the ${m.stopTicks}-tick stop is ${said(plan)}`);
      if (m.translated !== plan.size) out.push(`${at}: the runner translated ${m.translated}, the rulebook's plan is ${said(plan)}`);
      const b = boundsProblem(day, m, ctx, ctx.symbol, m.filled);
      if (b) out.push(`${at}: ${b}`);
    } else if (plan) out.push(`${at}: skipped (${m.why}), but the rulebook plans ${said(plan)} at the ${m.stopTicks}-tick stop`);
    if (!sims || !(m.key in sims)) { out.push(`${at}: no simulator size recorded for it`); continue; }
    const sim = sims[m.key];
    if (m.kind === 'trade' && !sim) out.push(`${at}: the simulator (the policy's ${ctx.policy.contracts || 'auto'} mode) skips a trade live sizes at ${said(plan)}`);
    if (m.kind === 'skip' && sim) out.push(`${at}: the simulator sizes ${said(sim)} where live finds no fit`);
    if (sim) { const b = boundsProblem(day, m, ctx, sim.root, sim.size); if (b) out.push(`${at}: the simulator's ${b}`); }
  }
  return out;
}

/** The check's ctx: the shipped policy, its account and composed cap, the day's traded and selected contracts and max order size. */
const ctxOf = (day, shipped, account) => ({ account, policy: shipped.policy, capUsd: shipped.life.risk.max_risk_usd, ...(day.sizing || {}) });

module.exports = { ctxOf, roundTrips, stateAt, moments, planAt, simSizes, sizingChecks };

'use strict';

/**
 * The challenge env as a line protocol, for the Python trainer (rl/fth_rl).
 * One JSON object per line in each direction; requests are answered in order.
 *
 *   {"cmd":"info"}                              -> obsFields, actions, masks, reward, account, meta
 *   {"cmd":"starts","from":ISO,"to":ISO,"every":n} -> {"starts":[ms, ...]}
 *   {"cmd":"reset","start":ms,"end":ISO|ms}     -> the first decision, or done
 *   {"cmd":"step","action":k}                   -> the next decision, or done
 *   {"cmd":"evaluate","starts":[ms],"end":..,"network":{..}|null} -> evaluate() result
 *   {"cmd":"checkBundle","bundle":{..}}        -> {"errors":[...]} (as live trading checks it)
 *   {"cmd":"close"}
 *
 * A decision is {"obs":[...],"mask":[...],"kind":"setup"|"position","reward":r,"done":false};
 * the episode's end is {"done":true,"reward":r,"outcome":{...}}. The reward
 * answering a step is for that step's action: the balance change until the
 * next decision (over the max loss), + win / - loss for each trade closed
 * meanwhile, plus the outcome at the end. A reset
 * that finds no decision answers done with no reward.
 *
 * The engine runs the attempt and asks the policy hook synchronously; the
 * hook answers each decision and blocks for the next step, so an episode is
 * the backtester itself, paused at each decision. Any other request during an
 * episode abandons it and is then handled.
 */

const { ACTIONS, ACTION_N, MASKS, runAttempt, outcomeReward, denseReward, tradeReward, evaluate, policyHook } = require('./challenge-env');
const { OBS_FIELDS, observationFields } = require('./observation');
const { loadPolicy } = require('./policy-net');
const { checkBundle, BUNDLE_FORMAT, BUNDLE_VERSION, PROMOTION_GATE } = require('./policy-bundle');

class Abandon extends Error {}

const toMs = (v, name) => {
  const ms = typeof v === 'number' ? v : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${v}T00:00:00Z` : String(v));
  if (!Number.isFinite(ms)) throw new Error(`${name}: a date or epoch milliseconds`);
  return ms;
};
const endMs = v => (v === null || v === undefined ? Infinity : toMs(v, 'end'));

/**
 * Serve requests until close or end of input.
 * readLine(): the next line, or null at the end. writeLine(s): one line out.
 */
function serve({ env, meta = {}, readLine, writeLine }) {
  let pending = null;
  const reply = obj => writeLine(JSON.stringify(obj));
  const next = () => {
    if (pending) {
      const p = pending;
      pending = null;
      return p;
    }
    for (;;) {
      const line = readLine();
      if (line === null) return null;
      if (!line.trim()) continue;
      try {
        return JSON.parse(line);
      } catch (_err) {
        reply({ error: 'not JSON' });
      }
    }
  };

  function episode(req) {
    const start = toMs(req.start, 'start');
    const end = endMs(req.end);
    let lastBalance = null;
    let last = { wins: 0, losses: 0 };
    const policy = {
      decide(kind, obs, info) {
        const msg = { obs: Array.from(obs), mask: MASKS[kind], kind, t: info.t, done: false };
        if (lastBalance !== null) msg.reward = denseReward(env, lastBalance, info.balance) + tradeReward(env, info.wins - last.wins, info.losses - last.losses);
        reply(msg);
        lastBalance = info.balance;
        last = { wins: info.wins, losses: info.losses };
        for (;;) {
          const r = next();
          if (!r || r.cmd !== 'step') {
            pending = r || { cmd: 'close' };
            throw new Abandon();
          }
          const a = r.action;
          if (Number.isInteger(a) && a >= 0 && a < ACTION_N && MASKS[kind][a]) return ACTIONS[kind][a];
          reply({ error: `action ${JSON.stringify(a)} is not allowed for a ${kind} decision (mask ${MASKS[kind].join(',')})` });
        }
      },
    };
    let out;
    try {
      out = runAttempt(env, start, end, policy);
    } catch (err) {
      if (err instanceof Abandon) return;
      throw err;
    }
    const wins = out.trades.filter(t => t.net > 0).length;
    const losses = out.trades.filter(t => t.net < 0).length;
    // R per trade (after the stop it was sized from): winners', losers', and all of them, for win R / loss R / expectancy.
    const sumR = f => Math.round(out.trades.filter(f).reduce((a, t) => a + (Number.isFinite(t.r) ? t.r : 0), 0) * 1000) / 1000;
    const outcome = {
      start: out.start, status: out.status, sessions: out.sessions, profit: out.profit, balance: out.balance, trades: out.trades.length, wins, losses,
      winR: sumR(t => t.net > 0), lossR: sumR(t => t.net < 0), sumR: sumR(() => true),
    };
    if (lastBalance === null) reply({ done: true, outcome, decisions: 0 });
    else {
      const reward = denseReward(env, lastBalance, out.balance) + tradeReward(env, wins - last.wins, losses - last.losses) + outcomeReward(env, out);
      reply({ done: true, reward, outcome, decisions: out.decisions.length });
    }
  }

  for (;;) {
    const req = next();
    if (!req || req.cmd === 'close') return;
    try {
      switch (req.cmd) {
        case 'info':
          reply({ ...meta, bundleFormat: BUNDLE_FORMAT, bundleVersion: BUNDLE_VERSION, promotionGate: PROMOTION_GATE, obsFields: env.prop ? observationFields(env.prop.components) : OBS_FIELDS, actions: ACTIONS, actionN: ACTION_N, masks: MASKS, reward: env.reward, accountProfile: env.account, days: env.days.length, firstDay: env.days[0] ?? null, lastDay: env.days[env.days.length - 1] ?? null });
          break;
        case 'starts':
          reply({ starts: env.starts(toMs(req.from, 'from'), endMs(req.to), { every: req.every || 1 }) });
          break;
        case 'reset':
          episode(req);
          break;
        case 'step':
          reply({ error: 'no episode is running (reset first)' });
          break;
        case 'evaluate': {
          const starts = (req.starts || []).map(s => toMs(s, 'starts'));
          reply(evaluate(env, starts, endMs(req.end), req.network ? policyHook(loadPolicy(req.network)) : null));
          break;
        }
        case 'checkBundle':
          reply({ errors: checkBundle(req.bundle) });
          break;
        default:
          reply({ error: `unknown cmd ${JSON.stringify(req.cmd)}` });
      }
    } catch (err) {
      reply({ error: err.message });
    }
  }
}

module.exports = { serve };

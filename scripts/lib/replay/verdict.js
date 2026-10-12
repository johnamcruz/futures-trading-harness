'use strict';

/**
 * The combine verdict of a replay run: each calendar month's trading scored
 * against a prop account's challenge (accounts/<name>/ACCOUNT.md), as a fresh
 * attempt from the starting balance each month. The rules are combine.js's,
 * the same state machine the RL env, the backtester and the live gate drive
 * (start, applyClose, touches, dailyBreached, blow, endDay, profitNeeded), so
 * a replayed month is judged as training judges an attempt:
 *
 *   - a pass is checked at the end of a trading day: profit at or above the
 *     target and, when the account has consistency_pct, the best day at most
 *     that share of the profit;
 *   - equity at or below the max-loss floor at any moment fails the month
 *     (max_loss_mode trailing_eod: the floor trails the highest end-of-day
 *     balance and stops at the starting balance; static: it never moves);
 *   - the firm's daily loss limit flattens the trade there and stops trading
 *     for the rest of the day; it doesn't end the attempt (combine.js). Of the
 *     two levels, the daily limit's and the floor's, the nearer one is reached
 *     first as a trade's open P&L falls, and acts;
 *   - `sessions` is the training attempt's length, not a firm rule: as for a
 *     live attempt (prop-state.js), a month never times out (training would
 *     stop at `sessions` days; the output says when a month has more). The
 *     account has no minimum-days or other time rule to apply.
 *
 * Money: every fill the replay broker reported, its realized P&L minus its
 * fees, as the account balance moves (prop-state closeBefore): fees are paid
 * on the opening fill too. Days: the CME trading day of each fill (17:00
 * Chicago, clock.js tradingDayKey) and every day the run replayed; months are
 * the trading day's calendar month.
 *
 * What the replay doesn't record, approximated (said in the output):
 *   - intraday equity: a round trip's MAE (maeDollars: its worst P&L from
 *     the open, partial exits included, as backtester-mcp reports it) less the
 *     closing fill's fees, less what the position had realized by then, set
 *     against the account as it was: at its maeTime, in time order on its own
 *     trading day (so it can stop that day, or undo a pass that came after
 *     it); without one, at every state while it was held (after each fill and
 *     at each day's start), each on its own balance, floor and room to the
 *     daily limit, the worst counting, a state on an earlier day judged
 *     against its floor only (a stop that day can be missed, and a pass with
 *     the position still open stands, said in the output). Without MAE, only
 *     the close is seen. Open trades on other contracts at
 *     the same moment are not added together.
 *   - at the daily limit the breaching close counts as the limit and the rest
 *     of every position open then is left out (the firm flattens the account);
 *     so is a position opened later that day (the firm would refuse it) and
 *     one carried in from before the month (it belongs to no fresh attempt).
 *   - a fill whose side, size, P&L or fees can't be read is skipped and
 *     counted (the output says the verdict may be wrong); its contract's
 *     position is then unknown, and assumed flat from the next month (said).
 *
 *   evaluate(days, account, { daysDone, why })   { why, account, months, summary }
 *   resolveAccount({ override, runnerAccount, strategies, accounts })   { name, why }
 *   verdictText(v) / verdictMarkdown(v)
 */

const combine = require('../trading/combine');
const { tradingDayKey, tradingDayStart } = require('../trading/clock');

const DEFAULT_ACCOUNT = 'topstep_100k';
const round2 = x => Math.round(x * 100) / 100;
const num = x => (x === null || x === undefined || x === '' ? null : (Number.isFinite(Number(x)) ? Number(x) : NaN));

/**
 * Which account to score against: --account, else the runner config's
 * `account` when it names an account profile (it is usually the broker's
 * account id), else the policy strategies' account when they agree, else
 * topstep_100k.
 */
function resolveAccount({ override, runnerAccount, strategies = [], accounts = [] }) {
  const names = new Set(accounts.map(a => a.name));
  if (override) return { name: override, why: '--account' };
  if (runnerAccount && names.has(String(runnerAccount))) return { name: String(runnerAccount), why: 'the runner config\'s account' };
  const prop = [...new Set(strategies.filter(s => s && s.signal === 'policy' && s.account).map(s => s.account))];
  if (prop.length === 1) return { name: prop[0], why: `the policy strategies' account (${strategies.filter(s => s.signal === 'policy' && s.account === prop[0]).map(s => s.name).join(', ')})` };
  const why = prop.length > 1 ? `the default: the prop strategies name several accounts (${prop.join(', ')}); pass --account` : 'the default (no --account, no prop account in the runner config or the strategies)';
  return { name: DEFAULT_ACCOUNT, why };
}

/** Every fill of the run, in time order, with its trading day, signed size and net. */
function fillsOf(days) {
  const out = [];
  const seen = new Set();
  let order = 0;
  for (const day of Object.keys(days).sort()) {
    for (const rec of days[day] || []) {
      for (const f of Array.isArray(rec.trades) ? rec.trades : []) {
        if (!f || f.voided) continue;
        if (f.id !== undefined && f.id !== null) {
          if (seen.has(String(f.id))) continue;
          seen.add(String(f.id));
        }
        const ms = Date.parse(f.creationTimestamp);
        const pnl = num(f.profitAndLoss);
        const fees = num(f.fees) ?? 0;
        const size = Math.abs(Number(f.size));
        const side = f.side === 0 || f.side === 1 || f.side === '0' || f.side === '1' ? Number(f.side) : null;
        const rt = f.roundTrip && typeof f.roundTrip === 'object' ? f.roundTrip : null;
        const fill = {
          ms: Number.isFinite(ms) ? ms : (Number.isFinite(Date.parse(rec.t)) ? Date.parse(rec.t) : 0), order: order += 1,
          day: Number.isFinite(ms) ? tradingDayKey(new Date(ms)) : (rec.day || day),
          contract: String(f.contractId || '?'),
          delta: !(size > 0) || side === null ? null : side === 0 ? size : -size,
          closing: pnl !== null,
          net: pnl === null ? -fees : pnl - fees,
          fees,
          mae: rt && num(rt.maeDollars) !== null && !Number.isNaN(num(rt.maeDollars)) ? Math.min(0, num(rt.maeDollars)) : null,
          maeMs: rt && Number.isFinite(Date.parse(rt.maeTime)) ? Date.parse(rt.maeTime) : null,
        };
        out.push(fill);
        // The MAE's own moment, judged in time order (before a fill at the same time): the account as it was then.
        if (fill.closing && fill.mae !== null && fill.maeMs !== null) {
          out.push({ kind: 'mae', ms: fill.maeMs, order: -(order += 1), day: tradingDayKey(new Date(fill.maeMs)), contract: fill.contract, mae: fill.mae, fees: fill.fees, close: fill });
        }
      }
    }
  }
  return out.sort((a, b) => a.ms - b.ms || a.order - b.order);
}

function blankMonth(key, account) {
  return {
    key, s: combine.start(account), days: [], events: [], excluded: [], notes: [], unreadable: 0,
    worstCushion: account.max_loss, worstDay: null, passDay: null, fail: null, intradayChecked: 0, closes: 0, traded: new Set(),
  };
}

function lowWater(m, cushion, day) {
  if (cushion < m.worstCushion) { m.worstCushion = cushion; m.worstDay = day; }
}

/** Where a moment's loss goes first: the daily limit, the floor (the nearer one acts), or neither. */
function level(x) {
  const cushion = x.balance - x.floor;
  if (x.room < cushion) return x.loss >= x.room ? 'daily' : null;
  return x.loss >= cushion ? 'floor' : null;
}

/**
 * Judge moments: the floor fails the month; else the daily limit stops the day.
 * Returns 'floor', 'daily' or null (and keeps the low-water mark).
 */
function judge(m, moments) {
  for (const x of moments) lowWater(m, x.balance - x.floor - (level(x) === 'daily' ? x.room : x.loss), x.day);
  const blown = moments.find(x => level(x) === 'floor');
  if (blown) {
    m.s = combine.blow(m.s);
    m.fail = { rule: 'max-loss', day: blown.day, how: `equity ${blown.mae ? 'reached' : 'closed at'} $${round2(blown.balance - blown.loss)}${blown.mae ? ' (from the trade\'s MAE)' : ''}, floor $${blown.floor}` };
    return 'floor';
  }
  return moments.some(x => level(x) === 'daily') ? 'daily' : null;
}

/** The firm flattens at the daily limit (as the backtester's guard does): the day's loss is the limit. */
function stopDay(m, day, text) {
  const s = m.s;
  const capped = round2(-s.dailyLimit - s.dayPnl);
  m.s = { ...combine.applyClose(s, capped), dayStopped: true };
  lowWater(m, m.s.balance - m.s.floor, day);
  m.events.push({ day, text: `daily loss limit ($${s.dailyLimit}) hit: flattened there (${text(capped)}); no trading until the next session` });
  return true;
}

const roomOf = (s, dayPnl) => (s.dailyLimit > 0 && !s.dayStopped ? s.dailyLimit + dayPnl : Infinity);

/**
 * A round trip's MAE at its time (`maeTime`): its open P&L then (the MAE counts from the open, partial
 * exits included, so less what the position had realized; less the closing fee still to pay) against the
 * account as it was then. Returns true when it hit the daily limit (the caller flattens what is open).
 */
function applyMae(m, ev, held) {
  const s = m.s;
  const open = ev.mae - held.r - ev.fees;
  const out = judge(m, [{ balance: s.balance, floor: s.floor, room: roomOf(s, s.dayPnl), loss: -open, mae: true, day: ev.day }]);
  if (out !== 'daily') return false;
  return stopDay(m, ev.day, capped => `${ev.contract} was at $${round2(open)} (its MAE, at ${new Date(ev.ms).toISOString()}), counted as $${capped}`);
}

/**
 * One fill against the month's attempt. Returns true when it hit the firm's
 * daily limit (the caller then leaves the rest of every open position out).
 * `held`: the closing fill's position, with the account's states since it
 * opened (see evaluate), where its MAE may have happened.
 */
function applyFill(m, f, held = null) {
  let s = m.s;
  m.traded.add(f.day);
  if (!f.closing) {
    s = combine.applyClose(s, f.net);
    lowWater(m, s.balance - s.floor, f.day);
    // A fee that took the day to the firm's limit stops it there too: the account is flattened.
    const stopped = !m.s.dayStopped && s.dayStopped && s.status === 'active';
    if (stopped) m.events.push({ day: f.day, text: `daily loss limit ($${s.dailyLimit}) hit by an opening fill's fee: flattened there; no trading until the next session` });
    m.s = s;
    return stopped;
  }
  m.closes += 1;
  if (f.mae !== null) m.intradayChecked += 1;
  // The close itself; and the trade's MAE, when its time wasn't judged already (applyMae): at every
  // account state since the position opened, each on its own balance, floor and room to the daily
  // limit (less what the position had realized, since the MAE counts from the open), the worst
  // counting. Open P&L falls continuously, so the nearer level is reached first and acts there (as
  // the backtester's guard does bar by bar). A state on an earlier day is judged against its floor
  // only: that day's limit is past this day's reach (a stop that day may be missed).
  const moments = [{ balance: s.balance, floor: s.floor, room: roomOf(s, s.dayPnl), loss: -f.net, mae: false, day: f.day }];
  if (f.mae !== null && !f.maeDone) {
    const states = held && held.states.length ? held.states : [{ ms: f.ms, day: f.day, balance: s.balance, floor: s.floor, dayPnl: s.dayPnl }];
    for (const x of states) moments.push({ balance: x.balance, floor: x.floor, room: x.day === f.day ? roomOf(s, x.dayPnl) : Infinity, loss: -(f.mae - f.fees), mae: true, day: x.day });
  }
  const out = judge(m, moments);
  if (out === 'floor') return false;
  if (out === 'daily') {
    const worst = -Math.max(...moments.filter(x => level(x) === 'daily').map(x => x.loss));
    return stopDay(m, f.day, capped => `trade ${f.net < capped ? `closed at $${round2(f.net)}` : `went to $${round2(worst)} before closing at $${round2(f.net)}`}, counted as $${capped}`);
  }
  m.s = combine.applyClose(s, f.net);
  lowWater(m, m.s.balance - m.s.floor, f.day);
  return false;
}


function endDay(m, day) {
  if (m.s.status !== 'active') return;
  const before = m.s;
  let s = combine.endDay(before);
  // `sessions` bounds training attempts, not the firm's (prop-state.js): the month runs on.
  if (s.status === 'timeout') s = { ...s, status: 'active' };
  m.days.push({ day, pnl: before.dayPnl, balance: s.balance, floor: s.floor });
  if (s.status === 'passed') m.passDay = day;
  m.s = s;
}

/**
 * Each month's verdict. `daysDone`: the trading days the run finished (a day
 * still running gets no end of day yet); null: every day is done.
 */
function evaluate(days, account, { daysDone = null, why = null } = {}) {
  const fills = fillsOf(days);
  const allDays = [...new Set([...Object.keys(days), ...fills.map(f => f.day)])].sort();
  const done = daysDone ? new Set(daysDone) : null;
  const pos = new Map(); // contract -> signed size, across the whole run
  const left = new Map(); // contract -> why its position is left out, until it is flat
  const unknown = new Map(); // contract -> the day an unreadable fill left its position unknown
  // contract -> its counted position since it opened: when, its realized P&L so far (before fees: the MAE
  // counts it from the open) and the account states since then (after each fill, and at each day's
  // start), less that P&L, where its MAE may have happened.
  const opened = new Map();
  const state = (o, ms, day) => o.states.push({ ms, day, balance: m.s.balance - o.r, floor: m.s.floor, dayPnl: m.s.dayPnl - o.r });
  const byDay = new Map();
  for (const f of fills) {
    if (!byDay.has(f.day)) byDay.set(f.day, []);
    byDay.get(f.day).push(f);
  }
  const flatten = () => { for (const [c, q] of pos) if (q !== 0) left.set(c, 'flattened at the daily loss limit'); };
  // A day known only from a fill's time, before the last day done, is done too.
  const lastDone = daysDone && daysDone.length ? [...daysDone].sort().pop() : null;
  const months = [];
  let m = null;
  for (const day of allDays) {
    const key = day.slice(0, 7);
    if (!m || m.key !== key) {
      if (m) {
        // A counted position still open at the month's end: its close falls in no month's attempt.
        const still = [...pos].filter(([c, q]) => q !== 0 && !left.has(c) && !unknown.has(c)).map(([c]) => c);
        if (still.length && m.s.status === 'active') m.notes.push(`${still.join(', ')} still open at the end of the month: its close counts in no month (the next one leaves it out as carried in)`);
        months.push(m);
      }
      m = blankMonth(key, account);
      // A position whose size an unreadable fill made unknown: assumed flat for the new month (said so).
      for (const [c, d] of unknown) {
        pos.set(c, 0);
        left.delete(c);
        m.notes.push(`${c}: position unknown after an unreadable fill on ${d}; assumed flat from the start of the month`);
      }
      unknown.clear();
      opened.clear();
      // A position carried in from last month belongs to no fresh attempt.
      for (const [c, q] of pos) if (q !== 0) left.set(c, 'carried in from the month before');
    }
    const dayStartMs = tradingDayStart(new Date(`${day}T12:00:00Z`)).getTime();
    for (const o of opened.values()) state(o, dayStartMs, day);
    for (const f of byDay.get(day) || []) {
      if (f.kind === 'mae') {
        const held = opened.get(f.contract);
        // Judged only for a counted position that was open then (else at its close, at every state).
        if (m.s.status !== 'active' || left.has(f.contract) || !held || f.ms < held.since) continue;
        f.close.maeDone = true;
        if (applyMae(m, f, held)) flatten();
        for (const o of opened.values()) state(o, f.ms, day);
        continue;
      }
      // A fill whose side, size or money can't be read: position tracking and the balance would both be guesses.
      if (f.delta === null || !Number.isFinite(f.net)) {
        m.unreadable += 1;
        unknown.set(f.contract, day);
        continue;
      }
      const prev = pos.get(f.contract) || 0;
      const next = prev + f.delta;
      pos.set(f.contract, next);
      if (!left.has(f.contract) && prev === 0 && m.s.status === 'active' && m.s.dayStopped) left.set(f.contract, 'opened after the daily loss limit was hit');
      if (left.has(f.contract)) {
        if (m.s.status === 'active') m.excluded.push({ day, contract: f.contract, net: round2(f.net), why: left.get(f.contract) });
        if (next === 0) left.delete(f.contract);
        continue;
      }
      if (m.s.status !== 'active') continue;
      const held = opened.get(f.contract) || null;
      const before = m.s.balance;
      const hit = applyFill(m, f, held);
      if (next === 0) opened.delete(f.contract);
      else if (prev === 0 || Math.sign(prev) !== Math.sign(next)) opened.set(f.contract, { since: f.ms, r: 0, states: [] }); // a new position (from flat, or reversed)
      else if (held && f.closing) held.r += m.s.balance - before + f.fees; // a partial exit, before its fees
      for (const o of opened.values()) state(o, f.ms, day);
      // At the daily limit the firm flattens the whole account: what is still open is left out from here.
      if (hit) flatten();
      // A close (or a fee) that took the balance to the floor: combine.applyClose marks it blown.
      if (m.s.status === 'blown' && !m.fail) m.fail = { rule: 'max-loss', day, how: `the balance closed at $${m.s.balance}, floor $${m.s.floor}` };
    }
    if (!done || done.has(day) || (lastDone && day < lastDone)) {
      endDay(m, day);
      // A pass with positions still open: a loss they took before it is judged only from their MAE's time.
      const open = [...opened.keys()].filter(c => (pos.get(c) || 0) !== 0 && !left.has(c));
      if (m.passDay === day && open.length) m.notes.push(`passed on ${day} with ${open.join(', ')} still open: a loss before the pass is judged only when the broker gives its MAE's time`);
    }
    else m.openDay = { day, pnl: m.s.dayPnl };
  }
  if (m) months.push(m);
  const rows = months.map(x => finishMonth(x, account));
  const count = v => rows.filter(r => r.verdict === v).length;
  return {
    why,
    account: { name: account.name, start: account.starting_balance, target: account.profit_target, maxLoss: account.max_loss, mode: account.max_loss_mode, dailyLimit: account.daily_loss_limit || 0, consistency: account.consistency_pct || 0 },
    months: rows,
    summary: { months: rows.length, passed: count('PASS'), failed: count('FAIL'), notYet: count('NOT YET') },
  };
}

function finishMonth(m, account) {
  const s = m.s;
  const profit = round2(combine.profit(s));
  const verdict = m.fail ? 'FAIL' : m.passDay ? 'PASS' : 'NOT YET';
  const needed = round2(combine.profitNeeded(s, s.days));
  return {
    key: m.key, verdict, passDay: m.passDay, fail: m.fail, profit, target: account.profit_target, needed,
    bestDay: round2(Math.max(0, ...m.days.map(d => d.pnl))),
    daysTraded: m.traded.size, daysReplayed: m.days.length,
    maxLossUsed: round2(Math.min(account.max_loss, Math.max(0, account.max_loss - m.worstCushion))), maxLoss: account.max_loss, worstDay: m.worstDay,
    days: m.days, events: m.events, excluded: m.excluded, notes: m.notes, unreadable: m.unreadable,
    closes: m.closes, intradayChecked: m.intradayChecked, openDay: m.openDay || null,
    pastSessions: m.days.length > account.sessions ? account.sessions : null,
  };
}

const usd = x => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
const signed = x => `${x > 0 ? '+' : x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;

function verdictLine(r) {
  if (r.verdict === 'PASS') return `PASS on ${r.passDay}: profit ${usd(r.profit)} (target ${usd(r.target)})`;
  if (r.verdict === 'FAIL') return `FAIL on ${r.fail.day}: ${r.fail.rule} (${r.fail.how}); profit ${usd(r.profit)}`;
  const more = r.needed > r.target ? `; the best day (${usd(r.bestDay)}) needs ${usd(r.needed)} for consistency` : '';
  return `NOT YET: profit ${usd(r.profit)} of ${usd(r.target)} (${usd(Math.max(0, r.needed - r.profit))} to go${more}), ${r.daysTraded} of ${r.daysReplayed} day(s) traded`;
}

function headLine(v) {
  const a = v.account;
  const rules = [`target ${usd(a.target)}`, `max loss ${usd(a.maxLoss)} ${a.mode === 'trailing_eod' ? 'trailing the end-of-day high, locking at the start' : a.mode}`,
    a.dailyLimit ? `daily limit ${usd(a.dailyLimit)} (stops the day, not the attempt)` : 'no daily limit', a.consistency ? `best day at most ${a.consistency}% of the profit` : 'no consistency rule'];
  return `Combine verdict: ${a.name} (${v.why || 'account given'}); each month a fresh attempt from ${usd(a.start)}: ${rules.join(', ')}.`;
}

const NOTES = [
  'Fresh each month: every calendar month (by CME trading day, 17:00 Chicago) starts a new attempt at the starting balance, so one month\'s result never carries into the next.',
  'Money: each fill\'s realized P&L less its fees, as the balance moves. Rules: combine.js, the same as RL training and the backtester.',
  'Approximation: intraday equity is a round trip\'s MAE less its closing fee, set against the account when it happened (its maeTime, on its own day) or, without one, at every point the position was held, each on that point\'s balance, floor and daily room, the worst counting, an earlier day\'s point against its floor only (trades open together are not added up; a trade without MAE is seen only at its close).',
  'Left out: at the daily loss limit the account is flattened (the breaching trade counts as the limit; the rest of any open position is left out), positions opened after it that day (the firm would refuse them), and positions carried in from the month before (until flat, so a reversal of one is left out too).',
];

const dayPath = r => r.days.map(d => `${d.day.slice(5)} ${signed(d.pnl)}`).join(', ');

function monthDetail(r) {
  const out = [];
  out.push(`max loss used ${usd(r.maxLossUsed)} of ${usd(r.maxLoss)}${r.worstDay ? ` (closest to the floor on ${r.worstDay})` : ''}; intraday from MAE on ${r.intradayChecked} of ${r.closes} closing fill(s)`);
  if (r.days.length) out.push(`days: ${dayPath(r)}`);
  if (r.openDay) out.push(`${r.openDay.day} is still being replayed (${signed(r.openDay.pnl)} so far): no end of day for it yet`);
  for (const e of r.events) out.push(`${e.day}: ${e.text}`);
  if (r.excluded.length) out.push(`left out: ${r.excluded.map(x => `${x.day} ${x.contract} ${signed(x.net)} (${x.why})`).join('; ')}`);
  if (r.unreadable) out.push(`${r.unreadable} fill(s) with no readable side, size, P&L or fees were skipped: the verdict may be wrong`);
  for (const n of r.notes) out.push(n);
  if (r.pastSessions) out.push(`more days than the account's training length (${r.pastSessions} sessions): training would stop there (timeout); the replay runs the month on, as a live attempt does`);
  return out;
}

function summaryLine(v) {
  const s = v.summary;
  return `Summary: ${s.passed} passed, ${s.failed} failed, ${s.notYet} not yet, of ${s.months} month(s).`;
}

function verdictText(v) {
  const lines = ['', headLine(v)];
  for (const r of v.months) {
    lines.push(`${r.key}  ${verdictLine(r)}`);
    for (const d of monthDetail(r)) lines.push(`         ${d}`);
  }
  lines.push(summaryLine(v), ...NOTES.map(n => `  ${n}`));
  return `${lines.join('\n')}\n`;
}

function verdictMarkdown(v) {
  const head = ['month', 'verdict', 'profit', 'max loss used', 'days traded', 'daily P&L'];
  const rows = v.months.map(r => `| ${[r.key, verdictLine(r), usd(r.profit), `${usd(r.maxLossUsed)} of ${usd(r.maxLoss)}`, `${r.daysTraded} of ${r.daysReplayed}`,
    dayPath(r) || '-'].join(' | ')} |`);
  const extra = v.months.flatMap(r => [...r.events.map(e => `- ${r.key}, ${e.day}: ${e.text}`),
    ...r.excluded.map(x => `- ${r.key}, ${x.day}: left out ${x.contract} ${signed(x.net)} (${x.why})`),
    ...(r.openDay ? [`- ${r.key}: ${r.openDay.day} is still being replayed (${signed(r.openDay.pnl)} so far): no end of day for it yet`] : []),
    ...(r.unreadable ? [`- ${r.key}: ${r.unreadable} fill(s) with no readable side, size, P&L or fees were skipped`] : []),
    ...r.notes.map(n => `- ${r.key}: ${n}`),
    ...(r.pastSessions ? [`- ${r.key}: more days than the account's training length (${r.pastSessions} sessions); training would stop there, the replay runs the month on`] : [])]);
  return ['## Combine verdict', '', headLine(v), '', `| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows, '',
    summaryLine(v), '', ...(extra.length ? [...extra, ''] : []), ...NOTES.map(n => `- ${n}`), ''].join('\n');
}

module.exports = { DEFAULT_ACCOUNT, resolveAccount, fillsOf, evaluate, verdictText, verdictMarkdown };

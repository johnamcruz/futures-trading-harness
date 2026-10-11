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
 *   - intraday equity: a round trip's MAE (maeDollars) less the closing fill's
 *     fees is the trade's worst open P&L. When it happened isn't recorded, so
 *     it is judged at each moment it may have been, each on its own balance,
 *     floor and room to the daily limit: at the close, when the position
 *     opened (partial exits since may have banked profit after it), and for a
 *     position held overnight at the start of the closing day; the worst
 *     outcome counts. Without MAE, only the close is seen. Open trades on other
 *     contracts at the same moment are not added together.
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
const { tradingDayKey } = require('../trading/clock');

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
        out.push({
          ms: Number.isFinite(ms) ? ms : (Number.isFinite(Date.parse(rec.t)) ? Date.parse(rec.t) : 0), order: order += 1,
          day: Number.isFinite(ms) ? tradingDayKey(new Date(ms)) : (rec.day || day),
          contract: String(f.contractId || '?'),
          delta: !(size > 0) || side === null ? null : side === 0 ? size : -size,
          closing: pnl !== null,
          net: pnl === null ? -fees : pnl - fees,
          fees,
          mae: rt && num(rt.maeDollars) !== null && !Number.isNaN(num(rt.maeDollars)) ? Math.min(0, num(rt.maeDollars)) : null,
        });
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

/**
 * One fill against the month's attempt. Returns true when it hit the firm's
 * daily limit (the caller then leaves the rest of every open position out).
 * `base`: the balance, floor and day's P&L when the closing fill's position
 * opened (its MAE is also judged from there: partial exits since then may
 * have banked profit after it).
 */
function applyFill(m, f, base = null) {
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
  // When the trade was at its worst isn't recorded, so each moment it may have been is judged on its
  // own numbers (balance, floor, room to the daily limit) and the worst outcome counts. Open P&L falls
  // continuously, so at each the nearer level is reached first and acts (as the backtester's guard
  // does bar by bar).
  const mae = f.mae !== null ? f.mae - f.fees : null; // its MAE, less the closing fee still to pay
  const room = dayPnl => (s.dailyLimit > 0 && !s.dayStopped ? s.dailyLimit + dayPnl : Infinity);
  // Now, at the close: the close itself, or the MAE just before it.
  const moments = [{ balance: s.balance, floor: s.floor, room: room(s.dayPnl), loss: -Math.min(f.net, mae ?? f.net), mae: mae !== null && mae < f.net }];
  if (mae !== null && base) {
    // When the position opened (partial exits since may have banked profit after the MAE). On an
    // earlier day, that day's limit is past this day's reach: only its floor is checked.
    moments.push({ balance: base.balance, floor: base.floor, room: base.day === f.day ? room(base.dayPnl) : Infinity, loss: -mae, mae: true });
    // Held overnight: at the start of today, with today's P&L at 0, against today's floor.
    if (base.day !== f.day) moments.push({ balance: s.balance - s.dayPnl, floor: s.floor, room: room(0), loss: -mae, mae: true });
  }
  const level = x => {
    const cushion = x.balance - x.floor;
    if (x.room < cushion) return x.loss >= x.room ? 'daily' : null;
    return x.loss >= cushion ? 'floor' : null;
  };
  for (const x of moments) lowWater(m, x.balance - x.floor - (level(x) === 'daily' ? x.room : x.loss), f.day);
  const blown = moments.find(x => level(x) === 'floor');
  if (blown) {
    m.s = combine.blow(s);
    m.fail = { rule: 'max-loss', day: f.day, how: `equity ${blown.mae ? 'reached' : 'closed at'} $${round2(blown.balance - blown.loss)}${blown.mae ? ' (from the trade\'s MAE)' : ''}, floor $${blown.floor}` };
    return false;
  }
  const daily = moments.filter(x => level(x) === 'daily');
  if (daily.length) return dailyStop(m, f, -Math.max(...daily.map(x => x.loss)));
  m.s = combine.applyClose(s, f.net);
  lowWater(m, m.s.balance - m.s.floor, f.day);
  return false;
}

/** The firm flattens at the daily limit (as the backtester's guard does): the day's loss is the limit. */
function dailyStop(m, f, worst) {
  const s = m.s;
  const capped = round2(-s.dailyLimit - s.dayPnl);
  m.s = { ...combine.applyClose(s, capped), dayStopped: true };
  lowWater(m, m.s.balance - m.s.floor, f.day);
  m.events.push({ day: f.day, text: `daily loss limit ($${s.dailyLimit}) hit: flattened there (trade ${f.net < capped ? `closed at $${round2(f.net)}` : `went to $${round2(worst)} before closing at $${round2(f.net)}`}, counted as $${capped}); no trading until the next session` });
  return true;
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
  const opened = new Map(); // contract -> { balance, dayPnl, day } when its counted position opened
  const byDay = new Map();
  for (const f of fills) byDay.set(f.day, [...(byDay.get(f.day) || []), f]);
  // A day known only from a fill's time, before the last day done, is done too.
  const lastDone = daysDone && daysDone.length ? [...daysDone].sort().pop() : null;
  const months = [];
  let m = null;
  for (const day of allDays) {
    const key = day.slice(0, 7);
    if (!m || m.key !== key) {
      if (m) months.push(m);
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
    for (const f of byDay.get(day) || []) {
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
      const base = opened.get(f.contract) || null;
      const hit = applyFill(m, f, base);
      // A new position (from flat, or reversed): its MAE is measured from here.
      if (next === 0) opened.delete(f.contract);
      else if (prev === 0 || Math.sign(prev) !== Math.sign(next)) opened.set(f.contract, { balance: m.s.balance, floor: m.s.floor, dayPnl: m.s.dayPnl, day });
      // At the daily limit the firm flattens the whole account: what is still open is left out from here.
      if (hit) for (const [c, q] of pos) if (q !== 0) left.set(c, 'flattened at the daily loss limit');
      // A close (or a fee) that took the balance to the floor: combine.applyClose marks it blown.
      if (m.s.status === 'blown' && !m.fail) m.fail = { rule: 'max-loss', day, how: `the balance closed at $${m.s.balance}, floor $${m.s.floor}` };
    }
    if (!done || done.has(day) || (lastDone && day < lastDone)) endDay(m, day);
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
  'Approximation: intraday equity is a round trip\'s MAE less its closing fee, judged at each moment it may have happened (at the close, when the position opened, and for one held overnight at the start of the day) on that moment\'s balance, floor and daily room, the worst counting (trades open together are not added up); a trade without MAE is seen only at its close.',
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

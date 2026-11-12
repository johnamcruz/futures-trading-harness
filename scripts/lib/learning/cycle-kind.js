'use strict';

/**
 * How a run's head trade cycle is read as a decision, and where a run's replay runs are: one home for the rules the
 * read audit (learning/read-audit.js) and the recognition test (learning/recognition/run.js) both read a run by. Read
 * only, pure but for listing folders; nothing that decides requires it.
 *
 *   outcomeWord(result)                    the CYCLE RESULT word (markdown marks aside), lower case; '' when none
 *   kindOf({ decision, orders, result })   { kind: entry | pass | in-trade, side }: the decision record's when joined
 *                                          (inTrade, or its actual action long | short), else the cycle's own: a managed
 *                                          result is in the trade, an order the gate allowed (buy | sell) an entry, else
 *                                          a pass
 *   replayDirs(target)                     the replay run dirs (a manifest.json) under a run home, a runs folder, or the
 *                                          replay run dir itself
 */

const fs = require('fs');
const path = require('path');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

const outcomeWord = result => ((/CYCLE RESULT:[\s*_`]*([a-z][a-z-]*)/i.exec(String(result || '')) || [])[1] || '').toLowerCase();

function kindOf({ decision = null, orders = [], result = null } = {}) {
  if (isObj(decision)) {
    if (decision.inTrade === true || decision.decision === 'in-trade') return { kind: 'in-trade', side: null };
    const a = isObj(decision.actual) ? decision.actual.action : null;
    return a === 'long' || a === 'short' ? { kind: 'entry', side: a } : { kind: 'pass', side: null };
  }
  if (outcomeWord(result) === 'managed') return { kind: 'in-trade', side: null };
  const o = (Array.isArray(orders) ? orders : []).find(x => isObj(x) && x.gate === 'allowed' && (x.side === 'buy' || x.side === 'sell'));
  return o ? { kind: 'entry', side: o.side === 'buy' ? 'long' : 'short' } : { kind: 'pass', side: null };
}

const hasManifest = d => fs.existsSync(path.join(d, 'manifest.json'));
const subdirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(d, e.name)).sort(); } catch (_err) { return []; } };
function replayDirs(target) {
  if (hasManifest(target)) return [target];
  const own = subdirs(path.join(target, 'replay')).filter(hasManifest);
  return own.length ? own : subdirs(target).flatMap(h => subdirs(path.join(h, 'replay')).filter(hasManifest));
}

module.exports = { outcomeWord, kindOf, replayDirs };

'use strict';

/**
 * Phase 2 started at the head trader's OK compose (docs/TOOL-CALLS-AND-ORCHESTRATION.md, "The entry, the second
 * workflow"; workflows/entry): risk-manager phase 2 is a run of its own whose every input (the compose record, the
 * desk's reports, the cycle's bars file) exists once compose_check says OK, so the runner starts it then, while the
 * head trader finishes its run, instead of after. The roles and every approval are the same; only the start is earlier.
 * The run counts only when the entry adopts it (runner-entry.js runEntry): the head trader ended `planned` on that
 * very record and the request the entry builds then is this run's byte for byte. Anything else drops it: stopped, never
 * written to the cycle's role record (so the order gate never sees it), no order from it.
 *
 *   createOverlap({ latest, request, start, pollMs, wallNow, timers, log }) -> handle
 *     latest()            the key of the latest OK compose record on the cycle's bar, or null (none, or the latest isn't
 *                         OK); a read that throws changes nothing this poll
 *     request(key)        -> Promise<{ request, snapshot } | null>: the phase-2 request the entry would build on that
 *                         record now, and the snapshot of what it judges (runner-entry.js entrySnapshot: the record's
 *                         id, bar, side and size, the briefing's as-of time, the bars file's hash), or null
 *     start(request, signal, meta) -> Promise<the role's run result>: the run (the entry engine's), stopped when
 *                         `signal` aborts
 *     blocked() -> why | null   (optional) a reason no run may start now (runner-entry.js: the kill switch is on):
 *                         the running one is dropped (discarded, the reason said) and nothing starts; a check that
 *                         throws blocks (fails closed)
 *     prepare() -> meta, onDrop(meta)   (optional) what a run carries of its own (runner-entry.js: its verdict stage),
 *                         made before its request is built, given to request and start, and dropped with the run (or
 *                         when no run starts on it); an adopted run's meta is the adopter's (take's `meta`)
 *     pollMs              how often latest() is read while the head trader's run goes (config/runner.json entry.overlapPollMs)
 *   handle.halt()         no more polls (the head trader's run ended); a poll in flight starts nothing after it
 *   handle.take(key, request, snapshot)   the run started on exactly this key, request and snapshot, still running or
 *                         done: { start, end(), promise } (marked adopted), or { run: null, why } (none: the entry runs
 *                         phase 2 itself); a run on the key whose request or snapshot differs is dropped (discarded,
 *                         the differing part said)
 *   handle.finish(why)    halt, then every run not adopted is stopped and recorded discarded with `why`; the summary
 *   handle.summary()      [{ record, outcome: running | adopted | superseded | discarded, why?, ms }]
 * A key changing (the head trader composed again, or its latest record is not OK) drops the running one (superseded) and
 * starts one on the new record. At most one run is current; a dropped one is stopped (its signal aborted).
 */

function createOverlap({ latest, request, start, pollMs, prepare = () => null, onDrop = () => {}, blocked = () => false, wallNow = Date.now, timers = { setInterval, clearInterval }, log = () => {} } = {}) {
  if (typeof latest !== 'function' || typeof request !== 'function' || typeof start !== 'function') throw new TypeError('entry-overlap: latest, request and start are required');
  if (!Number.isInteger(pollMs) || pollMs < 1) throw new TypeError('entry-overlap: pollMs must be a whole number >= 1');
  const runs = [];
  let current = null;
  let halted = false;
  let busy = false;

  const drop = (run, outcome, why) => {
    if (!run || run.outcome !== 'running') return;
    run.outcome = outcome;
    run.why = why;
    try { run.controller.abort(); } catch (_err) { /* stopped already */ }
    try { onDrop(run.meta); } catch (_err) { /* best effort */ }
    if (current === run) current = null;
  };

  const begin = (key, req, meta) => {
    const controller = new AbortController();
    const run = { key, meta, request: req.request, snapshot: JSON.stringify(req.snapshot === undefined ? null : req.snapshot), start: wallNow(), end: null, controller, outcome: 'running', why: null };
    // The run's own promise, as the entry engine's run returns it (a rejection is the engine's to read as a failed run);
    // its end is set first, before any awaiter reads it.
    run.promise = Promise.resolve().then(() => start(run.request, controller.signal, meta));
    run.promise.then(() => { run.end = wallNow(); }, () => { run.end = wallNow(); });
    runs.push(run);
    current = run;
    log(`phase 2 started at the compose on record ${key}`);
  };

  const tick = async () => {
    if (halted || busy) return;
    busy = true;
    try {
      let stopWhy;
      try { stopWhy = blocked(); } catch (err) { stopWhy = `the start check failed (${err.message})`; }
      if (stopWhy) { if (current) drop(current, 'discarded', String(stopWhy)); return; }
      let key;
      try { key = latest(); } catch (err) { log(`phase 2 at the compose: the compose records can't be read (${err.message})`); return; }
      if (halted) return;
      if (current && current.key === key) return;
      if (current) drop(current, 'superseded', key ? `the head trader composed again (record ${key})` : 'the latest compose record is not OK');
      if (!key) return;
      let meta = null;
      try { meta = prepare(); } catch (err) { log(`phase 2 at the compose: it can't be prepared (${err.message})`); return; }
      let req = null;
      try { req = await request(key, meta); } catch (err) { log(`phase 2 at the compose: its request can't be built (${err.message})`); req = null; }
      // The head trader's run may have ended, or composed again, while the request was built: start nothing then.
      let again = null;
      try { again = latest(); } catch (_err) { again = null; }
      let late;
      try { late = blocked(); } catch (err) { late = `the start check failed (${err.message})`; }
      if (late || halted || !req || typeof req.request !== 'string' || !req.request || again !== key) {
        try { onDrop(meta); } catch (_err) { /* best effort */ }
        return;
      }
      begin(key, req, meta);
    } finally {
      busy = false;
    }
  };

  const timer = timers.setInterval(() => { tick().catch(() => {}); }, pollMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  const halt = () => {
    if (halted) return;
    halted = true;
    timers.clearInterval(timer);
  };

  const take = (key, req, snapshot) => {
    const run = runs.find(r => r.outcome === 'running' && r.key === key);
    if (!run) return { run: null, why: runs.length ? `no phase 2 running on record ${key}` : 'none started' };
    const was = JSON.parse(run.snapshot);
    const now = snapshot === undefined ? null : snapshot;
    const changed = was && now && typeof was === 'object' && typeof now === 'object'
      ? [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(k => JSON.stringify(was[k]) !== JSON.stringify(now[k])) : (JSON.stringify(was) === JSON.stringify(now) ? [] : ['snapshot']);
    if (changed.length) {
      drop(run, 'discarded', `what it judged changed since it started (${changed.join(', ')})`);
      return { run: null, why: run.why };
    }
    if (run.request !== req) {
      drop(run, 'discarded', 'its request is not the one the entry builds now (the record, the reports, the lookups or the size changed)');
      return { run: null, why: run.why };
    }
    run.outcome = 'adopted';
    return { run: { start: run.start, end: () => run.end, promise: run.promise, meta: run.meta } };
  };

  const summary = () => runs.map(r => ({ record: r.key, outcome: r.outcome, ...(r.why ? { why: r.why } : {}), ms: r.end !== null ? Math.max(0, r.end - r.start) : null }));

  const finish = why => {
    halt();
    for (const r of runs) drop(r, 'discarded', String(why || 'not adopted'));
    return summary();
  };

  return { halt, take, finish, summary, tick };
}

module.exports = { createOverlap };

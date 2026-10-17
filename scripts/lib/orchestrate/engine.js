'use strict';

/**
 * The orchestration engine (docs/TOOL-CALLS-AND-ORCHESTRATION.md, "The orchestration layer"): code runs a multi-role
 * step, after the DeepSeek harness's workflow engine. The model never decides whether a role runs.
 *
 *   createRun({ engine, signal, now, onEvent })   one run's primitives:
 *     agent(role, request, { retries, timeoutMs, accept, meta })  one role's run, as an envelope that never rejects:
 *         { ok, role, text, tools, attempts, ms, stop, why, output, transcript, meta }, `stop` one of completed (it ran and
 *         passed every acceptance check), invalid (it ran, a check failed), failed, timed_out, cancelled. A run that
 *         isn't `completed` is tried again up to `retries` times (never once cancelled).
 *     parallel(tasks, { concurrency })   the tasks (functions returning a promise), at most `concurrency` at once; the
 *         results in the tasks' order; a task that throws is misuse and rejects (a role's failure never throws).
 *     phase(name), log(text)             named steps and notes, as events
 *   engine.run(role, request, { signal, timeoutMs }) -> { ok, timedOut, text, tools, output, transcript }   the harness
 *       run: `text` its final message, `tools` the tools its run completed (the engine adapter reads them from its
 *       harness's own output; the
 *       caller's: `opencode run --agent <role>` for opencode); nothing here names a harness.
 *   accept: [(role, envelope) -> null | why]   the checks a result must pass (orchestrate/checks.js)
 *   onEvent({ type, seq, phase, role, ... })   agent-start / agent-end / phase / log, paired by `seq`
 * Misuse is loud: no engine, a role or request that isn't a string, a bad option: a TypeError.
 */

const STOPS = Object.freeze(['completed', 'invalid', 'failed', 'timed_out', 'cancelled']);

function nonNegInt(x, name) {
  if (!Number.isInteger(x) || x < 0) throw new TypeError(`orchestrate: ${name} must be a whole number >= 0`);
  return x;
}

function createRun({ engine, signal = null, now = () => Date.now(), onEvent = () => {} } = {}) {
  if (!engine || typeof engine.run !== 'function') throw new TypeError('orchestrate: an engine with run(role, request, opts) is required');
  let seq = 0;
  let current = null;
  const emit = e => { try { onEvent(e); } catch (_err) { /* an observer never breaks a run */ } };
  const cancelled = () => Boolean(signal && signal.aborted);

  async function agent(role, request, { retries = 0, timeoutMs = null, accept = [], meta = {} } = {}) {
    if (typeof role !== 'string' || !role) throw new TypeError('orchestrate: agent(role) needs a role name');
    if (typeof request !== 'string' || !request) throw new TypeError(`orchestrate: agent(${role}) needs a request`);
    nonNegInt(retries, 'retries');
    if (!Array.isArray(accept) || accept.some(c => typeof c !== 'function')) throw new TypeError('orchestrate: accept must be a list of checks');
    const id = (seq += 1);
    const started = now();
    emit({ type: 'agent-start', seq: id, phase: current, role });
    let last = { stop: 'failed', why: 'not run', output: '', transcript: null, text: '', tools: [] };
    let attempts = 0;
    for (let tries = 0; tries <= retries; tries += 1) {
      if (cancelled()) { last = { ...last, stop: 'cancelled', why: 'the run was cancelled' }; break; }
      attempts += 1;
      let res;
      try {
        res = await engine.run(role, request, { signal, timeoutMs });
      } catch (err) {
        last = { stop: 'failed', why: `the run failed (${err && err.message ? err.message : err})`, output: '', transcript: null, text: '', tools: [] };
        continue;
      }
      const base = { output: (res && res.output) || '', transcript: (res && res.transcript) || null, text: (res && typeof res.text === 'string' ? res.text : ''), tools: Array.isArray(res && res.tools) ? res.tools.filter(t => typeof t === 'string') : [] };
      if (cancelled()) { last = { ...base, stop: 'cancelled', why: 'the run was cancelled' }; break; }
      if (!res || !res.ok) { last = { ...base, stop: res && res.timedOut ? 'timed_out' : 'failed', why: res && res.timedOut ? 'timed out' : 'the run failed' }; continue; }
      const why = accept.map(c => c(role, base)).find(Boolean) || null;
      last = why ? { ...base, stop: 'invalid', why } : { ...base, stop: 'completed', why: null };
      if (!why) break;
    }
    const env = { ok: last.stop === 'completed', role, text: last.text, tools: last.tools, attempts, ms: now() - started, stop: last.stop, why: last.why, output: last.output, transcript: last.transcript, meta };
    emit({ type: 'agent-end', seq: id, phase: current, role, stop: env.stop, attempts, ms: env.ms, why: env.why });
    return env;
  }

  async function parallel(tasks, { concurrency = 1 } = {}) {
    if (!Array.isArray(tasks) || tasks.some(t => typeof t !== 'function')) throw new TypeError('orchestrate: parallel(tasks) takes a list of functions');
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('orchestrate: concurrency must be a whole number >= 1');
    const results = new Array(tasks.length);
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const i = next;
        next += 1;
        results[i] = await tasks[i]();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    return results;
  }

  return {
    agent,
    parallel,
    phase(name) { current = String(name); emit({ type: 'phase', phase: current }); },
    log(text) { emit({ type: 'log', phase: current, text: String(text) }); },
  };
}

module.exports = { STOPS, createRun };

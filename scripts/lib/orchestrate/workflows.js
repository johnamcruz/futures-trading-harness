'use strict';

/**
 * Workflow documents (docs/TOOL-CALLS-AND-ORCHESTRATION.md, "Workflows are documents"): `workflows/<name>/WORKFLOW.md`,
 * whose frontmatter decides a multi-role step, read and validated here, as strategies.js does a strategy, and run by
 * the engine (orchestrate/engine.js).
 *
 *   name: <folder>          description: <text>
 *   phases:                 one or more, run in order
 *     - name: <unique>      parallel: [<agent role>, ...]   request: <REQUESTS name>
 *       accept: [<CHECKS name>, ...]                         retries: <whole number >= 0>
 *       orders: true        (optional) this phase runs the one role that holds order tools: only the last phase, one
 *                           role, `retries: 0` (a retry could send a second entry). Without it no phase runs such a role.
 *
 *   loadWorkflows(root)                  [{ name, file, valid, errors, workflow }]: every document, valid or not
 *   workflowNamed(root, name)            the valid workflow of that name, or null
 *   runWorkflow(workflow, { run, ctx, roles, concurrency, timeoutMs, before })   each phase's roles (only those in
 *       `roles` when given: the ones still to run), at once up to `concurrency` (required: the caller's config), each
 *       with its request and checks: { ok, phases: [{ name, results }], stopped } (`ok`: every phase ran and every
 *       result completed). `before(phase, phases)` (optional, the caller's code between phases): resolves to null (run
 *       it), { ctx } (run it with these added to the ctx: what code built from the phases before), or { stop: why }
 *       (it and every later phase don't run: `stopped` { phase, why }). Never rejects for a role's failure.
 */

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../frontmatter');
const { REQUESTS } = require('./requests');
const { CHECKS } = require('./checks');

const DIR = 'workflows';
const FILE = 'WORKFLOW.md';

/**
 * The roles a workflow may run: every agent but one holding an order tool (broker interface role `order`), unless the
 * phase declares `orders: true` (the entry workflow's last phase: the trade-executor sends the order code built from the
 * head trader's decision and phase 2's approval; the order gate still judges it). Only the last phase may declare it,
 * with one role and no retry, so a workflow places at most one order and nothing runs after it.
 */
const KEYS = Object.freeze(['name', 'description', 'phases']);
const PHASE_KEYS = Object.freeze(['name', 'parallel', 'request', 'accept', 'retries', 'orders']);
function runnableRoles(root) {
  const { TOOLS } = require('../broker/interface');
  const { SERVER_NAME } = require('../broker/config');
  const orders = Object.keys(TOOLS).filter(t => TOOLS[t].role === 'order').map(t => `mcp__${SERVER_NAME}__${t}`);
  let files;
  try {
    files = fs.readdirSync(path.join(root, 'agents')).filter(f => f.endsWith('.md'));
  } catch (_err) {
    return { runnable: [], ordering: [] };
  }
  const runnable = [];
  const ordering = [];
  for (const f of files) {
    const name = path.basename(f, '.md');
    let tools = [];
    try {
      const t = parseFrontmatter(fs.readFileSync(path.join(root, 'agents', f), 'utf8')).data.tools;
      tools = Array.isArray(t) ? t : String(t || '').split(',').map(x => x.trim());
    } catch (_err) { /* unreadable: no tools */ }
    (tools.some(t => orders.includes(t)) ? ordering : runnable).push(name);
  }
  return { runnable, ordering };
}

function validate(data, folder, { runnable, ordering }) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['no frontmatter'];
  for (const k of Object.keys(data)) if (!KEYS.includes(k)) errors.push(`${k}: not a workflow key (${KEYS.join(', ')})`);
  if (data.name !== folder) errors.push(`name "${data.name}" must match its folder "${folder}"`);
  if (typeof data.description !== 'string' || !data.description.trim()) errors.push('description: required');
  if (!Array.isArray(data.phases) || !data.phases.length) return [...errors, 'phases: one or more required'];
  const seen = new Set();
  data.phases.forEach((p, i) => {
    const at = `phases[${i}]`;
    if (!p || typeof p !== 'object') { errors.push(`${at}: not a phase`); return; }
    for (const k of Object.keys(p)) if (!PHASE_KEYS.includes(k)) errors.push(`${at}.${k}: not a phase key (${PHASE_KEYS.join(', ')})`);
    if (typeof p.name !== 'string' || !p.name) errors.push(`${at}.name: required`);
    else if (seen.has(p.name)) errors.push(`${at}.name: "${p.name}" twice`);
    else seen.add(p.name);
    const orders = p.orders === true;
    if (p.orders !== undefined && typeof p.orders !== 'boolean') errors.push(`${at}.orders: true or false`);
    if (orders && i !== data.phases.length - 1) errors.push(`${at}.orders: only the last phase runs the order role (nothing runs after an order)`);
    if (orders && p.retries !== 0) errors.push(`${at}.orders: retries must be 0 (a retry could send a second entry)`);
    if (orders && Array.isArray(p.parallel) && p.parallel.length !== 1) errors.push(`${at}.orders: exactly one role (one order)`);
    if (!Array.isArray(p.parallel) || !p.parallel.length) errors.push(`${at}.parallel: one or more roles`);
    else {
      const twice = p.parallel.filter((r, k) => p.parallel.indexOf(r) !== k);
      if (twice.length) errors.push(`${at}.parallel: ${[...new Set(twice)].join(', ')} twice`);
      for (const r of p.parallel) {
        if (typeof r !== 'string') errors.push(`${at}.parallel: ${JSON.stringify(r)} is not a role name`);
        else if (ordering.includes(r) && !orders) errors.push(`${at}.parallel: "${r}" holds order tools: a workflow runs it only in a last phase that declares orders: true`);
        else if (!ordering.includes(r) && orders) errors.push(`${at}.parallel: "${r}" holds no order tools: an orders phase runs the order role only`);
        else if (!runnable.includes(r) && !ordering.includes(r)) errors.push(`${at}.parallel: "${r}" is no agent (agents/)`);
      }
    }
    if (!Object.prototype.hasOwnProperty.call(REQUESTS, p.request)) errors.push(`${at}.request: one of ${Object.keys(REQUESTS).join(', ')}`);
    if (!Array.isArray(p.accept)) errors.push(`${at}.accept: a list of checks`);
    else for (const c of p.accept) if (!Object.prototype.hasOwnProperty.call(CHECKS, c)) errors.push(`${at}.accept: "${c}" is no check (${Object.keys(CHECKS).join(', ')})`);
    if (!Number.isInteger(p.retries) || p.retries < 0) errors.push(`${at}.retries: a whole number >= 0`);
  });
  return errors;
}

function loadWorkflows(root) {
  let folders;
  try {
    folders = fs.readdirSync(path.join(root, DIR), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  } catch (_err) {
    return [];
  }
  const roles = runnableRoles(root);
  return folders.map(name => {
    const file = path.join(root, DIR, name, FILE);
    let data;
    try {
      data = parseFrontmatter(fs.readFileSync(file, 'utf8')).data;
    } catch (err) {
      return { name, file, valid: false, errors: [`unreadable: ${err.message}`], workflow: null };
    }
    const errors = validate(data, name, roles);
    return { name, file, valid: !errors.length, errors, workflow: errors.length ? null : data };
  });
}

function workflowNamed(root, name) {
  const w = loadWorkflows(root).find(x => x.name === name);
  return w && w.valid ? w.workflow : null;
}

async function runWorkflow(workflow, { run, ctx: ctx0 = {}, roles = null, concurrency, timeoutMs = null, before = null } = {}) {
  if (!workflow || !Array.isArray(workflow.phases)) throw new TypeError('orchestrate: runWorkflow needs a valid workflow');
  if (!run || typeof run.agent !== 'function') throw new TypeError('orchestrate: runWorkflow needs a run (engine.createRun)');
  if (before !== null && typeof before !== 'function') throw new TypeError('orchestrate: before must be a function');
  const phases = [];
  let ctx = ctx0;
  let stopped = null;
  for (const p of workflow.phases) {
    // The caller's code between phases: what it built from the phases before, or why the rest doesn't run.
    const gate = before ? await before(p, phases) : null;
    if (gate && typeof gate.stop === 'string') { stopped = { phase: p.name, why: gate.stop }; break; }
    if (gate && gate.ctx && typeof gate.ctx === 'object') ctx = { ...ctx, ...gate.ctx };
    run.phase(p.name);
    const todo = roles ? p.parallel.filter(r => roles.includes(r)) : p.parallel;
    // Each check reads the workflow's ctx too (the lookups the bar requires of each role).
    const at = ctx;
    const accept = p.accept.map(c => (role, r) => CHECKS[c](role, r, at));
    const results = await run.parallel(todo.map(role => () => run.agent(role, REQUESTS[p.request](role, at), { retries: p.retries, timeoutMs, accept, meta: { phase: p.name } })), { concurrency });
    phases.push({ name: p.name, results });
  }
  return { ok: !stopped && phases.every(p => p.results.every(r => r.ok)), phases, stopped };
}

module.exports = { DIR, FILE, loadWorkflows, workflowNamed, runWorkflow };

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
 *
 *   loadWorkflows(root)                  [{ name, file, valid, errors, workflow }]: every document, valid or not
 *   workflowNamed(root, name)            the valid workflow of that name, or null
 *   runWorkflow(workflow, { run, ctx, roles, concurrency, timeoutMs })   each phase's roles (only those in `roles`
 *       when given: the ones still to run), at once up to `concurrency`, each with its request and checks:
 *       { ok, phases: [{ name, results }] } (`ok`: every result completed). Never rejects for a role's failure.
 */

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../frontmatter');
const { REQUESTS } = require('./requests');
const { CHECKS } = require('./checks');

const DIR = 'workflows';
const FILE = 'WORKFLOW.md';

const agentNames = root => {
  try {
    return fs.readdirSync(path.join(root, 'agents')).filter(f => f.endsWith('.md')).map(f => path.basename(f, '.md'));
  } catch (_err) {
    return [];
  }
};

function validate(data, folder, roles) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['no frontmatter'];
  if (data.name !== folder) errors.push(`name "${data.name}" must match its folder "${folder}"`);
  if (typeof data.description !== 'string' || !data.description.trim()) errors.push('description: required');
  if (!Array.isArray(data.phases) || !data.phases.length) return [...errors, 'phases: one or more required'];
  const seen = new Set();
  data.phases.forEach((p, i) => {
    const at = `phases[${i}]`;
    if (!p || typeof p !== 'object') { errors.push(`${at}: not a phase`); return; }
    if (typeof p.name !== 'string' || !p.name) errors.push(`${at}.name: required`);
    else if (seen.has(p.name)) errors.push(`${at}.name: "${p.name}" twice`);
    else seen.add(p.name);
    if (!Array.isArray(p.parallel) || !p.parallel.length) errors.push(`${at}.parallel: one or more roles`);
    else for (const r of p.parallel) if (!roles.includes(r)) errors.push(`${at}.parallel: "${r}" is no agent (agents/)`);
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
  const roles = agentNames(root);
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

async function runWorkflow(workflow, { run, ctx = {}, roles = null, concurrency = 1, timeoutMs = null } = {}) {
  if (!workflow || !Array.isArray(workflow.phases)) throw new TypeError('orchestrate: runWorkflow needs a valid workflow');
  if (!run || typeof run.agent !== 'function') throw new TypeError('orchestrate: runWorkflow needs a run (engine.createRun)');
  const phases = [];
  for (const p of workflow.phases) {
    run.phase(p.name);
    const todo = roles ? p.parallel.filter(r => roles.includes(r)) : p.parallel;
    const accept = p.accept.map(c => CHECKS[c]);
    const results = await run.parallel(todo.map(role => () => run.agent(role, REQUESTS[p.request](role, ctx), { retries: p.retries, timeoutMs, accept, meta: { phase: p.name } })), { concurrency });
    phases.push({ name: p.name, results });
  }
  return { ok: phases.every(p => p.results.every(r => r.ok)), phases };
}

module.exports = { DIR, FILE, loadWorkflows, workflowNamed, runWorkflow };

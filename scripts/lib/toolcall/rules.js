'use strict';

/**
 * The tool-call layer's rules (docs/TOOL-CALLS-AND-ORCHESTRATION.md, "Rules are hooks"), one registry. A rule is
 *   { id, event: 'pre' | 'post', failClosed, match(call), check(call, ctx) -> outcome }
 * on a call { tool (canonical: names.js), name (the harness's own), args, session, id } and, after it ran, its
 * result { text }. An outcome is null (nothing to say), { repair: true } (it changed call.args in place),
 * { refuse: text } (the call doesn't run; the text names the route) or { note: text } (advice after a result).
 * ctx: { state (this rule's, this session's: call-log.js), env, now(), native(canonical) (the name the model calls),
 * result }. Rules that share a state name it in `state`.
 *
 * Invariants (tests/lib/toolcall.test.js): a rule that can refuse never matches an order or exit tool (the broker
 * interface's `order` tools); only a rule that holds an entry's step declares failClosed (a throw refuses).
 */

const { BROKER_SERVER, HARNESS_SERVER } = require('./names');

const DENIED_ROLES_ENV = 'FTH_DENIED_ROLES';
/** The roles a run may not launch (FTH_DENIED_ROLES, comma-separated): a list. */
const deniedRolesOf = env => String((env && env[DENIED_ROLES_ENV]) || '').split(',').map(r => r.trim()).filter(Boolean);
/** A task_id that is an opencode session id (a resume); any other is the model's own label. */
const SESSION_ID = /^ses/;
const canon = v => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);

/**
 * task-id: a `task_id` that names no session is dropped, so the role starts a fresh session, as a first launch does.
 * opencode reads task_id as a session to resume and fails the whole call on one that names none; a model inventing
 * a label for its call ("msa", "rm1") lost the role that cycle (the PPC run of 2026-10-16). A real session id stays.
 */
const taskId = {
  id: 'task-id', event: 'pre', failClosed: false,
  match: call => call.tool === 'task',
  check(call) {
    const a = call.args;
    if (!a || typeof a !== 'object' || !('task_id' in a)) return null;
    if (typeof a.task_id === 'string' && SESSION_ID.test(a.task_id)) return null;
    delete a.task_id;
    return { repair: true };
  },
};

/**
 * denied-role: a role launch the run denies (FTH_DENIED_ROLES: a cached role, one off the desk, or one that reaches
 * the web in a replay) is refused with the same text every cycle, so the task tool's description, and with it the
 * head trader's prompt, stays the same from cycle to cycle (a changing task permission broke the prompt cache).
 */
const deniedRole = {
  id: 'denied-role', event: 'pre', failClosed: false,
  match: call => call.tool === 'task',
  check(call, { env }) {
    const a = call.args;
    if (!a || typeof a !== 'object') return null;
    const role = String(a.subagent_type || '').trim();
    if (!role || !deniedRolesOf(env).includes(role)) return null;
    return { refuse: `[denied-role] ${role} is not launched this cycle (the cycle prompt gives its cached report, the role is off the desk, or it reaches the web, which a replay never does): don't call it again; go on with the reports you have.` };
  },
};

/**
 * tool-name: a call to an unknown name (opencode sends it to its `invalid` tool) whose bare form, or a server form, is
 * a harness or broker tool is answered with the name meant (`compose_check` -> the harness's compose_check): the
 * route, so the model corrects itself instead of reading a list of every tool.
 */
const toolName = {
  id: 'tool-name', event: 'pre', failClosed: false,
  match: call => call.tool === 'invalid',
  check(call, { native }) {
    const a = call.args;
    if (!a || typeof a !== 'object' || typeof a.tool !== 'string') return null;
    const given = a.tool.trim();
    const bare = given.replace(/^mcp__[a-z0-9-]+__/, '').replace(new RegExp(`^(${HARNESS_SERVER}|${BROKER_SERVER})[_.]`), '');
    const { BY_NAME } = require('../harness-tools/registry');
    const { TOOLS } = require('../broker/interface');
    const canonical = BY_NAME.has(bare) ? `${HARNESS_SERVER}.${bare}` : (Object.prototype.hasOwnProperty.call(TOOLS, bare) ? `${BROKER_SERVER}.${bare}` : null);
    const name = canonical ? native(canonical) : null;
    if (!name || name === given) return null;
    return { refuse: `[tool-name] "${given}" is not a tool here: call ${name} with the same arguments.` };
  },
};

/**
 * desk: the head trader composes a trade (compose_check) only once every role this cycle must launch (FTH_CYCLE_DESK:
 * trading/desk-check.js expectedRoles, less any the run denies) has reported to it, a launch that returned in its
 * session (desk-reported). With the runner's desk (runner-wiring.js deskFor) nothing is left for it to wait for: a
 * backstop. Only compose_check is held (only the head trader holds it): never an exit, a stop, an order or a read.
 */
const deskWait = {
  id: 'desk', event: 'pre', failClosed: true, state: 'desk',
  match: call => call.tool === `${HARNESS_SERVER}.compose_check`,
  check(call, { state, env }) {
    const denied = deniedRolesOf(env);
    const desk = String((env && env.FTH_CYCLE_DESK) || '').split(',').map(r => r.trim()).filter(r => r && !denied.includes(r));
    if (!desk.length) return null;
    const got = state.reported || [];
    const missing = desk.filter(r => !got.includes(r));
    if (!missing.length) return null;
    return { refuse: `[desk] compose_check composes the trade from the desk's reports: launch ${missing.join(', ')} first, as parallel subagents (the cycle's roster), then compose from their reports. No entry goes without them (the order gate refuses it).` };
  },
};
const deskReported = {
  id: 'desk-reported', event: 'post', failClosed: false, state: 'desk',
  match: call => call.tool === 'task',
  check(call, { state }) {
    const a = call.args;
    if (!a || typeof a.subagent_type !== 'string') return null;
    state.reported = [...new Set([...(state.reported || []), a.subagent_type.trim()])];
    return null;
  },
};

/**
 * repeat (after the DeepSeek harness's repeat-tool-reminder): the same tool with the same arguments again and again,
 * per session. Once an identical call failed (it never returned: opencode's MCP wrapper throws on an isError result,
 * so the after hook never runs) and started more than limits.repeatSameStepMs ago (identical calls sent in one step
 * are still running, not failed), every repeat from the first count in limits.repeatReminderAt is refused with the
 * reminder. A success gets the reminder after its result, at each count, only when its answer is the last identical
 * call's (a poll whose answer moves is never nudged). Never a broker tool (its answers move while an exit fills; an
 * exit or a stop is never refused), never a role launch, never opencode's invalid tool.
 */
const repeatExempt = call => call.tool === 'task' || call.tool === 'invalid' || call.tool.startsWith(`${BROKER_SERVER}.`);
const remind = (call, n, first) => (n === first
  ? 'You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try different arguments or a different approach, or finish with what you have.'
  : `You have called ${call.name} ${n} times in a row with the same arguments. It will not change: use a different approach or arguments, or finish your report now with what you have.`);
const limits = () => require('../tunables').runner().limits;
const repeat = {
  id: 'repeat', event: 'pre', failClosed: false, state: 'repeat',
  match: call => !repeatExempt(call),
  check(call, { state, now }) {
    const { repeatReminderAt: at, repeatSameStepMs: sameStepMs } = limits();
    const first = Math.min(...at);
    const sig = `${call.tool} ${JSON.stringify(canon(call.args || {}))}`;
    if (state.sig !== sig) state.text = undefined;
    state.n = state.sig === sig ? (state.n || 0) + 1 : 1;
    state.sig = sig;
    const t = now();
    const calls = state.calls || [];
    const failed = calls.some(c => c.sig === sig && !c.returned && t - c.at > sameStepMs);
    state.calls = [...calls.filter(c => c.sig === sig).slice(-Math.max(...at)), { id: call.id === null || call.id === undefined ? null : String(call.id), sig, at: t, returned: false }];
    return failed && state.n >= first ? { refuse: `[repeat] ${remind(call, state.n, first)}` } : null;
  },
};
const repeatNote = {
  id: 'repeat-note', event: 'post', failClosed: false, state: 'repeat',
  match: call => !repeatExempt(call),
  check(call, { state, result }) {
    if (!state.calls) return null;
    const { repeatReminderAt: at } = limits();
    const id = call.id === null || call.id === undefined ? null : String(call.id);
    const c = [...state.calls].reverse().find(x => !x.returned && (id === null || x.id === null || x.id === id));
    if (c) c.returned = true;
    const text = result && typeof result.text === 'string' ? result.text : undefined;
    const same = typeof text === 'string' && state.text === text;
    if (typeof text === 'string') state.text = text;
    return same && at.includes(state.n) ? { note: `[repeat] ${remind(call, state.n, Math.min(...at))}` } : null;
  },
};

const RULES = Object.freeze([taskId, deniedRole, toolName, deskWait, deskReported, repeat, repeatNote]);

module.exports = { RULES, DENIED_ROLES_ENV, deniedRolesOf };

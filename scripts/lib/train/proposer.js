'use strict';

/**
 * The training loop's proposer (docs/LEARNED-RULEBOOK.md R25 step 2; tier 2 of the owner's tiers): the
 * model the runner config names reviews its own flagged decisions and proposes small edits to the
 * documents it trades with. LLM-agnostic: it runs whatever harness CLI the config names, exactly as the
 * runner builds it (autotrader.js buildCommand), never a model by name. The prompt template is a document
 * (skills/design-self-review/SKILL.md, "The prompt"), short enough for a small local model.
 *
 * The proposer proposes; it never judges (paired.js does). It can't trade: its process runs in a scratch
 * harness home with the kill switch on, paper mode, and every live broker's variables disabled.
 *
 * An external model is never called by the loop. Tier 3 is a manual hook: a person may ask any model they
 * choose and hand its reply to `train-loop.js import-proposal <file>` (skills/training-loop).
 *
 *   readTemplate(root)                            the prompt template from the skill
 *   selfReviewPrompt({ template, flagged, files, maxProposals })   the prompt
 *   proposerEnv(base, scratch)                    the proposer's environment
 *   propose({ cfg, tree, flagged, home, baseEnv, maxProposals, run })   { proposals, output, code }: tree is the
 *                                                 proposer's own copy (its working directory), home its scratch home
 *   readProbeTemplate(root), probePrompt({ template, findings, lessons, files, k, controls })   the probe round's prompt (the
 *                                                 skill's "### The probe prompt"; Propose-Probe-Compose, probe.js)
 *   findingsByStep(findings, controls)            the findings grouped by flow step (flow.js), then the trend base rate
 *                                                 and balancing examples, for {{FINDINGS}}
 *   proposeProbes({ cfg, tree, findings, controls, lessons, home, baseEnv, k, run })   up to k tagged skill or role edits, one call
 */

const fs = require('fs');
const path = require('path');
const { buildCommand } = require('../autotrader');
const { runHarness } = require('../harness-run');
const { liveBrokerVars, DISABLED } = require('../replay/config');
const { parseProposals, FAILURES } = require('./proposal');

const SKILL = path.join('skills', 'design-self-review', 'SKILL.md');
const MARKER = 'FTH-SELF-REVIEW';

function readTemplate(root) {
  const text = fs.readFileSync(path.join(root, SKILL), 'utf8');
  const m = /### The prompt\s*\n+```text\n([\s\S]*?)\n```/.exec(text);
  if (!m) throw new Error(`${SKILL}: no "### The prompt" section with a text block`);
  for (const k of ['{{FLAGGED}}', '{{CATEGORIES}}', '{{FILES}}', '{{MAX}}']) if (!m[1].includes(k)) throw new Error(`${SKILL}: the prompt has no ${k}`);
  return m[1];
}

const clip = (s, n) => {
  const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
};

/** One line per flagged decision: what the facts expected, what it did, why the scorecard flagged it, what it said. */
function flaggedLine(d, i) {
  const exp = d.expected ? `${d.expected.decision || '?'}${d.expected.setup ? ` ${d.expected.setup}` : ''}` : '?';
  const act = d.actual ? `${d.actual.action || 'none'}${d.actual.setup ? ` ${d.actual.setup}` : ''}` : '?';
  return `${i + 1}. ${d.day} ${d.et || d.t} ${d.symbol || ''}: ${d.category}. Expected: ${exp}. You did: ${act}.`
    + `${d.why && d.why.length ? ` Why flagged: ${clip(d.why.join('; '), 200)}.` : ''}`
    + `${d.falseReasons && d.falseReasons.length ? ` False reasons: ${clip(d.falseReasons.join('; '), 200)}.` : ''}`
    + `${d.stated ? ` You said: "${clip(d.stated, 200)}"` : ''}`;
}

function selfReviewPrompt({ template, flagged, files, maxProposals }) {
  // Function replacers: a `$&` or `$\`` in a flagged decision's text is never read as a replacement pattern.
  return `${MARKER}\n${template
    .replace('{{FLAGGED}}', () => flagged.map(flaggedLine).join('\n'))
    .replace('{{CATEGORIES}}', () => FAILURES.join(', '))
    .replace('{{FILES}}', () => files.join('\n'))
    .replace('{{MAX}}', () => String(maxProposals))}`;
}

/**
 * The documents a model's proposal may edit in the tree, as the prompt lists them: skills, strategies and the desk
 * roles' bodies (agent-edit.js). Never a rulebook: its numbers are the owner's (proposal.js, by 'person' only).
 */
function editableFiles(tree) {
  const { kindOf } = require('./proposal');
  const out = [];
  for (const dir of ['skills', 'strategies', 'agents']) {
    let names;
    try { names = fs.readdirSync(path.join(tree, dir)).sort(); } catch (_err) { continue; }
    for (const n of names) {
      const rel = dir === 'agents' ? `agents/${n}` : `${dir}/${n}/${dir === 'skills' ? 'SKILL' : 'STRATEGY'}.md`;
      if (kindOf(rel) && fs.existsSync(path.join(tree, rel))) out.push(rel);
    }
  }
  return out;
}

/** The proposer's environment: a scratch home, the kill switch on, paper mode, every live broker disabled. */
function proposerEnv(base, scratch) {
  const env = { ...base };
  for (const v of liveBrokerVars(base)) env[v] = DISABLED;
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const stop = path.join(scratch, 'STOP');
  fs.writeFileSync(stop, 'training-loop proposer: proposes document edits only, never trades\n');
  Object.assign(env, {
    FTH_HOME: scratch, FTH_KILL_SWITCH_FILE: stop, FTH_PAPER: '1', FTH_GATE_LOG: path.join(scratch, 'gate-log.jsonl'),
    FTH_ENV_FILE: path.join(scratch, '.env'),
  });
  fs.writeFileSync(env.FTH_ENV_FILE, '', { flag: 'a', mode: 0o600 });
  return env;
}

/**
 * The probe round's prompt (Propose-Probe-Compose): the skill's "### The probe prompt" section, with the findings
 * (findings.js), the lessons record's capped summary (lessons.js), the skills it may edit and k.
 */
function readProbeTemplate(root) {
  const text = fs.readFileSync(path.join(root, SKILL), 'utf8');
  const m = /### The probe prompt\n[^#]*?```text\n([\s\S]*?)\n```/.exec(text);
  if (!m) throw new Error(`${SKILL}: no "### The probe prompt" section with a text block`);
  for (const k of ['{{FLOW}}', '{{FINDINGS}}', '{{LESSONS}}', '{{FILES}}', '{{CATEGORIES}}', '{{KINDS}}', '{{K}}']) if (!m[1].includes(k)) throw new Error(`${SKILL}: the probe prompt has no ${k}`);
  return m[1];
}

/**
 * The findings grouped by the flow step they block (flow.js byStep), in flow order; each keeps its rank's id. controls:
 * the trend findings' base rate and balancing examples (trend-facts.js controlsText), after them.
 */
function findingsByStep(findings, controls = '') {
  const { findingLine } = require('./findings');
  const { byStep } = require('./flow');
  const text = byStep(findings).map(g => `${g.step ? `Step ${g.step}:` : 'No step (no read at the bar):'}\n${g.findings.map(findingLine).join('\n')}`).join('\n\n');
  return controls ? `${text}\n\n${controls}` : text;
}

function probePrompt({ template, findings, lessons, files, k, controls = '' }) {
  const { KINDS } = require('./probe-edit');
  const { flowLine } = require('./flow');
  // Function replacers: a `$&` or `$\`` in a finding, an example or a lesson is never read as a replacement pattern.
  return `${MARKER}\n${template
    .replace('{{FLOW}}', () => flowLine())
    .replace('{{FINDINGS}}', () => findingsByStep(findings, controls))
    .replace('{{LESSONS}}', () => lessons || 'none yet')
    .replace('{{FILES}}', () => files.join('\n'))
    .replace('{{CATEGORIES}}', () => FAILURES.join(', '))
    .replace('{{KINDS}}', () => KINDS.join(', '))
    .replace('{{K}}', () => String(k))}`;
}

/**
 * Up to k tagged skill edits (probe-edit.js): { proposals: [{ proposal, tag } | { error, line }], output, code, prompt }.
 * One model call. The proposer proposes; the probe screen (screen.js) and the keep rule judge.
 */
async function proposeProbes({ cfg, tree, findings, lessons, home, baseEnv = process.env, k = 4, run = runHarness, controls = '' }) {
  const { splitTagged } = require('./probe-edit');
  const prompt = probePrompt({ template: readProbeTemplate(tree), findings, controls, lessons, files: editableFiles(tree).filter(f => f.startsWith('skills/') || f.startsWith('agents/')), k });
  const env = proposerEnv(baseEnv, home);
  const argv = buildCommand(cfg, prompt, tree, env);
  const res = await run(argv, { cwd: tree, env, timeoutMs: (cfg.cycleTimeoutMinutes || 10) * 60000 });
  fs.writeFileSync(path.join(home, 'output.txt'), String(res.output || ''));
  const found = parseProposals(res.output).filter(x => !prompt.includes(x.raw)).slice(0, k);
  return { proposals: found.map(x => (x.error ? x : splitTagged(x.proposal))), output: String(res.output || ''), code: res.code, prompt };
}

async function propose({ cfg, tree, flagged, home, baseEnv = process.env, maxProposals = 2, run = runHarness }) {
  const prompt = selfReviewPrompt({ template: readTemplate(tree), flagged, files: editableFiles(tree), maxProposals });
  const env = proposerEnv(baseEnv, home);
  const argv = buildCommand(cfg, prompt, tree, env);
  const timeoutMs = (cfg.cycleTimeoutMinutes || 10) * 60000;
  const res = await run(argv, { cwd: tree, env, timeoutMs });
  fs.writeFileSync(path.join(home, 'output.txt'), String(res.output || ''));
  // A line the prompt itself holds (its example, a transcript that echoes the prompt) is no proposal.
  return { proposals: parseProposals(res.output).filter(x => !prompt.includes(x.raw)).slice(0, maxProposals), output: String(res.output || ''), code: res.code, prompt };
}

module.exports = { MARKER, SKILL, readTemplate, selfReviewPrompt, editableFiles, proposerEnv, propose, flaggedLine, readProbeTemplate, probePrompt, findingsByStep, proposeProbes };

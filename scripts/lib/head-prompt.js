'use strict';

/**
 * The head trader's own prompt in opencode's index mode (role-skills.js, the default), and the runner's attestation
 * of it that the order gate checks.
 *
 * Without a prompt the head trader (opencode.js HEAD_AGENT) reads opencode's default prompt, the workspace
 * instructions (AGENTS.md) and, while it may use the skill tool, opencode's listing of every skill, then loads its
 * per-cycle skills one tool turn each, after the cycle's prompt, where no prompt cache reaches. In index mode its
 * prompt embeds those skills (CORE: the order gate's REQUIRED_FOR_COMPOSED and REQUIRED_AT_ENTRY, the others it reads
 * every cycle, and the reads the gate requires on a composed bar), the same text a load returns, as part of its fixed prefix; any other skill it reads whole with the
 * harness tool skill_lookup (the Skills list of AGENTS.md is its index), and opencode's skill tool is denied it
 * (opencode.js sessionPermission). Full mode, and every other harness, stay as before: the skills are loaded.
 *
 * The order gate counts an embedded skill as loaded only on the runner's attestation (FTH_HEAD_PROMPT, which the
 * runner sets for an opencode run in index mode only), checked whole when an entry is judged: the run's opencode.json
 * still holds the head prompt the runner hashed at launch, and that prompt holds each named skill's current text in
 * full. Anything else (no attestation, another harness, a hook's transcript, a transcript that isn't opencode's, a
 * file changed or unreadable, a skill edited since): no embedded skill counts, so the transcript decides as before.
 *
 *   CORE                          the skills embedded, in prompt order
 *   COMPOSED_READS                the composed bar's reads among them (SITUATIONAL entries taught in trade-lifecycle)
 *   ATTEST_ENV                    'FTH_HEAD_PROMPT'
 *   headPlan(root, mode)          { docs: [{ name, body }] } in index mode, null in full mode
 *   headPrompt(plan)              the prompt's text
 *   embeddedSkills(prompt, root)  the skills whose current text the prompt embeds whole
 *   attestation(configFile, root) { config, sha256, skills } for the runner, or null (no head prompt, or no skill embedded)
 *   parseAttestation(text)        the env value as { config, sha256, skills }, or null
 *   attestedSkills(att, root, { transcript })   the skills the gate may count as loaded: [] unless everything checks
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./frontmatter');
const { isOpencodeEvent } = require('./transcript');
const { REQUIRED_FOR_COMPOSED, REQUIRED_AT_ENTRY, SITUATIONAL, parseTrigger, describeTrigger } = require('./trading/skills-loaded');

const HEAD_AGENT = 'fth-head-trader';
const ATTEST_ENV = 'FTH_HEAD_PROMPT';
/** The prompt's first sentence: how a config's head trader is seen to have this prompt (preflight.js roleSkillsMismatch). */
const HEAD_MARK = 'You are the head trader of the futures trading harness.';
/*
 * The skills the head trader reads every cycle (trade-session step 0, the runner's load list) and before a decision or
 * an entry (steps 2 to 4): the gate's lists come first, so none can be left out.
 */
// trade_lifecycle is the one entry strategy: the composed entry's list (REQUIRED_FOR_COMPOSED: trade-lifecycle in place
// of strategy-library, strategy-scan and strategy-gate-checks). A rules strategy's entry (a user's or a fixture's) still
// needs those three, read with skill_lookup (the gate requires them for it).
// Last, the composed bar's own reads (SITUATIONAL entries taught in trade-lifecycle: confluence-counting, invalidation,
// rejection, breakout), which the gate requires on every composed bar: embedded, they cost no lookup turn per bar (the
// owner's exception to the prompt's no-growth rule, about 13 KB).
const COMPOSED_READS = SITUATIONAL.filter(e => e.taughtIn).map(e => e.skill);
const CORE = [...new Set([
  ...REQUIRED_FOR_COMPOSED, ...REQUIRED_AT_ENTRY,
  'autonomous-trading', 'trader-process', 'htf-to-ltf', 'bar-briefing', 'role-round', 'day-context',
  ...COMPOSED_READS,
])];
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const SHA = /^[0-9a-f]{64}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

const skillBody = (root, name) => parseFrontmatter(fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8')).body.trim();
const block = (name, body) => `<skill name="${name}">\n${body}\n</skill>`;
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const andList = names => {
  const q = names.map(n => `\`${n}\``);
  return q.length < 3 ? q.join(' and ') : `${q.slice(0, -1).join(', ')}, and ${q[q.length - 1]}`;
};

/** The head trader's embedded skills in index mode ({ docs }); null in full mode (it loads them, as before). */
function headPlan(root, mode) {
  if (mode !== 'index') return null;
  return { docs: CORE.map(name => ({ name, body: skillBody(root, name) })) };
}

/** The situational skills the head trader must read when the bar shows them (SITUATIONAL entries marked head). */
// An entry taught in a skill (`taughtIn`: trade-lifecycle) is named there and embedded below (CORE), not listed here.
const listed = e => e.head === true && !e.taughtIn;
const headRequired = (table = SITUATIONAL) => [...new Set(table.filter(listed).map(e => e.skill))]
  .map(skill => ({ skill, when: table.filter(e => listed(e) && e.skill === skill).map(e => parseTrigger(e.when)) }));

function headPrompt(plan, table = SITUATIONAL) {
  const names = plan.docs.map(d => d.name);
  const out = [
    `${HEAD_MARK} Your instructions are the workspace instructions (AGENTS.md, after this prompt): its rules always apply, and it lists the agent roles you delegate to.`,
    '',
    `Your skills ${andList(names)} are below, already loaded (Your skills): every cycle reads them. Read them here; don't load them again. They name other skills a step needs (\`manage-position\` for an open position, \`leftover-orders\`, \`lean-cycle\`, \`entry-outcome\`, ...), all in the Skills list of AGENTS.md: read one whole with \`skill_lookup {"skill": "<name>"}\` (no role: that is the roles') only when this cycle needs it. \`skill_lookup {}\` lists every skill. You have no skill tool.`,
    '',
  ];
  const required = headRequired(table);
  if (required.length) {
    out.push('Required by the situation: when this bar\'s briefing shows it, look the skill up before an entry; otherwise the order gate refuses the entry.', '',
      ...required.map(r => `- ${r.when.map(describeTrigger).join(', or ')}: \`${r.skill}\``), '');
  }
  out.push('## Your skills (already loaded)', '',
    `The skills you use every cycle (${names.join(', ')}) are below in full: they are loaded.`, '',
    ...plan.docs.flatMap(d => [block(d.name, d.body), '']));
  return out.join('\n');
}

/** The skills (any of the harness's) whose current text `prompt` embeds whole, as a load would return it. */
function embeddedSkills(prompt, root) {
  if (typeof prompt !== 'string' || !prompt) return [];
  const out = [];
  for (const m of prompt.matchAll(/<skill name="([a-z0-9][a-z0-9-]{0,63})">\n/g)) {
    const name = m[1];
    if (out.includes(name)) continue;
    let body;
    try { body = skillBody(root, name); } catch (_err) { continue; }
    if (prompt.includes(block(name, body))) out.push(name);
  }
  return out;
}

/** The head trader's prompt in an opencode config file, or null (unreadable, too large, not JSON, none). */
function headPromptIn(configFile) {
  try {
    if (!path.isAbsolute(String(configFile)) || path.basename(configFile) !== 'opencode.json') return null;
    if (fs.statSync(configFile).size > MAX_CONFIG_BYTES) return null;
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const head = cfg && cfg.agent && cfg.agent[HEAD_AGENT];
    return head && typeof head.prompt === 'string' && head.prompt ? head.prompt : null;
  } catch (_err) {
    return null;
  }
}

/** What the runner attests for a run in index mode: the run's config file, its head prompt's hash, the skills it embeds. */
function attestation(configFile, root) {
  const prompt = headPromptIn(configFile);
  const skills = embeddedSkills(prompt, root);
  return prompt && skills.length ? { config: configFile, sha256: sha256(prompt), skills } : null;
}

function parseAttestation(text) {
  try {
    const a = JSON.parse(String(text || ''));
    if (!a || typeof a !== 'object' || typeof a.config !== 'string' || !SHA.test(String(a.sha256)) || !Array.isArray(a.skills)) return null;
    if (!a.skills.length || !a.skills.every(s => typeof s === 'string' && NAME.test(s))) return null;
    return { config: a.config, sha256: a.sha256, skills: [...new Set(a.skills)] };
  } catch (_err) {
    return null;
  }
}

/** An opencode `run --format json` stream: its first event is one of opencode's (a session id and a part). */
function isOpencodeTranscript(file) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    text = buf.toString('utf8', 0, n);
  } catch (_err) {
    return false;
  }
  for (const line of text.split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch (_err) { continue; }
    return isOpencodeEvent(ev);
  }
  return false;
}

/**
 * The embedded skills the gate may count as loaded: the attested ones, only when the cycle's transcript is opencode's,
 * the attested config file's head prompt hashes to the attested hash, and that prompt still embeds each one's current
 * text. Anything off: [] (the transcript alone decides).
 */
function attestedSkills(att, root, { transcript } = {}) {
  if (!att || !transcript || !isOpencodeTranscript(transcript)) return [];
  const prompt = headPromptIn(att.config);
  if (!prompt || sha256(prompt) !== att.sha256) return [];
  const embedded = embeddedSkills(prompt, root);
  return att.skills.filter(s => embedded.includes(s));
}

module.exports = { HEAD_AGENT, ATTEST_ENV, HEAD_MARK, CORE, COMPOSED_READS, headPlan, headRequired, headPrompt, embeddedSkills, headPromptIn, attestation, parseAttestation, isOpencodeTranscript, attestedSkills, sha256 };

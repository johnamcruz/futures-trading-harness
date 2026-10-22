'use strict';

/**
 * The head trader's own prompt in opencode's index mode (role-skills.js, the default), and the runner's attestation
 * of it that the order gate checks.
 *
 * Without a prompt the head trader (opencode.js HEAD_AGENT) reads opencode's default prompt, the workspace
 * instructions (AGENTS.md) and, while it may use the skill tool, opencode's listing of every skill, then loads its
 * per-cycle skills one tool turn each, after the cycle's prompt, where no prompt cache reaches. In index mode its
 * prompt embeds those skills (CORE: the order gate's REQUIRED_FOR_COMPOSED and REQUIRED_AT_ENTRY, the others it
 * reads every cycle, and a composed bar's reads), the same text a load returns, as part of its fixed prefix; any other
 * skill it reads whole with the harness tool skill_lookup (the Skills list of AGENTS.md is its index), and opencode's
 * skill tool is denied it (opencode.js sessionPermission). Full mode, and every other harness, stay as before: the skills are loaded.
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
 *
 * Claude Code's head trader runs the same index mode only where the user's machine opts in (the runner config's
 * headSkillsInPrompt, autotrader.js): CORE embedded and every other skill indexed one line each, read whole with the
 * harness tool skill_lookup, in a file the runner gives it as a system-prompt addition (--append-system-prompt-file, so
 * it sits in the cached prefix, never after the cycle's prompt). The file is the harness home's, named by its text's
 * hash; the runner attests it with the cycle it is for ({ harness: 'claude', config: <file>, sha256, skills, cycle }),
 * and the gate counts its skills (and the head trader's skill_lookup reads, and the situational rules of index mode)
 * only when everything checks at judgment time: the cycle is this process's (check-order.js cycleId), the file still
 * hashes to the attested hash and embeds each skill's current text, and the transcript is a Claude Code run's (a hook's,
 * that run's own session). Anything off: none counts, and the transcript decides as before. Without the key nothing of
 * this runs: the argv, the prompt, the env and the gate are as before.
 *
 *   claudeHeadText(root)          the Claude head trader's prompt addition (index mode)
 *   claudeHeadFile(home, text)    where the runner keeps it: <home>/head-prompt/claude-head-<sha256>.md
 *   writeClaudeHead(home, root)   { file, text }, written when missing or different
 *   claudeAttestation({ file, text, root, cycle })   the runner's attestation of it
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
const COMPOSED_READS = [...new Set(SITUATIONAL.filter(e => e.taughtIn).map(e => e.skill))];
const CORE = [...new Set([
  ...REQUIRED_FOR_COMPOSED, ...REQUIRED_AT_ENTRY,
  'autonomous-trading', 'trader-process', 'htf-to-ltf', 'bar-briefing', 'role-round', 'day-context',
  ...COMPOSED_READS,
])];
const MAX_CONFIG_BYTES = require('./tunables').runner().limits.headPromptConfigBytes; // config/runner.json
const SHA = /^[0-9a-f]{64}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CYCLE = /^[0-9a-f]{16}$/;

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
    // A Claude head trader's (claudeAttestation): its harness and cycle too. opencode's carries neither.
    if (a.harness !== undefined) {
      if (a.harness !== 'claude' || !CYCLE.test(String(a.cycle))) return null;
      return { harness: 'claude', config: a.config, sha256: a.sha256, skills: [...new Set(a.skills)], cycle: a.cycle };
    }
    return { config: a.config, sha256: a.sha256, skills: [...new Set(a.skills)] };
  } catch (_err) {
    return null;
  }
}

/*
 * Claude Code's head trader in index mode (the runner config's headSkillsInPrompt). Its workspace instructions are
 * CLAUDE.md (no skill catalog: Claude Code lists skills itself), so the index is here, one line per skill not embedded.
 */
const CLAUDE_FILE = /^claude-head-[0-9a-f]{64}\.md$/;
const LOOKUP_TOOL = () => `mcp__${require('./harness-tools/registry').SERVER_NAME}__skill_lookup`;

function claudeHeadText(root, table = SITUATIONAL) {
  const plan = headPlan(root, 'index');
  const names = plan.docs.map(d => d.name);
  const index = require('./harness-tools/skills').skillCatalog(root).filter(k => !names.includes(k.name));
  const out = [
    `${HEAD_MARK} This part of your instructions holds your skills (index mode): the workspace instructions (CLAUDE.md) and the cycle's prompt still apply.`,
    '',
    `Your skills ${andList(names)} are below, already loaded (Your skills): every cycle reads them. Read them here; don't load them again. Any other skill a step needs is in Your skill index below: read one whole with \`${LOOKUP_TOOL()} {"skill": "<name>"}\` (no role: that is the roles') only when this cycle needs it. The roles you launch load their own skills.`,
    '',
  ];
  const required = headRequired(table);
  if (required.length) {
    out.push('Required by the situation: when this bar\'s briefing shows it, look the skill up before an entry; otherwise the order gate refuses the entry.', '',
      ...required.map(r => `- ${r.when.map(describeTrigger).join(', or ')}: \`${r.skill}\``), '');
  }
  out.push('## Your skills (already loaded)', '',
    `The skills you use every cycle (${names.join(', ')}) are below in full: they are loaded.`, '',
    ...plan.docs.flatMap(d => [block(d.name, d.body), '']),
    '## Your skill index', '',
    `Your other skills, not loaded. Read one only when this cycle needs it: ${LOOKUP_TOOL()} returns the whole skill.`, '',
    ...index.map(k => `- ${k.name}: ${k.description}`), '');
  return out.join('\n');
}

const claudeHeadFile = (home, text) => path.join(home, 'head-prompt', `claude-head-${sha256(text)}.md`);

/** The Claude head trader's prompt addition in the harness home: { file, text }, written (atomically) when missing or different. */
function writeClaudeHead(home, root) {
  const text = claudeHeadText(root);
  const file = claudeHeadFile(home, text);
  let same;
  try { same = fs.readFileSync(file, 'utf8') === text; } catch (_err) { same = false; }
  if (!same) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }
  return { file, text };
}

/** The runner's attestation of a Claude head trader's prompt addition for one cycle, or null (no cycle, no skill embedded). */
function claudeAttestation({ file, text, root, cycle }) {
  const skills = embeddedSkills(text, root);
  return skills.length && CYCLE.test(String(cycle || '')) ? { harness: 'claude', config: file, sha256: sha256(text), skills, cycle } : null;
}

/** A Claude head file's text, or null (not absolute, not the runner's name, too large, unreadable). */
function claudeHeadIn(file) {
  try {
    if (!path.isAbsolute(String(file)) || !CLAUDE_FILE.test(path.basename(file))) return null;
    if (fs.statSync(file).size > MAX_CONFIG_BYTES) return null;
    return fs.readFileSync(file, 'utf8') || null;
  } catch (_err) {
    return null;
  }
}

/** The first lines of a file (at most 64 KiB), or '' when unreadable (a transcript's first event is in them). */
function headOf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_err) {
    return '';
  }
}

/** A Claude Code `-p --output-format stream-json` run's session id (its first event, the init), or null. */
function claudeStreamSession(file) {
  for (const line of headOf(file).split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch (_err) { continue; }
    return ev && ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string' && ev.session_id ? ev.session_id : null;
  }
  return null;
}

/** The session a Claude Code hook's transcript_path is of: …/<session>.jsonl, or …/<session>/subagents/<agent>.jsonl. */
function claudeSessionOfPath(file) {
  const f = String(file || '');
  const sub = /\/([^/]+)\/subagents\/[^/]+\.jsonl$/.exec(f);
  if (sub) return sub[1];
  const main = /\/([^/]+)\.jsonl$/.exec(f);
  return main ? main[1] : null;
}

/**
 * The Claude head trader's embedded skills the gate may count: only for this process's cycle (`cycle`), the attested
 * file still hashing to the attested hash and embedding each one's current text, the runner's streamed transcript
 * (`stream`) a Claude Code run's, and a hook's transcript (`hook`) that run's own session. Anything off: [].
 */
function claudeAttested(att, root, { stream, hook = null, cycle } = {}) {
  if (!att || att.harness !== 'claude' || !CYCLE.test(String(cycle || '')) || att.cycle !== cycle) return [];
  const text = claudeHeadIn(att.config);
  if (!text || sha256(text) !== att.sha256) return [];
  const session = stream ? claudeStreamSession(stream) : null;
  if (!session || (hook && claudeSessionOfPath(hook) !== session)) return [];
  const embedded = embeddedSkills(text, root);
  return att.skills.filter(s => embedded.includes(s));
}

/** An opencode `run --format json` stream: its first event is one of opencode's (a session id and a part). */
function isOpencodeTranscript(file) {
  const text = headOf(file);
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
  // A Claude head trader's attestation is checked by claudeAttested, never here.
  if (att && att.harness !== undefined) return [];
  if (!att || !transcript || !isOpencodeTranscript(transcript)) return [];
  const prompt = headPromptIn(att.config);
  if (!prompt || sha256(prompt) !== att.sha256) return [];
  const embedded = embeddedSkills(prompt, root);
  return att.skills.filter(s => embedded.includes(s));
}

module.exports = {
  HEAD_AGENT, ATTEST_ENV, HEAD_MARK, CORE, COMPOSED_READS, headPlan, headRequired, headPrompt, embeddedSkills, headPromptIn, attestation, parseAttestation, isOpencodeTranscript, attestedSkills, sha256,
  claudeHeadText, claudeHeadFile, writeClaudeHead, claudeAttestation, claudeHeadIn, claudeStreamSession, claudeSessionOfPath, claudeAttested,
};

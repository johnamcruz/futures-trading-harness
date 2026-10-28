'use strict';

/**
 * The exit skills in a managed cycle's prompt (the owner: Haiku always has the exit playbook while a trade is open).
 * When the account holds an open position or a working entry, the runner puts the whole text of `manage-position` and
 * `pullback-vs-reversal` into that cycle's prompt (autotrader.js prompts().trade `exitSkills`, before its result line),
 * the same <skill name="..."> text a load returns, and says they are loaded. A flat cycle's prompt is as before, byte
 * for byte. Every harness the runner drives gets them.
 *
 * The order gate counts them as loaded only on the runner's attestation (ATTEST_ENV, FTH_EXIT_SKILLS), as it counts
 * the head trader's embedded skills (head-prompt.js): the runner writes the section to the harness home, named by its
 * hash, and attests { kind, config, sha256, skills, cycle } for the cycle it is for. At judgment time it holds only
 * when everything checks: the cycle is this process's (check-order.js cycleId), the file still hashes to the attested
 * hash and embeds each skill's current text, and the transcript is the run's own (a Claude Code stream and, for a
 * hook, that run's session; an opencode cycle transcript, never a hook's). Any other harness, or anything off: none
 * counts, and the transcript decides as before. Nothing here weakens a check: it only names where a load happened.
 *
 *   SKILLS                         ['manage-position', 'pullback-vs-reversal'], in prompt order
 *   ATTEST_ENV                     'FTH_EXIT_SKILLS'
 *   openOf(state)                  true when the account state shows an open position or a working entry
 *   exitSkillsText(root)           the prompt's section (starts with a space; the skills' current text)
 *   exitSkillsFile(home, text)     <home>/head-prompt/exit-skills-<sha256>.md
 *   writeExitSkills(home, root)    { file, text }, written (atomically) when missing or different (older ones pruned)
 *   exitAttestation({ file, text, root, cycle })   the runner's attestation for one cycle, or null
 *   parseExitAttestation(text)     the env value parsed, or null
 *   exitAttested(att, root, { stream, hook, cycle })   the skills the gate may count: [] unless all checks (stream: the
 *                                  runner's cycle transcript; hook: a hook's transcript_path, or null)
 */

const fs = require('fs');
const path = require('path');
const HP = require('./head-prompt');

const SKILLS = Object.freeze(['manage-position', 'pullback-vs-reversal']);
const ATTEST_ENV = 'FTH_EXIT_SKILLS';
const KIND = 'exit-skills';
const FILE = /^exit-skills-[0-9a-f]{64}\.md$/;
const SHA = /^[0-9a-f]{64}$/;
const CYCLE = /^[0-9a-f]{16}$/;
const MAX_BYTES = require('./tunables').runner().limits.headPromptConfigBytes; // config/runner.json (the head prompt's own read cap)

/** An open position, or a working entry with its bracket, in the account state the prompt is built from. */
function openOf(state) {
  if (!state || typeof state !== 'object' || state.error) return false;
  return (Array.isArray(state.positions) && state.positions.length > 0) || (Array.isArray(state.entryLines) && state.entryLines.length > 0);
}

/** The managed cycle's section: the exit skills in full, said loaded. */
function exitSkillsText(root) {
  const docs = SKILLS.map(name => ({ name, body: HP.skillBody(root, name) }));
  return ` A position or a working entry is open: your exit skills ${HP.andList(SKILLS)} are below, already loaded (don't load them again); manage it by them.\n\n${docs.map(d => HP.block(d.name, d.body)).join('\n\n')}\n`;
}

const exitSkillsFile = (home, text) => path.join(home, 'head-prompt', `exit-skills-${HP.sha256(text)}.md`);

function writeExitSkills(home, root) {
  const text = exitSkillsText(root);
  const file = exitSkillsFile(home, text);
  if (HP.writeAtomic(file, text)) HP.pruneOlder(path.dirname(file), file, FILE);
  return { file, text };
}

function exitAttestation({ file, text, root, cycle }) {
  const skills = HP.embeddedSkills(text, root).filter(s => SKILLS.includes(s));
  return skills.length && CYCLE.test(String(cycle || '')) ? { kind: KIND, config: file, sha256: HP.sha256(text), skills, cycle } : null;
}

function parseExitAttestation(text) {
  try {
    const a = JSON.parse(String(text || ''));
    if (!a || typeof a !== 'object' || a.kind !== KIND || typeof a.config !== 'string' || !SHA.test(String(a.sha256)) || !CYCLE.test(String(a.cycle))) return null;
    if (!Array.isArray(a.skills) || !a.skills.length || !a.skills.every(s => SKILLS.includes(s))) return null;
    return { kind: KIND, config: a.config, sha256: a.sha256, skills: [...new Set(a.skills)], cycle: a.cycle };
  } catch (_err) {
    return null;
  }
}

/** The attested file's text, or null (not absolute, not the runner's name, too large, unreadable). */
function fileText(file) {
  try {
    if (!path.isAbsolute(String(file)) || !FILE.test(path.basename(file))) return null;
    if (fs.statSync(file).size > MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8') || null;
  } catch (_err) {
    return null;
  }
}

/**
 * The run's own transcript: the runner's cycle stream a Claude Code run's (and a hook's, that run's session), or an
 * opencode run's (never a hook's: a hook is another harness's session). Anything else: no.
 */
function ownRun({ stream, hook }) {
  if (!stream) return false;
  const session = HP.claudeStreamSession(stream);
  if (session) return !hook || HP.claudeSessionOfPath(hook) === session;
  return !hook && HP.isOpencodeTranscript(stream);
}

function exitAttested(att, root, { stream = null, hook = null, cycle = null } = {}) {
  if (!att || att.kind !== KIND || !CYCLE.test(String(cycle || '')) || att.cycle !== cycle) return [];
  const text = fileText(att.config);
  if (!text || HP.sha256(text) !== att.sha256) return [];
  if (!ownRun({ stream, hook })) return [];
  const embedded = HP.embeddedSkills(text, root);
  return att.skills.filter(s => SKILLS.includes(s) && embedded.includes(s));
}

module.exports = { SKILLS, ATTEST_ENV, openOf, exitSkillsText, exitSkillsFile, writeExitSkills, exitAttestation, parseExitAttestation, exitAttested };

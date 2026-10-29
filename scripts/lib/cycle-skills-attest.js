'use strict';

/**
 * The runner's attestation of a cycle's situational skills (situational-skills.js), as the order gate checks it: light
 * on purpose (head-prompt.js only), so the gate's modules load whatever the training and analysis config hold.
 *
 * The run's environment writes the cycle's section to the harness home (<home>/head-prompt/cycle-skills-<sha256>.md) and
 * attests { kind: 'cycle-skills', config, sha256, skills, cycle } for its cycle (ATTEST_ENV, FTH_CYCLE_SKILLS). At
 * judgment time it holds only when everything checks: the cycle is this process's (check-order.js cycleId), the file
 * still hashes to the attested hash and embeds each named skill's current text whole, and the transcript is the run's
 * own (a Claude Code stream and, for a hook, that run's session; an opencode cycle transcript, never a hook's). Any
 * other harness, or anything off: none counts, and the transcript decides as before.
 *
 *   ATTEST_ENV, KIND, FILE
 *   fileOf(home, text)                        where the section is kept
 *   attestation({ file, text, root, cycle })  the attestation for one cycle, or null (no skill embedded, no cycle)
 *   parseAttestation(text)                    the env value parsed, or null
 *   attested(att, root, { stream, hook, cycle })   the skills the gate may count: [] unless every check holds
 */

const fs = require('fs');
const path = require('path');
const HP = require('./head-prompt');

const ATTEST_ENV = 'FTH_CYCLE_SKILLS';
const KIND = 'cycle-skills';
const FILE = /^cycle-skills-[0-9a-f]{64}\.md$/;
const SHA = /^[0-9a-f]{64}$/;
const CYCLE = /^[0-9a-f]{16}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BYTES = require('./tunables').runner().limits.headPromptConfigBytes; // config/runner.json (the head prompt's own read cap)
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

const fileOf = (home, text) => path.join(home, 'head-prompt', `cycle-skills-${HP.sha256(text)}.md`);

function attestation({ file, text, root, cycle }) {
  const skills = HP.embeddedSkills(text, root);
  return skills.length && CYCLE.test(String(cycle || '')) ? { kind: KIND, config: file, sha256: HP.sha256(text), skills, cycle } : null;
}

function parseAttestation(text) {
  try {
    const a = JSON.parse(String(text || ''));
    if (!isObj(a) || a.kind !== KIND || typeof a.config !== 'string' || !SHA.test(String(a.sha256)) || !CYCLE.test(String(a.cycle))) return null;
    if (!Array.isArray(a.skills) || !a.skills.length || !a.skills.every(s => typeof s === 'string' && NAME.test(s))) return null;
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

function attested(att, root, { stream = null, hook = null, cycle = null } = {}) {
  if (!att || att.kind !== KIND || !CYCLE.test(String(cycle || '')) || att.cycle !== cycle) return [];
  const text = fileText(att.config);
  if (!text || HP.sha256(text) !== att.sha256) return [];
  if (!ownRun({ stream, hook })) return [];
  const embedded = HP.embeddedSkills(text, root);
  return att.skills.filter(s => embedded.includes(s));
}

module.exports = { ATTEST_ENV, KIND, FILE, fileOf, attestation, parseAttestation, attested };

'use strict';

/**
 * compose_check's early warning (the owner, 2026-10-31: "Warn early + embed", "We need to ensure all the skills are
 * loaded"). Every skill the head trader's composed reads require (skills-loaded.js SITUATIONAL: the entries marked
 * `head` whose composed trigger fires on the record's reads, e.g. candle-reading for a rejection, a break or a sweep)
 * that this cycle's head has not read is named in the reply while the head is still running, so the same cycle can
 * read it and compose again. It never refuses anything: the order gate stays the one that enforces the requirement,
 * and the record is unchanged. Only where the gate requires them (an autonomous cycle, the head trader in index mode or
 * Claude Code's head with its attested prompt: order-gate.js), so a warning always names what the gate would refuse.
 *
 * Read means, as the gate counts it for the head's own session:
 *   - loaded or looked up in the cycle's transcript (FTH_CYCLE_TRANSCRIPT: a skill load, opencode's or Claude Code's
 *     skill_lookup);
 *   - embedded in the head prompt on its attestation (FTH_HEAD_PROMPT: opencode's attestedSkills, Claude Code's
 *     claudeAttested);
 *   - embedded in this cycle's situational section on its attestation (FTH_CYCLE_SKILLS, cycle-skills-attest.js).
 * Anything unreadable counts as not read, so the warning shows (also when the cycle's lanes can't be read).
 *
 *   factsOf(reads)                          the composed facts the triggers read ({ composed: [{ kinds, relations }] })
 *   requiredBy(reads)                       the head-required skills these reads trigger
 *   readThisCycle(env, root)                the skills this cycle's head has read, as the gate counts them
 *   enforced(env)                           whether the gate requires the situational skills here
 *   unread(reads, { env, root })            the required skills not read
 *   warningFor(reads, { env, root })        the reply's line, or null
 */

/** The composed facts these reads make (skill-lookups.js composedAt's shape), as the triggers read them. */
function factsOf(reads) {
  const { parseRead } = require('./composed-reads');
  const parsed = (Array.isArray(reads) ? reads : []).map(r => { try { return parseRead(String(r)); } catch (_err) { return null; } }).filter(Boolean);
  return { composed: [{ id: 'compose', kinds: [...new Set(parsed.map(p => p.kind))], relations: [...new Set(parsed.filter(p => p.kind === 'relation' && p.rel).map(p => p.rel))] }] };
}

/** The head-required skills these reads trigger: the gate's own table and triggers (the composed entry's table). */
function requiredBy(reads) {
  const { situationalSkills } = require('./skills-loaded');
  return situationalSkills(factsOf(reads));
}

/** Whether the gate requires the head's situational skills in this run (order-gate.js: autonomous, index mode or Claude's head). */
function enforced(env = process.env) {
  if (String((env && env.FTH_AUTONOMOUS) || '') !== '1') return false;
  if (String(env.FTH_ROLE_SKILLS || '').trim() !== 'full') return true;
  const att = require('../head-prompt').parseAttestation(env.FTH_HEAD_PROMPT);
  return Boolean(att && att.harness === 'claude');
}

/** The skills this cycle's head trader has read, as the gate counts them for its own session (never throws). */
function readThisCycle(env = process.env, root = null) {
  const out = new Set();
  const transcript = String((env && env.FTH_CYCLE_TRANSCRIPT) || '').trim();
  if (!transcript) return out;
  const SL = require('./skills-loaded');
  const add = list => { for (const s of list || []) out.add(s); };
  try { add(SL.loadedSkills(transcript)); } catch (_err) { /* unreadable: none */ }
  try { add(SL.loadedSkills(transcript, SL.claudeLookupsInTranscript)); } catch (_err) { /* unreadable: none */ }
  if (!root) return out;
  const HP = require('../head-prompt');
  const cycle = (() => { try { return require('./check-order').cycleId(env); } catch (_err) { return null; } })();
  try {
    const att = HP.parseAttestation(env.FTH_HEAD_PROMPT);
    if (att && att.harness === 'claude') add(HP.claudeAttested(att, root, { stream: transcript, cycle }));
    else if (att) add(HP.attestedSkills(att, root, { transcript }));
  } catch (_err) { /* off: none */ }
  try {
    const CSA = require('../cycle-skills-attest');
    add(CSA.attested(CSA.parseAttestation(env.FTH_CYCLE_SKILLS), root, { stream: transcript, hook: null, cycle }));
  } catch (_err) { /* off: none */ }
  return out;
}

/** The skills these reads require that this cycle's head hasn't read (none where the gate doesn't require them). */
function unread(reads, { env = process.env, root = null } = {}) {
  if (!enforced(env)) return [];
  const need = requiredBy(reads);
  if (!need.length) return [];
  const read = readThisCycle(env, root);
  return need.filter(s => !read.has(s));
}

/** The warning line for these reads, or null (nothing required, or all read this cycle). */
function warningFor(reads, { env = process.env, root = null } = {}) {
  const missing = unread(reads, { env, root });
  if (!missing.length) return null;
  const calls = missing.map(s => `\`skill_lookup {"skill": "${s}"}\``).join(', ');
  return `- READ FIRST: this record's reads need ${missing.join(', ')}, not read this cycle; read ${missing.length > 1 ? 'each' : 'it'} with ${calls}, then compose again (the order gate requires ${missing.length > 1 ? 'them' : 'it'} for this entry).`;
}

module.exports = { factsOf, requiredBy, enforced, readThisCycle, unread, warningFor };

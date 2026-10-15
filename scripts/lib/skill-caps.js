'use strict';

/**
 * A skill's byte cap: the most bytes its body (after the frontmatter) may hold, since roles embed skills in their
 * prompts. One source for every reader: the basics-skills test (tests/plugin/basics-skills.test.js) and the training
 * loop's probe edits (train/probe-edit.js) read it here, so the two can never disagree.
 *
 *   SKILL_BYTES          the cap of a skill (config/training.json skillCaps, only falls)
 *   SETUP_SKILL_BYTES    the two setups' cap (they also carry a timeframe table)
 *   SETUP_SKILLS         the setups: rejection, breakout
 *   skillByteCap(name)   the cap of the skill named
 */

const CAPS = require('./tunables').training().skillCaps;
const SKILL_BYTES = CAPS.skillBytes;
const SETUP_SKILL_BYTES = CAPS.setupSkillBytes;
const SETUP_SKILLS = Object.freeze(['rejection', 'breakout']);

const skillByteCap = name => (SETUP_SKILLS.includes(name) ? SETUP_SKILL_BYTES : SKILL_BYTES);

module.exports = { SKILL_BYTES, SETUP_SKILL_BYTES, SETUP_SKILLS, skillByteCap };

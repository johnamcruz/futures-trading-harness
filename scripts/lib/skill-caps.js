'use strict';

/**
 * A skill's byte cap: the most bytes its body (after the frontmatter) may hold, since roles embed skills in their
 * prompts. One source for every reader: the basics-skills test (tests/plugin/basics-skills.test.js) and the training
 * loop's probe edits (train/probe-edit.js) read it here, so the two can never disagree.
 *
 *   SKILL_BYTES          the cap of a skill: 3400 bytes
 *   SETUP_SKILL_BYTES    the two setups' cap (they also carry a timeframe table): 4000 bytes
 *   SETUP_SKILLS         the setups: rejection, breakout
 *   skillByteCap(name)   the cap of the skill named
 */

const SKILL_BYTES = 3400;
const SETUP_SKILL_BYTES = 4000;
const SETUP_SKILLS = Object.freeze(['rejection', 'breakout']);

const skillByteCap = name => (SETUP_SKILLS.includes(name) ? SETUP_SKILL_BYTES : SKILL_BYTES);

module.exports = { SKILL_BYTES, SETUP_SKILL_BYTES, SETUP_SKILLS, skillByteCap };

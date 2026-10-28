'use strict';

/**
 * What the journal has taught so far (scripts/lessons.js; trading/instincts.js):
 *
 *   lessons { top, kind, json }   (kind: the tool only, not a flag) top: a positive whole number (default 10); kind 'lesson': only the run's lessons, as
 *                                 advice with their record, newest last, up to the session-start lesson count (top
 *                                 is not used): never crowded out by the reviews' instincts
 */

const { instincts, lessonLines } = require('../trading/instincts');
const { resolveJournalPath, readJournal } = require('../trading/journal');
const { context } = require('./cli');
const { harnessHome } = require('../paths');
const { readShadow } = require('../trading/lesson-shadow');
const MAX_LESSONS = require('../tunables').runner().prompt.sessionStartLessons; // config/runner.json

const USAGE = 'usage: lessons.js [--top 10] [--json]';

function lessons({ top = 10, kind = null, json = false } = {}, ctx) {
  const { env, now } = context(ctx);
  if (kind !== null && kind !== 'lesson') throw new Error('kind: lesson, or none'); // tool-only: the schema's enum refuses this first
  if (!(Number.isInteger(top) && top > 0)) throw new Error('--top: a positive whole number'); // cli-only: the tool's schema refuses this first
  // The run's own lessons (by the harness clock, across a continuous combine's attempts), each as advice with its date and its
  // record since: the trades taken and the composed plans walked forward (trading/lesson-advice.js, lesson-shadow.js).
  const at = now();
  const home = harnessHome(env);
  const entries = readJournal(resolveJournalPath(env));
  const shadow = readShadow(home, at);
  if (kind === 'lesson') {
    const lines = lessonLines(entries, { n: MAX_LESSONS, now: at, shadow });
    return { text: json ? `${JSON.stringify(lines, null, 2)}\n` : lines.length ? `${lines.join('\n')}\n` : 'No lessons yet.\n' };
  }
  const list = instincts(entries, { now: at, shadow }).slice(0, top);
  if (json) return { text: `${JSON.stringify(list, null, 2)}\n` };
  return { text: list.length ? `${list.map(x => `(${x.confidence.toFixed(1)}) [${x.kind}] ${x.text}`).join('\n')}\n` : 'No instincts yet: they come from reviewed trades (result:, setup:, regime:, mistake: and r: tags) and lessons.\n' };
}

/** argv to { top, json }. */
function parseArgv(argv) {
  const o = { top: 10, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag === '--top') o.top = Number(inline !== undefined ? inline : argv[++i]);
    else if (flag === '--json') o.json = true;
    else throw new Error(`unknown argument: ${argv[i]} (${USAGE})`);
  }
  return o;
}

const OPS = { lessons };

module.exports = { OPS, USAGE, lessons, parseArgv };

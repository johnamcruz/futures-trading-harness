'use strict';

/**
 * What the journal has taught so far (scripts/lessons.js; trading/instincts.js):
 *
 *   lessons { top, json }   top: a positive whole number (default 10)
 */

const { instincts } = require('../trading/instincts');
const { resolveJournalPath, readJournal } = require('../trading/journal');
const { context } = require('./cli');

const USAGE = 'usage: lessons.js [--top 10] [--json]';

function lessons({ top = 10, json = false } = {}, ctx) {
  const { env } = context(ctx);
  if (!(Number.isInteger(top) && top > 0)) throw new Error('--top: a positive whole number'); // cli-only: the tool's schema refuses this first
  const list = instincts(readJournal(resolveJournalPath(env))).slice(0, top);
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

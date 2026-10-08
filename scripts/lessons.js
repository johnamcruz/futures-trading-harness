#!/usr/bin/env node
/**
 * What the journal has taught so far (scripts/lib/trading/instincts.js): each
 * setup's record by regime, recurring mistakes, and the reviewer's lessons,
 * strongest evidence first, with a confidence from 0.3 to 0.9.
 *
 *   node scripts/lessons.js [--top 10] [--json]
 */

'use strict';

const { instincts } = require('./lib/trading/instincts');
const { resolveJournalPath, readJournal } = require('./lib/trading/journal');

function main(argv) {
  let top = 10;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag === '--top') top = Number(inline !== undefined ? inline : argv[++i]);
    else if (flag === '--json') json = true;
    else throw new Error(`unknown argument: ${argv[i]} (usage: lessons.js [--top 10] [--json])`);
  }
  if (!(Number.isInteger(top) && top > 0)) throw new Error('--top: a positive whole number');
  const list = instincts(readJournal(resolveJournalPath(process.env))).slice(0, top);
  if (json) process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
  else process.stdout.write(list.length ? `${list.map(x => `(${x.confidence.toFixed(1)}) [${x.kind}] ${x.text}`).join('\n')}\n` : 'No instincts yet: they come from reviewed trades (result:, setup:, regime:, mistake: and r: tags) and lessons.\n');
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`[lessons] ${err.message}\n`);
  process.exitCode = 1;
}

#!/usr/bin/env node
'use strict';

/**
 * Writes the prepare-ahead off regression's expected outputs (main-outputs.json) from the code it runs in. Run it in a
 * scratch checkout of origin/main, never on a branch (the expected value is main's own):
 *
 *   mkdir /tmp/main && git archive origin/main | tar -x -C /tmp/main
 *   mkdir -p /tmp/main/tests/fixtures/prepare-off && cp tests/fixtures/prepare-off/outputs.js tests/fixtures/prepare-off/generate.js /tmp/main/tests/fixtures/prepare-off/
 *   node /tmp/main/tests/fixtures/prepare-off/generate.js tests/fixtures/prepare-off/main-outputs.json <commit>
 *
 * The file names the commit it was made from. A change to it is a golden change (CONTRIBUTING.md, "Golden files").
 */

// The user's home pinned before anything reads it (os.homedir is in the prompt and the deny rules): the fixture is
// the same on every machine.
process.env.HOME = require('./outputs').PINNED_HOME;
const fs = require('fs');
const { allDays } = require('./outputs');

(async () => {
  const [out, commit] = process.argv.slice(2);
  if (!out || !commit) { process.stderr.write('usage: generate.js <out.json> <main commit>\n'); process.exit(1); }
  const days = await allDays({});
  fs.writeFileSync(out, `${JSON.stringify({ commit, days }, null, 1)}\n`);
  process.stdout.write(`wrote ${out} from ${commit}\n`);
})();

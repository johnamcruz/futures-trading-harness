'use strict';

// Stand-in for a harness CLI: echoes the prompt and a cycle result, or fails on demand.
const prompt = process.argv.slice(2).join(' ');
process.stdout.write(`cwd=${process.cwd()} FTH_ROOT=${process.env.FTH_ROOT}\nprompt=${prompt}\n`);
if (prompt.includes('FAIL')) process.exit(3);
process.stdout.write('CYCLE RESULT: no-trade - fake harness\n');

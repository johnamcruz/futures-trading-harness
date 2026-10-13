'use strict';
// For tests/plugin/temp-root.test.js: runTests(argv files) under parent process.env.TEMP_ROOT_PARENT,
// printing the result as JSON, so a signal can be sent to a runner that is not the test process.
const { runTests } = require('../../temp-root');

runTests(process.argv.slice(2), { parent: process.env.TEMP_ROOT_PARENT, stdio: 'ignore' })
  .then(r => { process.stdout.write(JSON.stringify(r)); process.exit(r.status); });

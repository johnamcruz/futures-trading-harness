'use strict';
// A test file for tests/plugin/temp-root.test.js: makes temp dirs in its process and in a child,
// and writes where they went to process.env.TEMP_ROOT_OUT.
const test = require('node:test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('makes temp dirs here and in a child process', () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-test-'));
  const child = execFileSync(process.execPath, ['-e', "const fs=require('fs'),os=require('os'),path=require('path');process.stdout.write(fs.mkdtempSync(path.join(os.tmpdir(),'fth-test-')))"], { encoding: 'utf8' });
  fs.writeFileSync(process.env.TEMP_ROOT_OUT, JSON.stringify({ own, child, root: process.env.FTH_TEST_TMP_ROOT }));
  if (process.env.TEMP_ROOT_FAIL === '1') throw new Error('failing on purpose');
});

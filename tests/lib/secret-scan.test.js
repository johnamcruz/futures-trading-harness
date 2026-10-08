'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { isEnvFile, scanText, scanFiles } = require('../../scripts/lib/secret-scan');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');

test('env files are refused; templates are fine', () => {
  for (const f of ['.env', 'config/.env', '.env.local', '.env.production', 'prod.env']) assert.ok(isEnvFile(f), f);
  for (const f of ['.env.example', '.env.sample', 'docs/env.md', 'scripts/lib/env-file.js', 'environment.json']) assert.ok(!isEnvFile(f), f);
});

test('credential values are found; placeholders, env lookups, and short test values are not', () => {
  assert.deepStrictEqual(scanText('PROJECTX_API_KEY=aB3dE5gH7jK9mN1p').map(f => f.reason), ['PROJECTX_API_KEY set to a value (aB…16 chars)']); // check-secrets: allow (fake test value)
  assert.strictEqual(scanText('"PROJECTX_API_KEY": "aB3dE5gH7jK9mN1p",').length, 1); // check-secrets: allow (fake test value)
  assert.strictEqual(scanText('MY_SERVICE_TOKEN: xY7zW9vU5tS3rQ1p').length, 1); // check-secrets: allow (fake test value)
  assert.strictEqual(scanText('-----BEGIN RSA PRIVATE KEY-----')[0].reason, 'a private key'); // check-secrets: allow (fake test value)
  for (const ok of [
    'PROJECTX_API_KEY=your-api-key', '"PROJECTX_API_KEY": "your-api-key"', 'PROJECTX_API_KEY=${PROJECTX_API_KEY}', 'PROJECTX_API_KEY=<key>',
    "const apiKey = String(env.PROJECTX_API_KEY || '');", "PROJECTX_USERNAME: 'u', PROJECTX_API_KEY: 'k'", 'PROJECTX_API_KEY=', 'PASSWORD=changeme',
    'export PROJECTX_API_KEY=$PROJECTX_API_KEY',
  ]) assert.deepStrictEqual(scanText(ok), [], ok);
  assert.deepStrictEqual(scanText('API_KEY=Zq8Wd2Lk9Pm4Rt6Y // check-secrets: allow (fake test value)'), [], 'an explicit, reviewable exception');
  const findings = scanFiles(['.env', 'a.js', 'img.png'], f => (f === 'a.js' ? 'x\nAPI_KEY=Zq8Wd2Lk9Pm4Rt6Y' : 'binary'));
  assert.deepStrictEqual(findings.map(f => [f.file, f.line || null]), [['.env', null], ['a.js', 2]]);
});

test('the repository has no env file or credential value (as CI checks)', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-secrets.js')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
});

test('--staged refuses a staged .env (even force-added) and a staged key, naming the file but never the value', () => {
  const repo = tmpDir();
  const run = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  run(['init', '-q']);
  fs.mkdirSync(path.join(repo, 'scripts', 'lib'), { recursive: true });
  for (const f of ['scripts/check-secrets.js', 'scripts/lib/secret-scan.js']) fs.copyFileSync(path.join(ROOT, f), path.join(repo, f));
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(repo, '.env'), 'PROJECTX_API_KEY=aB3dE5gH7jK9mN1p\n'); // check-secrets: allow (fake test value)
  fs.writeFileSync(path.join(repo, 'ok.txt'), 'hello\n');
  const check = () => spawnSync(process.execPath, [path.join(repo, 'scripts', 'check-secrets.js'), '--staged'], { encoding: 'utf8' });
  run(['add', 'ok.txt']);
  assert.strictEqual(check().status, 0);
  run(['add', '-f', '.env']);
  let r = check();
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /\.env: an env file/);
  run(['rm', '-q', '--cached', '.env']);
  fs.writeFileSync(path.join(repo, 'config.json'), '{ "PROJECTX_API_KEY": "aB3dE5gH7jK9mN1p" }\n'); // check-secrets: allow (fake test value)
  run(['add', 'config.json']);
  r = check();
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /config\.json:1: PROJECTX_API_KEY set to a value/);
  assert.doesNotMatch(r.stderr, /aB3dE5gH7jK9mN1p/);
  // The hook installer adds the check to .git/hooks/pre-commit.
  const inst = spawnSync(process.execPath, [path.join(repo, 'scripts', 'check-secrets.js'), '--install-hook'], { encoding: 'utf8' });
  assert.strictEqual(inst.status, 0, inst.stderr);
  assert.match(fs.readFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), 'utf8'), /check-secrets\.js" --staged/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createAlerter, writeHeartbeat, watchdogStatus, heartbeatFile } = require('../../scripts/lib/alerts');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');

test('alerts: logged to alerts-<day>.jsonl, sent to the webhook and command, the same message throttled', () => {
  const home = tmpDir();
  let t = Date.parse('2026-10-07T14:00:00Z');
  const posts = [];
  const runs = [];
  const alert = createAlerter({
    home, webhook: 'https://hooks.example/x', command: ['notify'], now: () => new Date(t),
    post: (url, body) => posts.push([url, body.text]), run: (argv, text) => runs.push([argv[0], text]), label: 'autotrader MNQ',
  });
  assert.strictEqual(alert('MNQ: could not cancel 123 after the close'), true);
  assert.deepStrictEqual(posts, [['https://hooks.example/x', '[autotrader MNQ] ERROR: MNQ: could not cancel 123 after the close']]);
  assert.strictEqual(runs.length, 1);
  // The same problem with other numbers, two minutes later: logged, not sent.
  t += 120000;
  assert.strictEqual(alert('MNQ: could not cancel 456 after the close'), false);
  assert.strictEqual(posts.length, 1);
  // Past the throttle window it is sent again; a different message is sent at once.
  t += 10 * 60000;
  assert.strictEqual(alert('MNQ: could not cancel 789 after the close'), true);
  assert.strictEqual(alert('kill switch created', { kind: 'stop' }), true);
  assert.strictEqual(posts.length, 3);
  const lines = fs.readFileSync(path.join(home, 'logs', 'alerts-2026-10-07.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(lines.map(l => l.sent), [true, false, true, true]);
  // Nothing configured: still logged, nothing sent, never throws.
  const quiet = createAlerter({ home });
  assert.strictEqual(quiet('x'), true);
});

test('watchdog: ok with a fresh heartbeat; not ok when silent, missing, or stopped by the kill switch', () => {
  const home = tmpDir();
  const now = new Date('2026-10-07T14:00:00Z');
  assert.match(watchdogStatus(home, { now }).problems[0], /no heartbeat/);
  writeHeartbeat(home, { symbols: ['MNQ'] }, new Date(now.getTime() - 2 * 60000));
  assert.ok(fs.existsSync(heartbeatFile(home)));
  const ok = watchdogStatus(home, { now, staleMinutes: 5 });
  assert.deepStrictEqual([ok.ok, ok.ageMinutes, ok.heartbeat.symbols], [true, 2, ['MNQ']]);
  assert.match(watchdogStatus(home, { now: new Date(now.getTime() + 10 * 60000), staleMinutes: 5 }).problems[0], /last runner pass was 12 min ago \(limit 5\)/);
  fs.writeFileSync(path.join(home, 'STOP'), 'created by autotrader after 3 failed runs\n');
  assert.match(watchdogStatus(home, { now, staleMinutes: 5 }).problems.join(), /kill switch is on .*after 3 failed runs/);
});

test('autotrader --status exits 1 when the runner is not running, 0 with a fresh heartbeat', () => {
  const home = tmpDir();
  const run = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'autotrader.js'), '--status'], { encoding: 'utf8', env: { ...process.env, FTH_HOME: home, FTH_KILL_SWITCH_FILE: path.join(home, 'STOP') } });
  const down = run();
  assert.strictEqual(down.status, 1);
  assert.match(down.stdout, /runner NOT ok/);
  writeHeartbeat(home, {});
  const up = run();
  assert.strictEqual(up.status, 0, up.stdout + up.stderr);
  assert.match(up.stdout, /runner ok: last pass/);
});

test('config: alertWebhook must be https, alertCommand an argv array', () => {
  const base = { harness: 'qwen', eodAt: '15:50@America/New_York' };
  assert.doesNotThrow(() => validateConfig({ ...base, alertWebhook: 'https://hooks.slack.com/services/x', alertCommand: ['say', 'alert'] }));
  assert.throws(() => validateConfig({ ...base, alertWebhook: 'http://plain' }), /alertWebhook: an https:\/\/ URL/);
  assert.throws(() => validateConfig({ ...base, alertCommand: 'say hi' }), /alertCommand: an argv array/);
});

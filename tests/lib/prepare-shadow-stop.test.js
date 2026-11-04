'use strict';

// Prepare ahead's shadow runs and the runner's stop (review F2): a SIGTERM or SIGINT to the runner while a prepare or a
// shadow confirm runs kills its CLI and everything in that CLI's process group (its MCP servers); no child outlives the
// runner. The runner tracks them as it tracks its roles (harness-run.js childTracker; scripts/autotrader.js holdLock).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { childTracker, killChildren } = require('../../scripts/lib/harness-run');

const ROOT = path.resolve(__dirname, '..', '..');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (_err) { return false; } };
const until = async (f, ms = 15000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 50)); } return true; };

for (const kind of ['prepare', 'confirm']) {
  for (const sig of ['SIGTERM', 'SIGINT']) {
    test(`the runner stopped (${sig}) mid-${kind}: the shadow run's CLI and its process group are killed, nothing survives`, { timeout: 60000 }, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-shadow-stop-'));
      const pidFile = path.join(dir, 'pids.json');
      const runner = spawn(process.execPath, [path.join(ROOT, 'tests', 'fixtures', 'shadow-stop.js'), pidFile, kind, dir], { stdio: 'ignore' });
      assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 2), 'the run started');
      const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      try {
        assert.ok(pids.every(alive));
        runner.kill(sig);
        assert.ok(await until(() => runner.exitCode !== null || runner.signalCode !== null), 'the runner exits');
        assert.ok(await until(() => !pids.some(alive)), `no child survives: ${pids.filter(alive)}`);
      } finally {
        // A failing case never leaves its processes behind (a CI machine's): whatever is still alive is killed.
        for (const pid of [runner.pid, ...pids]) { try { process.kill(pid, 'SIGKILL'); } catch (_err) { /* gone */ } }
      }
    });
  }
}

test('childTracker: tracks a child until it exits; killChildren reaches each tracked child\'s group', { timeout: 60000 }, async () => {
  const t = childTracker();
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  t.track(c);
  t.track(null);
  assert.deepStrictEqual([...t.children()], [c]);
  killChildren([...t.children(), null], 'SIGTERM');
  assert.ok(await until(() => c.exitCode !== null || c.signalCode !== null));
  assert.deepStrictEqual([...t.children()], [], 'gone once it exits');
});

test('the runner\'s stop kills the shadow runs\' children with its own (scripts/autotrader.js: runPrepare tracked, holdLock\'s stop kills them)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'autotrader.js'), 'utf8');
  assert.match(src, /runPrepare: \(c, kind, prompt, limits\) => runPrepareWith\(c, kind, prompt, limits, \{[^}]*onChild: shadowChildren\.track/);
  assert.match(src, /killChildren\(\[activeChild, \.\.\.roleChildren, \.\.\.shadowChildren\.children\(\)\], sig\)/);
});

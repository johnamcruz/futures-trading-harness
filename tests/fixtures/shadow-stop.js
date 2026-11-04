'use strict';

// A runner process as scripts/autotrader.js holds its runs (harness-run.js childTracker, killChildren): a prepare (or,
// with argv[3] "confirm", a shadow confirm) through cycle-run.js runPrepare, its CLI a long-running stand-in that writes
// its pid to argv[2] and waits. SIGTERM / SIGINT stop it as autotrader.js holdLock's stop does: every tracked child's
// group killed, then exit 130. The test (tests/lib/prepare-shadow-stop.test.js) kills this process mid-run.

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { runHarness, childTracker, killChildren } = require(path.join(ROOT, 'scripts', 'lib', 'harness-run'));
const { runPrepare } = require(path.join(ROOT, 'scripts', 'lib', 'cycle-run'));
const { validateConfig } = require(path.join(ROOT, 'scripts', 'lib', 'autotrader'));

const [pidFile, kind = 'prepare', home] = process.argv.slice(2);
const shadow = childTracker();
const stop = sig => { killChildren([...shadow.children()], sig); process.exit(130); };
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
const cfg = validateConfig({ harness: 'claude', premarketAt: '', symbols: ['MNQ'], prepareAhead: 'shadow' });
// The CLI's stand-in: its pid to the file, then it waits (and a grandchild of its own, as an MCP server would be).
const sleeper = `const { spawn } = require('child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, g.pid])); setInterval(() => {}, 1000);`;
runPrepare(cfg, kind, 'P', { timeoutMs: 600000, context: { action: 'trade' }, ...(kind === 'confirm' ? { resume: 'ses-1' } : {}) }, {
  root: ROOT, home, env: { FTH_HOME: home, HOME: home, PATH: process.env.PATH },
  run: (argv, o) => runHarness([process.execPath, '-e', sleeper], o), onChild: shadow.track,
}).then(() => fs.writeFileSync(`${pidFile}.done`, '1'));

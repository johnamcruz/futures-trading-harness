'use strict';

/**
 * Alerts and the watchdog for the autonomous runner, so a human hears about
 * trouble while it still matters.
 *
 * alert(message): every runner error (and the kill switch tripping) is
 * appended to <FTH_HOME>/logs/alerts-<day>.jsonl, and, when configured, sent
 * to `alertWebhook` (an https URL: Slack, Discord, ntfy, or anything that
 * takes a JSON POST with `text`/`content`) and/or run through `alertCommand`
 * (an argv array; the message is in FTH_ALERT). The same message (numbers
 * ignored) is sent at most once per `throttleMinutes`. Alerting never throws
 * and never blocks the loop.
 *
 * Heartbeat: the runner writes <FTH_HOME>/autotrader-heartbeat.json after
 * every pass. `node scripts/autotrader.js --status` (watchdogStatus) reads it
 * and exits 1 when the runner is silent for too long (it died, hung, or lost
 * the network), or when the kill switch is on, so cron, launchd, or a monitor
 * can page someone.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const dayKey = d => d.toISOString().slice(0, 10);
const heartbeatFile = home => path.join(home, 'autotrader-heartbeat.json');

/** POST JSON to an https URL; resolves true/false, never rejects. */
function postJson(url, body, timeoutMs = 5000) {
  return new Promise(resolve => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') { resolve(false); return; }
      const data = Buffer.from(JSON.stringify(body));
      const req = https.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: timeoutMs }, res => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
      req.end(data);
    } catch (_err) {
      resolve(false);
    }
  });
}

/** Run argv with the message in FTH_ALERT; detached, output ignored. */
function runCommand(argv, message) {
  try {
    const child = spawn(argv[0], argv.slice(1), { env: { ...process.env, FTH_ALERT: message }, stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (_err) {
    return false;
  }
}

function createAlerter({ home, webhook = '', command = null, throttleMinutes = 10, now = () => new Date(), post = postJson, run = runCommand, label = 'futures-trading-harness' } = {}) {
  const lastSent = new Map();
  return function alert(message, { kind = 'error' } = {}) {
    const at = now();
    const text = `[${label}] ${kind.toUpperCase()}: ${message}`;
    // Numbers (prices, counts, times) change between repeats of the same problem.
    const key = `${kind}:${String(message).replace(/\d+(\.\d+)?/g, '#')}`;
    const last = lastSent.get(key);
    const throttled = last !== undefined && at.getTime() - last < throttleMinutes * 60000;
    try {
      const dir = path.join(home, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `alerts-${dayKey(at)}.jsonl`), `${JSON.stringify({ at: at.toISOString(), kind, message, sent: !throttled && Boolean(webhook || command) })}\n`);
    } catch (_err) {
      // best effort
    }
    if (throttled) return false;
    lastSent.set(key, at.getTime());
    if (webhook) post(webhook, { text, content: text });
    if (Array.isArray(command) && command.length) run(command, text);
    return true;
  };
}

function writeHeartbeat(home, info = {}, now = new Date()) {
  try {
    fs.mkdirSync(home, { recursive: true });
    const file = heartbeatFile(home);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: now.toISOString(), pid: process.pid, ...info }));
    fs.renameSync(tmp, file);
  } catch (_err) {
    // the watchdog reports a silent runner either way
  }
}

/**
 * { ok, problems: [..], heartbeat, ageMinutes } for the watchdog. `staleMinutes`:
 * how long without a pass counts as dead (default: 3 bars, at least 5 minutes).
 */
function watchdogStatus(home, { now = new Date(), staleMinutes = 5, killSwitchFile = path.join(home, 'STOP') } = {}) {
  const problems = [];
  let hb = null;
  try {
    hb = JSON.parse(fs.readFileSync(heartbeatFile(home), 'utf8'));
  } catch (_err) {
    problems.push(`no heartbeat at ${heartbeatFile(home)}: the runner is not running, or never ran with this FTH_HOME`);
  }
  const age = hb ? (now.getTime() - Date.parse(hb.at)) / 60000 : null;
  if (hb && !(age <= staleMinutes)) problems.push(`the last runner pass was ${Number.isFinite(age) ? Math.round(age) : '?'} min ago (limit ${staleMinutes}): it died, hung, or lost its connection`);
  if (fs.existsSync(killSwitchFile)) {
    let why = '';
    try { why = fs.readFileSync(killSwitchFile, 'utf8').trim(); } catch (_err) { /* unreadable */ }
    problems.push(`the kill switch is on (${killSwitchFile}${why ? `: ${why}` : ''}): no new entries until it is removed`);
  }
  return { ok: problems.length === 0, problems, heartbeat: hb, ageMinutes: age === null ? null : Math.round(age * 10) / 10 };
}

module.exports = { createAlerter, postJson, runCommand, writeHeartbeat, watchdogStatus, heartbeatFile };

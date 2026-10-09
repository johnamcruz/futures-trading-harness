#!/usr/bin/env node
/**
 * Append-only news blackouts for the order gate. Agents add windows with this
 * script; it can't remove a future window, so writing blackouts only ever
 * restricts trading. Windows that ended more than a day ago are pruned.
 *
 *   node scripts/blackouts.js add --start 2026-10-14T12:25:00Z --end 2026-10-14T12:40:00Z --reason "CPI"
 *   node scripts/blackouts.js list
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./lib/trading/config');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 12 * 60 * 60 * 1000;

function option(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function readList(file) {
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array`);
  return parsed;
}

/** Merge a new window into the list; returns the list to write. */
function addWindow(list, { start, end, reason }, now = new Date()) {
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw new Error('--start and --end must be ISO times with end after start');
  if (e - s > MAX_WINDOW_MS) throw new Error('a blackout window may be at most 12 hours');
  if (e < now.getTime()) throw new Error('that window has already ended');
  const kept = list.filter(b => !(Date.parse(b && b.end) < now.getTime() - DAY_MS));
  const entry = { start: new Date(s).toISOString(), end: new Date(e).toISOString(), reason: String(reason || '').slice(0, 120) };
  if (!kept.some(b => b.start === entry.start && b.end === entry.end)) kept.push(entry);
  return kept.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

function run(argv, { env = process.env, now = new Date(), out = s => process.stdout.write(s) } = {}) {
  const [cmd, ...args] = argv;
  const file = loadConfig(env).blackoutsFile;
  if (cmd === 'list') {
    out(`${JSON.stringify(readList(file), null, 2)}\n`);
    return 0;
  }
  if (cmd === 'add') {
    const next = addWindow(readList(file), { start: option(args, '--start'), end: option(args, '--end'), reason: option(args, '--reason') }, now);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, file);
    out(`blackouts: ${next.length} window(s) in ${file}\n`);
    return 0;
  }
  throw new Error('usage: blackouts.js add --start <ISO> --end <ISO> --reason <text> | list');
}

if (require.main === module) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[blackouts] ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { addWindow, run };

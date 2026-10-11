'use strict';

/**
 * Append-only news blackouts for the order gate (scripts/blackouts.js). Agents
 * add windows; nothing here removes a future window, so writing blackouts only
 * ever restricts trading. Windows that ended more than a day ago are pruned.
 *
 *   list {}
 *   add  { start, end, reason }   ISO times, end after start, at most 12 hours, not yet ended
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../trading/config');
const { context } = require('./cli');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 12 * 60 * 60 * 1000;

function readList(file) {
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array`);
  return parsed;
}

/** Merge a new window into the list; returns the list to write. */
function addWindow(list, { start, end, reason }, now = new Date(), { tool = false } = {}) {
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw new Error(`${tool ? 'start and end' : '--start and --end'} must be ISO times with end after start`);
  if (e - s > MAX_WINDOW_MS) throw new Error('a blackout window may be at most 12 hours');
  if (e < now.getTime()) throw new Error('that window has already ended');
  const kept = list.filter(b => !(Date.parse(b && b.end) < now.getTime() - DAY_MS));
  const entry = { start: new Date(s).toISOString(), end: new Date(e).toISOString(), reason: String(reason || '').slice(0, 120) };
  if (!kept.some(b => b.start === entry.start && b.end === entry.end)) kept.push(entry);
  return kept.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

function list(_args, ctx) {
  const c = context(ctx);
  // Read the clock as the CLI always has: a refused replay clock refuses the list too.
  c.now();
  const { env } = c;
  return { text: `${JSON.stringify(readList(loadConfig(env).blackoutsFile), null, 2)}\n` };
}

function add({ start, end, reason } = {}, ctx) {
  const c = context(ctx);
  const file = loadConfig(c.env).blackoutsFile;
  const next = addWindow(readList(file), { start, end, reason }, c.now(), { tool: c.tool });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { text: `blackouts: ${next.length} window(s) in ${file}\n` };
}

const OPS = { list, add };

module.exports = { OPS, MAX_WINDOW_MS, readList, addWindow, list, add };

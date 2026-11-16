'use strict';

/**
 * The structure-read dataset (adapters/README.md, "Structure reads"; learning/structure-read.js): for every bar a
 * replay run's cycles recorded a briefing for, one example per instruction: the briefing and the fixed instruction as
 * the prompt, and as the completion a model's answer that verified on every field (`source: model`), else the
 * code-built answer (`source: code`; `gold: false` keeps only verified answers). Model-agnostic chat JSONL
 * (`{ messages: [user, assistant] }`), as the verified-decision dataset (decision-dataset.js), never labelled by outcome.
 *
 * Answers come from any model, outside the harness: `prompts` writes each bar's prompts with their ids (sha256 of the
 * prompt), an operator answers them with the CLI of their choice, and the answers file holds `{ id, text }` lines
 * (several per id allowed: the first that verifies, in file order, is kept; the rest counted). An answer for no prompt
 * of the sources is counted, never used.
 *
 * The rules the decision dataset keeps:
 *   - splits: train from practice-train runs only, validate from practice-validate runs only, a run touching test or
 *     final refused (decision-dataset.js checkSource), and each bar's day inside its set's window;
 *   - the digest: a bar's briefing is the code's output, so only bars of runs made under the harness's code digest now
 *     are kept (its setup record's), the others dropped and counted, unless `include` names them ('any' or a hex
 *     prefix of 8 or more), each marked `current: false` in meta.jsonl;
 *   - duplicates (the same prompt from two runs) dropped, the first kept;
 *   - balance (train only, by bar, both instructions of a bar kept or dropped together): no case (the sequence truth)
 *     over `maxCaseShare` and no regime (pullback, trend, chop, other) over `maxRegimeShare` of the bars (the spec's
 *     structureRead), by dropping seeded draws; a balance that can't be met refuses the build;
 *   - the fingerprint: sha256 over the data files by name and bytes, with the format version and the instructions.
 *
 *   FORMAT, DATA_FILES
 *   sourceFromRun(runDir)                         { runId, start, end, configHash, digest: { code }, bars: [{ t, day, symbol, briefing }] }
 *   promptLines(sources)                          [{ id, kind, runId, t, prompt }] (one per bar and instruction)
 *   readAnswers(texts)                            Map id -> [text] from answers JSONL texts (a bad line throws)
 *   buildStructureDataset({ train, validate, spec, current, include, answers, gold })   { files, dataset }
 *   fingerprintOf(files), writeDataset(dir, built), readDataset(dir)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const SR = require('./structure-read');
const { roleOf } = require('./splits');
const { checkSource } = require('./decision-dataset');
const { shuffled } = require('../train/decision-points');
const { tradingDayKey } = require('../trading/clock');

// The data's format, named in dataset.json and the fingerprint.
const FORMAT = 'structure-read-v1';
const DATA_FILES = Object.freeze(['train.jsonl', 'valid.jsonl', 'meta.jsonl']);
const SET_ROLE = Object.freeze({ train: 'practice-train', validate: 'practice-validate' });
const HEXISH = /^[0-9a-f]{8,64}$/;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_err) { return d; } };

/** A replay run's recorded briefings, one per bar close and symbol (the first cycle's), oldest first. */
function sourceFromRun(runDir) {
  const manifest = readJson(path.join(runDir, 'manifest.json'), null);
  if (!manifest) throw new Error(`${runDir}: not a replay run dir (no manifest.json)`);
  const setup = readJson(path.join(runDir, 'setup.json'), null);
  const home = path.resolve(runDir, '..', '..');
  const dir = path.join(home, 'logs', 'cycles');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort().flatMap(d => {
    const sub = path.join(dir, d);
    return fs.statSync(sub).isDirectory() ? fs.readdirSync(sub).filter(f => f.endsWith('.json')).sort().map(f => path.join(sub, f)) : [];
  }) : [];
  const seen = new Set();
  const bars = [];
  for (const f of files) {
    const doc = readJson(f, null);
    const t = isObj(doc) && isObj(doc.timing) && typeof doc.timing.barClose === 'string' ? doc.timing.barClose : null;
    const briefing = isObj(doc) ? SR.briefingOf(doc.prompt) : null;
    const symbol = briefing ? SR.symbolOf(briefing) : null;
    if (!t || !briefing || !symbol || !Number.isFinite(Date.parse(t))) continue;
    const key = `${new Date(t).toISOString()}|${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bars.push({ t: new Date(t).toISOString(), day: tradingDayKey(new Date(t)), symbol, briefing });
  }
  bars.sort((a, b) => a.t.localeCompare(b.t));
  const code = setup && !setup.codeChanged && typeof setup.code === 'string' ? setup.code : null;
  return { runId: manifest.runId, start: manifest.start, end: manifest.end, configHash: manifest.hash || null, digest: { code }, bars };
}

function promptLines(sources) {
  return sources.flatMap(s => s.bars.flatMap(b => SR.KINDS.map(kind => {
    const prompt = SR.promptOf(b.briefing, kind);
    return { id: sha(prompt), kind, runId: s.runId, t: b.t, prompt };
  })));
}

function readAnswers(texts) {
  const out = new Map();
  for (const text of texts) {
    String(text).split('\n').forEach((l, i) => {
      if (!l.trim()) return;
      let r;
      try { r = JSON.parse(l); } catch (err) { throw new Error(`answers line ${i + 1}: not JSON`, { cause: err }); }
      if (!isObj(r) || !/^[0-9a-f]{64}$/.test(String(r.id)) || typeof r.text !== 'string') throw new Error(`answers line ${i + 1}: { id (the prompt's sha256), text }`);
      out.set(r.id, [...(out.get(r.id) || []), r.text]);
    });
  }
  return out;
}

function codeStatus(digest, current, include) {
  if (digest && digest.code && digest.code === current.code) return 'current';
  if (include.includes('any')) return 'included';
  if (digest && digest.code && include.some(p => HEXISH.test(p) && digest.code.startsWith(p))) return 'included';
  return 'stale';
}

/** One set's bars as examples: each instruction's verified answer or the code's, with the counts. */
function examplesOf(sources, set, { current, include, answers, gold, used }) {
  const counts = { bars: 0, stale: 0, duplicates: 0, unreadable: { structure: 0, sequence: 0 }, answers: { seen: 0, verified: 0, rejected: 0, extraVerified: 0 }, wrongFields: {}, rejectedWhy: {} };
  const bars = [];
  const seen = new Set();
  for (const s of sources) {
    checkSource(s, set);
    const status = codeStatus(s.digest, current, include);
    for (const b of s.bars) {
      if (roleOf(b.day) !== SET_ROLE[set]) throw new Error(`run ${s.runId}: the bar ${b.t} (${b.day}) is outside the ${set} set's window`);
      if (status === 'stale') { counts.stale += 1; continue; }
      const truth = SR.truthOf(b.briefing);
      const examples = [];
      for (const kind of SR.KINDS) {
        const prompt = SR.promptOf(b.briefing, kind);
        const id = sha(prompt);
        if (seen.has(id)) { counts.duplicates += 1; continue; }
        seen.add(id);
        if (!truth[kind]) { counts.unreadable[kind] += 1; continue; }
        const texts = answers.get(id) || [];
        used.add(id);
        let kept = null;
        for (const text of texts) {
          counts.answers.seen += 1;
          const v = SR.verifyAnswer(text, kind, truth[kind]);
          if (!v.ok) {
            counts.answers.rejected += 1;
            for (const f of v.wrong) counts.wrongFields[`${kind}.${f}`] = (counts.wrongFields[`${kind}.${f}`] || 0) + 1;
            if (!v.wrong.length) counts.rejectedWhy[v.why] = (counts.rejectedWhy[v.why] || 0) + 1;
          } else if (kept) counts.answers.extraVerified += 1;
          else { kept = text; counts.answers.verified += 1; }
        }
        const source = kept !== null ? 'model' : gold ? 'code' : null;
        if (!source) continue;
        const messages = [{ role: 'user', content: prompt }, { role: 'assistant', content: kept !== null ? kept : SR.goldAnswer(kind, truth[kind]) }];
        examples.push({ id, kind, source, messages });
      }
      if (!examples.length) continue;
      counts.bars += 1;
      bars.push({ uid: `${s.runId}|${b.t}|${b.symbol}`, runId: s.runId, t: b.t, day: b.day, symbol: b.symbol, case: truth.case, regime: truth.regime, current: status === 'current', examples });
    }
  }
  return { bars, counts };
}

const countBy = (xs, f) => xs.reduce((m, x) => m.set(f(x), (m.get(f(x)) || 0) + 1), new Map());
const tally = (xs, f) => Object.fromEntries([...countBy(xs, f)].sort(([a], [b]) => String(a).localeCompare(String(b))));
const capFor = (n, total, max) => Math.floor((max * (total - n)) / (1 - max));

function keepOnly(list, pick, n, seed, label) {
  const group = list.filter(pick);
  if (group.length <= n || group.length === list.length) return list;
  const keep = new Set(shuffled(group, `${seed}|${label}`).slice(0, Math.max(0, n)));
  return list.filter(b => !pick(b) || keep.has(b));
}

/** The train bars balanced by case and regime (seeded draws dropped, never one repeated); throws when it can't be met. */
function balanceBars(bars, rules) {
  let list = [...bars].sort((a, b) => a.uid.localeCompare(b.uid));
  const sorted = list;
  const keys = [['case', rules.maxCaseShare], ['regime', rules.maxRegimeShare]];
  // Each round only drops bars, so it ends once a round drops none.
  for (;;) {
    const before = list.length;
    for (const [k, max] of keys) for (const [v, n] of countBy(list, b => b[k])) if (n / list.length > max) list = keepOnly(list, b => b[k] === v, capFor(n, list.length, max), rules.seed, `${k}:${v}`);
    if (list.length === before) break;
  }
  const bad = keys.flatMap(([k, max]) => [...countBy(list, b => b[k])].filter(([, n]) => n / list.length > max + 1e-9).map(([v, n]) => `${k} ${v} at ${Math.round((n / list.length) * 10000) / 10000} over ${max}`));
  if (!list.length || bad.length) throw new Error(`the structure-read balance can't be met (${bad.join('; ') || 'no bars'}): add sources (more runs, days or regimes)`);
  const report = xs => ({ n: xs.length, case: tally(xs, b => b.case), regime: tally(xs, b => b.regime) });
  return { kept: list, report: { before: report(sorted), after: report(list) } };
}

function fingerprintOf(files) {
  const h = crypto.createHash('sha256');
  h.update(`${FORMAT}\0${sha(JSON.stringify(SR.INSTRUCTIONS))}\0`);
  for (const name of DATA_FILES) h.update(`${name}\0${files[name] || ''}\0`);
  return h.digest('hex');
}

function validateRules(r) {
  const share = x => typeof x === 'number' && x > 0 && x < 1;
  if (!(isObj(r) && Number.isInteger(r.seed) && share(r.maxCaseShare) && share(r.maxRegimeShare))) throw new Error('the spec\'s structureRead: { seed, maxCaseShare, maxRegimeShare } (shares above 0 and under 1)');
}

function buildStructureDataset({ train = [], validate = [], spec, current, include = [], answers = new Map(), gold = true }) {
  const rules = isObj(spec) ? spec.structureRead : null;
  validateRules(rules);
  if (!train.length) throw new Error('no train sources (practice-train runs)');
  if (!(isObj(current) && /^[0-9a-f]{64}$/.test(String(current.code)))) throw new Error('current: the harness\'s code digest now (learning/adapter.js currentDigests)');
  const bad = include.filter(p => p !== 'any' && !HEXISH.test(p));
  if (bad.length) throw new Error(`include: 'any' or a hex digest prefix of 8 or more (${bad.join(', ')})`);
  const used = new Set();
  const tr = examplesOf(train, 'train', { current, include, answers, gold, used });
  const va = examplesOf(validate, 'validate', { current, include, answers, gold, used });
  if (!tr.bars.length) throw new Error(`no train bar gives an example (${tr.counts.stale} under another code digest: rerun on this harness or include it by name)`);
  const bal = balanceBars(tr.bars, rules);
  const ex = bars => shuffled(bars.flatMap(b => b.examples.map(x => ({ ...x, bar: b }))), `${rules.seed}|order`);
  const t = ex(bal.kept);
  const v = ex(va.bars);
  const line = x => `${JSON.stringify({ messages: x.messages })}\n`;
  const meta = (x, file) => ({ id: x.id, file, kind: x.kind, source: x.source, run: x.bar.runId, t: x.bar.t, day: x.bar.day, symbol: x.bar.symbol, case: x.bar.case, regime: x.bar.regime, current: x.bar.current });
  const files = { 'train.jsonl': t.map(line).join(''), 'valid.jsonl': v.map(line).join(''), 'meta.jsonl': [...t.map(x => meta(x, 'train.jsonl')), ...v.map(x => meta(x, 'valid.jsonl'))].map(m => `${JSON.stringify(m)}\n`).join('') };
  const coverage = xs => ({ n: xs.length, kind: tally(xs, x => x.kind), source: tally(xs, x => `${x.kind}:${x.source}`), case: tally(xs, x => x.bar.case), regime: tally(xs, x => x.bar.regime) });
  const dataset = {
    type: FORMAT, format: 'chat-jsonl', fingerprint: fingerprintOf(files), rules, gold,
    instructions: Object.fromEntries(SR.KINDS.map(k => [k, sha(SR.INSTRUCTIONS[k])])), harness: { code: current.code }, include,
    sources: [...train.map(s => ({ set: 'train', runId: s.runId, configHash: s.configHash || null, window: [s.start, s.end], bars: s.bars.length })),
      ...validate.map(s => ({ set: 'validate', runId: s.runId, configHash: s.configHash || null, window: [s.start, s.end], bars: s.bars.length }))],
    counts: { train: tr.counts, validate: va.counts, unmatchedAnswers: [...answers.keys()].filter(id => !used.has(id)).length },
    balance: bal.report, coverage: { train: coverage(t), validate: coverage(v) },
  };
  return { files, dataset };
}

/** Written as the decision dataset writes its own (decision-dataset.js writeDataset): a new folder only. */
const writeDataset = (dir, built) => require('./decision-dataset').writeDataset(dir, built);

function readDataset(dir) {
  const dataset = JSON.parse(fs.readFileSync(path.join(dir, 'dataset.json'), 'utf8'));
  if (!isObj(dataset) || dataset.type !== FORMAT) throw new Error(`${dir}: not a ${FORMAT} dataset`);
  const files = Object.fromEntries(DATA_FILES.map(n => [n, fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), 'utf8') : '']));
  if (fingerprintOf(files) !== dataset.fingerprint) throw new Error(`${dir}: its files don't match its fingerprint (changed since the build, or built under other instructions)`);
  return dataset;
}

module.exports = { FORMAT, DATA_FILES, sourceFromRun, promptLines, readAnswers, codeStatus, balanceBars, buildStructureDataset, fingerprintOf, writeDataset, readDataset };

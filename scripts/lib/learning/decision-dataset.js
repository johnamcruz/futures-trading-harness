'use strict';

/**
 * The verified-decision dataset (docs/TRAINING.md, "Fine-tuning on verified decisions"; adapters/README.md): the
 * decisions the code verified correct (learning/decision-label.js, by process, never by outcome), written as
 * model-agnostic chat JSONL for a LoRA adapter, under the training spec (adapters/spec.json, learning/adapter.js).
 *
 * Sources: replay runs (or a sampler's point runs, learning/decision-sampler.js), each read through
 * learning/decision-examples.js runDecisions. The train set takes practice-train runs only, the validate set
 * practice-validate runs only; a run touching test or final (sealed) is refused, as is a decision whose day is outside
 * its set's window. Each decision records the skills, prompt and code digests its run was made under (its setup
 * record's documents and code: a briefing or prompt-layout change is code) and its run's exit plan (the manifest's exit
 * record); by default only those made under the harness's digests now (`current`) are kept, the others dropped and
 * counted (dataset.json `digests.stale`): decisions made under old wording teach rules that no longer exist. `include`
 * keeps others by name ('any', or a digest prefix), each marked in meta.jsonl (`digest.current: false`). A run without
 * an exit-plan record is dropped and counted (`untaggedExit`), and decisions made under two exit plans are never mixed
 * (refused). Only the head trader's turns are examples by default: a subagent's claims are checked by nothing, so its
 * turns come only when named (`roles`), marked `subagent: true` in meta.jsonl. Sampled moments whose every repeat
 * answered the same are counted (`repeatedSamples`: sampling probably not applied), and the build refused when they are
 * more than half. `validSetups` counts correct takes against correct passes on valid setups (the labeller's lean).
 *
 * Format v2 (FORMAT_VERSION, the spec's dataset.version): each line { messages } in OpenAI-style chat, the head
 * trader's tool calls and their results included (decision-examples.js headMessages).
 *
 * Built (buildDataset), deterministic for the same sources, spec and seed:
 *   1. label every decision; keep the correct ones (stage 1: no account state; stage 2: account state plus risk action)
 *      whose cycle holds no other decision that isn't (a cycle's turns speak for every symbol it decided on)
 *   2. their faithful role turns as examples ({ messages }: the exact prompts the role saw, then its response), each
 *      with its id (sha256 of its messages); duplicates dropped (the first kept), and a decision whose examples are all
 *      duplicates with it
 *   3. the train decisions balanced per stage (balance(): takes against passes within takeShare, no skill or year over
 *      its cap, at least minYears years, and in stage 2 at least minNearMllShare of the decisions near the max loss
 *      limit), by dropping seeded draws of the over-represented, never by repeating one; a constraint that can't be met
 *      refuses the build
 *   4. two-step files (spec steps): step1/train.jsonl and step1/valid.jsonl (stage 1), step2/train.jsonl (stage 2 plus
 *      the spec's mixStage1 slice of step 1's train examples, seeded) and step2/valid.jsonl (stage 2); meta.jsonl (each
 *      example's file, stage, role, source run, sample, decision and the label's reasons); dataset.json
 *   5. the fingerprint: sha256 over the data files and meta.jsonl (by name and bytes), with the source runs in dataset.json
 *
 *   REFUSED_ROLES
 *   checkSource(source, set)                  throws unless every day of the run is its set's window
 *   examplesOf(decision, roles)               [{ id, role, subagent, messages }] of its faithful turns of those roles
 *   repeatedSamples(sources)                  { moments, identical, times }: moments every repeat answered the same
 *   dedupe(examples)                          { kept, dropped }
 *   balance(decisions, rules, { stage, seed }) { kept, dropped, report } (throws when a constraint can't be met)
 *   buildDataset({ train, validate, spec, rules, current, include, roles })   { files: { name: text }, dataset }
 *   digestStatus(digest, current, include)   'current' | 'included' | 'stale' (skills, prompt and code digests)
 *   deliveryOf(setup, runCfg)                 the head trader's delivery keys a run was made under ('a,b'), or null:
 *                                             decisions under two are never pooled (refused), as two exit plans
 *   fingerprintOf(files)                      sha256 hex over the data files
 *   writeDataset(dir, built), readDataset(dir)
 *   scorer({ root, env })                     runDir -> its scorecard records: its scorecard.jsonl when written after the
 *                                             run's last step (scripts/replay.js scorecard, under the look it was allowed),
 *                                             else replay/scorecard.js scoreRun (a tuning look)
 *   sourceFromRun(dir, { score })             a run as a source: { runId, start, end, configHash, documents, decisions }
 *   sourceFromSamples(file, { score })        a sampler's samples.jsonl as one source (each point run's decisions at the
 *                                             times it ran, each naming its sample)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { assertUse, roleOf } = require('./splits');
const { labelDecision } = require('./decision-label');
const { validateSpec } = require('./adapter');
const { shuffled } = require('../train/decision-points');

const REFUSED_ROLES = Object.freeze(['test', 'final']);
// The data's format version: 2 holds the head trader's tool calls and their results (decision-examples.js
// headMessages); the spec names it (adapters/spec.json dataset.version) and the fingerprint covers it.
const FORMAT_VERSION = 2;
const { HEAD_ROLE } = require('./decision-examples');
const USE = Object.freeze({ train: 'practice', validate: 'validate' });
const DATA_FILES = Object.freeze(['step1/train.jsonl', 'step1/valid.jsonl', 'step2/train.jsonl', 'step2/valid.jsonl', 'meta.jsonl']);
const HEX64 = /^[0-9a-f]{64}$/;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

function checkSource(source, set) {
  if (!USE[set]) throw new Error(`no dataset set "${set}" (train, validate)`);
  const { runId, start, end } = source;
  try {
    assertUse(USE[set], new Date(start), new Date(end));
  } catch (err) {
    throw new Error(`run ${runId} refused for the ${set} set: ${err.message}`, { cause: err });
  }
}

/**
 * A decision's faithful turns as examples, of the roles named: by default the head trader's alone. A subagent's claims
 * (an analyst's read) are checked by nothing, so its turns are trained on only when named (`roles`), marked in meta.jsonl.
 */
function examplesOf(decision, roles = [HEAD_ROLE]) {
  return (decision.turns || []).filter(t => t && t.faithful && Array.isArray(t.messages) && (roles.includes('all') || roles.includes(t.role)))
    .map(t => ({ id: sha(JSON.stringify(t.messages)), role: t.role, subagent: t.role !== HEAD_ROLE, messages: t.messages }));
}

/** The head trader's response at a decision (its messages after the prompt), for the repeated-samples check. */
function headResponse(d) {
  const t = (d.turns || []).find(x => x && x.role === HEAD_ROLE && Array.isArray(x.messages));
  return t ? JSON.stringify(t.messages.slice(t.messages.findIndex(m => m.role === 'user') + 1)) : null;
}

/**
 * The sampled moments whose K head responses are all identical (sampling probably not applied): { moments, identical,
 * times }. A moment is a source's sample time with two or more repeats that answered.
 */
function repeatedSamples(sources) {
  const byMoment = new Map();
  for (const s of sources) {
    for (const d of s.decisions) {
      if (!d.sample || d.sample.t === undefined) continue;
      const k = `${s.runId}|${d.sample.t}`;
      const m = byMoment.get(k) || new Map();
      if (!m.has(d.sample.repeat)) m.set(d.sample.repeat, headResponse(d));
      byMoment.set(k, m);
    }
  }
  const moments = [...byMoment].filter(([, m]) => m.size >= 2);
  const identical = moments.filter(([, m]) => new Set(m.values()).size === 1 && ![...m.values()].includes(null)).map(([k]) => k);
  return { moments: moments.length, identical: identical.length, times: identical.sort() };
}

function dedupe(examples) {
  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const x of examples) {
    if (seen.has(x.id)) dropped.push(x);
    else kept.push(x);
    seen.add(x.id);
  }
  return { kept, dropped };
}

const countBy = (xs, f) => xs.reduce((m, x) => m.set(f(x), (m.get(f(x)) || 0) + 1), new Map());
const shareOf = (n, total) => (total ? Math.round((n / total) * 10000) / 10000 : 0);
const tally = (xs, f) => Object.fromEntries([...countBy(xs, f)].sort(([a], [b]) => String(a).localeCompare(String(b))));

/** Keep `n` of the decisions `pick` selects (seeded draws), every other decision kept; never the whole list away. */
function keepOnly(list, pick, n, seed, label) {
  const group = list.filter(pick);
  if (group.length <= n || group.length === list.length) return list;
  const keep = new Set(shuffled(group, `${seed}|${label}`).slice(0, Math.max(0, n)));
  return list.filter(d => !pick(d) || keep.has(d));
}

/** The count a group may keep so its share is at most `max` of the whole (the rest unchanged). */
const capFor = (n, total, max) => Math.floor((max * (total - n)) / (1 - max));

function violations(list, rules, stage) {
  const v = [];
  const tp = list.filter(d => d.kind === 'take' || d.kind === 'pass');
  const takes = tp.filter(d => d.kind === 'take').length;
  const [lo, hi] = rules.takeShare;
  if (!tp.length || !takes || takes === tp.length) v.push(`takes and passes both needed (${takes} takes, ${tp.length - takes} passes)`);
  else if (takes / tp.length < lo - 1e-9 || takes / tp.length > hi + 1e-9) v.push(`take share ${shareOf(takes, tp.length)} outside [${lo}, ${hi}]`);
  for (const [k, n] of countBy(list, d => d.skill)) if (n / list.length > rules.maxSkillShare + 1e-9) v.push(`skill ${k} at ${shareOf(n, list.length)} over ${rules.maxSkillShare}`);
  const years = countBy(list, d => d.year);
  // A year's cap applies among two or more years (one year alone is minYears's to allow or refuse).
  if (years.size > 1) for (const [k, n] of years) if (n / list.length > rules.maxYearShare + 1e-9) v.push(`year ${k} at ${shareOf(n, list.length)} over ${rules.maxYearShare}`);
  if (years.size < rules.minYears) v.push(`${years.size} year(s), under ${rules.minYears}`);
  if (stage === 2) {
    const near = list.filter(d => d.accountState === 'near-mll').length;
    if (near / (list.length || 1) < rules.minNearMllShare - 1e-9) v.push(`near the max loss limit at ${shareOf(near, list.length)}, under ${rules.minNearMllShare}`);
  }
  return v;
}

function balance(decisions, rules, { stage = 1, seed = rules.seed } = {}) {
  const sorted = [...decisions].sort((a, b) => String(a.uid).localeCompare(String(b.uid)));
  let list = sorted;
  for (let round = 0; round < 50; round += 1) {
    const before = list.length;
    const tp = list.filter(d => d.kind === 'take' || d.kind === 'pass');
    const takes = tp.filter(d => d.kind === 'take').length;
    const passes = tp.length - takes;
    const [lo, hi] = rules.takeShare;
    if (takes && passes && takes / tp.length > hi) list = keepOnly(list, d => d.kind === 'take', Math.floor((hi * passes) / (1 - hi)), seed, 'take');
    else if (takes && passes && takes / tp.length < lo) list = keepOnly(list, d => d.kind === 'pass', Math.floor((takes * (1 - lo)) / lo), seed, 'pass');
    for (const [k, n] of countBy(list, d => d.skill)) if (n / list.length > rules.maxSkillShare) list = keepOnly(list, d => d.skill === k, capFor(n, list.length, rules.maxSkillShare), seed, `skill:${k}`);
    for (const [k, n] of countBy(list, d => d.year)) if (n / list.length > rules.maxYearShare) list = keepOnly(list, d => d.year === k, capFor(n, list.length, rules.maxYearShare), seed, `year:${k}`);
    if (stage === 2) {
      const near = list.filter(d => d.accountState === 'near-mll').length;
      const m = rules.minNearMllShare;
      if (near && near / list.length < m) list = keepOnly(list, d => d.accountState !== 'near-mll', Math.floor((near * (1 - m)) / m), seed, 'not-near-mll');
    }
    if (list.length === before) break;
  }
  const bad = violations(list, rules, stage);
  if (bad.length) throw new Error(`stage ${stage}: the balance can't be met (${bad.join('; ')}): add sources (more moments, samples or years)`);
  const report = d => ({ n: d.length, kind: tally(d, x => x.kind), skill: tally(d, x => x.skill), year: tally(d, x => x.year), ...(stage === 2 ? { accountState: tally(d, x => x.accountState || 'none') } : {}) });
  const keep = new Set(list);
  return { kept: list, dropped: sorted.filter(d => !keep.has(d)), report: { before: report(sorted), after: report(list) } };
}

/** The correct decisions of one set's sources, with their examples (duplicates dropped across the set). */
function correctOf(sources, set, rules, { current, include = [], roles = [HEAD_ROLE] }) {
  const out = [];
  const labels = { correct: 0, incorrect: 0, unverifiable: 0 };
  const stale = { examples: 0, decisions: 0, included: 0 };
  // The bias the labeller leaves: on a valid setup a take can be verified correct, a pass almost never (only when the
  // account or a mechanical step calls for it). Counted so the set's lean is seen, never hidden.
  const validSetups = { correctTakes: 0, correctPasses: 0 };
  const untagged = { decisions: 0, examples: 0 };
  for (const s of sources) {
    checkSource(s, set);
    const labelled = s.decisions.map(d => {
      if (REFUSED_ROLES.includes(roleOf(d.day)) || roleOf(d.day) !== (set === 'train' ? 'practice-train' : 'practice-validate')) throw new Error(`run ${s.runId}: decision ${d.key} on ${d.day} is outside the ${set} set's window`);
      return [d, labelDecision(d, rules)];
    });
    // A cycle's turns speak for every decision in it (one prompt, every symbol): trained on only when all are correct.
    const cycleOf = d => (d.cycle ? `${d.sample ? `${d.sample.t}|${d.sample.repeat}` : 'run'}|${d.cycle}` : null);
    const mixed = new Set(labelled.filter(([d, l]) => l.label !== 'correct' && cycleOf(d)).map(([d]) => cycleOf(d)));
    for (const [d, l] of labelled) {
      labels[l.label] += 1;
      if (l.label !== 'correct' || mixed.has(cycleOf(d))) continue;
      if (d.record && d.record.ok === true && d.kind === 'take') validSetups.correctTakes += 1;
      if (d.record && d.record.ok === true && d.kind === 'pass') validSetups.correctPasses += 1;
      // A run without its exit-plan record: the exit it was made under can't be told, so it can't be kept apart.
      if (!(d.digest && d.digest.exitPlan)) { untagged.decisions += 1; untagged.examples += examplesOf(d, roles).length; continue; }
      // The skills, prompt and code digest the decision was made under: only the harness's now, unless included by name.
      const status = digestStatus(d.digest, current, include);
      if (status === 'stale') { stale.decisions += 1; stale.examples += examplesOf(d, roles).length; continue; }
      if (status === 'included') stale.included += examplesOf(d, roles).length;
      out.push({ ...d, digestStatus: status, uid: `${s.runId}|${d.sample ? `${d.sample.t}|${d.sample.repeat}` : 'run'}|${d.key}`, source: s.runId, label: l });
    }
  }
  const all = out.flatMap(d => examplesOf(d, roles).map(x => ({ ...x, decision: d })));
  const { kept, dropped } = dedupe(all);
  const byDecision = new Map();
  for (const x of kept) byDecision.set(x.decision, [...(byDecision.get(x.decision) || []), x]);
  return { decisions: [...byDecision.keys()].map(d => ({ ...d, examples: byDecision.get(d) })), labels, duplicates: dropped.length, stale, validSetups, untagged };
}

const HEXISH = /^[0-9a-f]{8,64}$/;
/**
 * A decision's digest against the harness's now: 'current' (its skills, prompt and code digests all the harness's: a
 * briefing or prompt-layout change is code), 'included' (another, named by the operator: 'any', or a hex prefix of 8 or
 * more of its skills, prompt or code digest), else 'stale'. A decision with no digest (a run without its setup record)
 * is stale unless 'any' includes it.
 */
const DIGEST_KEYS = ['skills', 'prompt', 'code'];
function digestStatus(digest, current, include = []) {
  if (digest && DIGEST_KEYS.every(k => digest[k] && digest[k] === current[k])) return 'current';
  if (include.includes('any')) return 'included';
  if (digest && include.some(p => HEXISH.test(p) && DIGEST_KEYS.some(k => digest[k] && String(digest[k]).startsWith(p)))) return 'included';
  return 'stale';
}

const line = x => `${JSON.stringify({ messages: x.messages })}\n`;
const metaOf = (x, file, stage) => ({
  // subagent: an analyst's or other subagent's turn, its claims checked by nothing (included only by --roles).
  id: x.id, file, stage, role: x.role, subagent: x.subagent === true, source: x.decision.source, sample: x.decision.sample || null,
  decision: { key: x.decision.key, kind: x.decision.kind, action: x.decision.action, skill: x.decision.skill, accountState: x.decision.accountState, year: x.decision.year },
  label: x.decision.label.reasons,
  // The skills and prompt digest it was made under; `current: false` marks one included under another digest by name.
  digest: { ...Object.fromEntries([...DIGEST_KEYS, 'exitPlan'].map(k => [k, x.decision.digest ? x.decision.digest[k] || null : null])), ...(x.decision.digest && x.decision.digest.delivery ? { delivery: x.decision.digest.delivery } : {}), current: x.decision.digestStatus === 'current' },
});

function fingerprintOf(files) {
  const h = crypto.createHash('sha256');
  h.update(`format v${FORMAT_VERSION}\0`);
  for (const name of DATA_FILES) h.update(`${name}\0${files[name] || ''}\0`);
  return h.digest('hex');
}

function buildDataset({ train = [], validate = [], spec, rules, current, include = [], roles = [HEAD_ROLE] }) {
  const errs = validateSpec(spec);
  if (errs.length) throw new Error(`the training spec is invalid: ${errs.join('; ')}`);
  if (spec.dataset.version !== FORMAT_VERSION) throw new Error(`the spec's dataset.version is ${spec.dataset.version}, the builder writes ${FORMAT_VERSION}`);
  if (!train.length) throw new Error('no train sources (practice-train runs or samples)');
  if (!(current && DIGEST_KEYS.every(k => HEX64.test(String(current[k]))))) throw new Error('current: the harness\'s skills, prompt and code digests now (learning/adapter.js currentDigests)');
  const bad = include.filter(p => p !== 'any' && !HEXISH.test(p));
  if (bad.length) throw new Error(`include: 'any' or a hex digest prefix of 8 or more (${bad.join(', ')})`);
  if (!(Array.isArray(roles) && roles.length && roles.includes(HEAD_ROLE))) throw new Error(`roles: the head trader (${HEAD_ROLE}) and any subagent named to include ('all' for every one)`);
  // Sampling probably not applied: every repeat of a moment answered the same. Refused when it is most moments.
  const repeated = repeatedSamples([...train, ...validate]);
  if (repeated.moments && repeated.identical * 2 > repeated.moments) throw new Error(`${repeated.identical} of ${repeated.moments} sampled moments answered identically in every repeat: sampling was probably not applied (check the sampling settings reached the model server)`);
  const b = spec.balance;
  const tr = correctOf(train, 'train', rules, { current, include, roles });
  const va = correctOf(validate, 'validate', rules, { current, include, roles });
  // One exit plan: examples made under different exits are never mixed (the run's manifest exit record, #207).
  const plans = [...new Set([...tr.decisions, ...va.decisions].map(d => d.digest.exitPlan))];
  if (plans.length > 1) throw new Error(`the correct decisions were made under ${plans.length} exit plans (${plans.map(x => x.slice(0, 12)).join(', ')}): build from runs under one exit plan`);
  // One head trader delivery (deliveryOf): decisions made with its skills or data delivered another way are never pooled.
  const deliveries = [...new Set([...tr.decisions, ...va.decisions].map(d => d.digest.delivery || 'none'))];
  if (deliveries.length > 1) throw new Error(`the correct decisions were made under ${deliveries.length} head trader deliveries (${deliveries.join(' | ')}; the runner config's ${require('../autotrader').HEAD_DELIVERY_KEYS.join(', ')}): build from runs under one`);
  if (!tr.decisions.length && tr.stale.decisions) throw new Error(`every correct train decision was made under another skills or prompt digest than the harness's now (${tr.stale.examples} example(s) dropped): rerun the moments on this harness, or include those digests by name`);
  const stageOf = (xs, n) => xs.filter(d => d.stage === n);
  const bal1 = stageOf(tr.decisions, 1).length ? balance(stageOf(tr.decisions, 1), b, { stage: 1 }) : null;
  const bal2 = stageOf(tr.decisions, 2).length ? balance(stageOf(tr.decisions, 2), b, { stage: 2 }) : null;
  if (!bal1) throw new Error('no correct stage-1 decisions in the train sources: step 1 trains on them first');
  const ex = ds => shuffled(ds.flatMap(d => d.examples), `${b.seed}|order`);
  const s1 = ex(bal1.kept);
  const s2 = bal2 ? ex(bal2.kept) : [];
  const mix = spec.steps[1].mixStage1;
  const slice = s2.length ? shuffled(s1, `${b.seed}|mix`).slice(0, Math.min(s1.length, Math.round((s2.length * mix) / (1 - mix)))) : [];
  const step2 = shuffled([...s2.map(x => [x, 2]), ...slice.map(x => [x, 1])], `${b.seed}|step2`);
  const v1 = ex(stageOf(va.decisions, 1));
  const v2 = ex(stageOf(va.decisions, 2));
  const files = {
    'step1/train.jsonl': s1.map(line).join(''), 'step1/valid.jsonl': v1.map(line).join(''),
    'step2/train.jsonl': step2.map(([x]) => line(x)).join(''), 'step2/valid.jsonl': v2.map(line).join(''),
  };
  const meta = [...s1.map(x => metaOf(x, 'step1/train.jsonl', 1)), ...v1.map(x => metaOf(x, 'step1/valid.jsonl', 1)),
    ...step2.map(([x, st]) => metaOf(x, 'step2/train.jsonl', st)), ...v2.map(x => metaOf(x, 'step2/valid.jsonl', 2))];
  files['meta.jsonl'] = meta.map(m => `${JSON.stringify(m)}\n`).join('');
  const fingerprint = fingerprintOf(files);
  const dataset = {
    v: FORMAT_VERSION, fingerprint, format: 'chat-jsonl', toolCalls: true, spec: sha(JSON.stringify(spec)).slice(0, 16), rules, seed: b.seed,
    harness: { skills: current.skills, harness: current.prompt, code: current.code }, exitPlan: plans[0] || null,
    // The head trader's delivery keys its decisions were made under, named only when one is on.
    ...(deliveries[0] && deliveries[0] !== 'none' ? { delivery: deliveries[0] } : {}),
    // The roles trained on (the head trader by default; a subagent only by name, its turns marked in meta.jsonl).
    roles,
    // Decisions dropped because their run has no exit-plan record (its exit can't be told).
    untaggedExit: { train: tr.untagged, validate: va.untagged },
    // Sampled moments whose every repeat answered the same (sampling probably not applied).
    repeatedSamples: repeated,
    // The labeller's lean on valid setups: correct takes against correct passes (a pass is rarely verifiable).
    validSetups: { train: tr.validSetups, validate: va.validSetups },
    // Examples dropped for a stale digest (made under other skills or prompts), and those included under another by name.
    digests: { include, stale: { train: tr.stale.examples, validate: va.stale.examples }, included: { train: tr.stale.included, validate: va.stale.included } },
    sources: [...train.map(s => ({ set: 'train', runId: s.runId, configHash: s.configHash || null, window: [s.start, s.end], samples: s.samples || null })),
      ...validate.map(s => ({ set: 'validate', runId: s.runId, configHash: s.configHash || null, window: [s.start, s.end], samples: s.samples || null }))],
    labels: { train: tr.labels, validate: va.labels }, duplicates: { train: tr.duplicates, validate: va.duplicates },
    balance: { stage1: bal1.report, stage2: bal2 ? bal2.report : null },
    counts: { step1: { train: s1.length, valid: v1.length }, step2: { train: step2.length, stage2: s2.length, stage1Mix: slice.length, valid: v2.length } },
  };
  return { files, dataset };
}

function writeDataset(dir, built) {
  if (fs.existsSync(path.join(dir, 'dataset.json'))) throw new Error(`${dir} already holds a dataset: build into a new folder`);
  for (const [name, text] of Object.entries(built.files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  fs.writeFileSync(path.join(dir, 'dataset.json'), `${JSON.stringify(built.dataset, null, 2)}\n`);
  return path.join(dir, 'dataset.json');
}

/** A built dataset, its fingerprint checked against its files (a file changed since the build is refused). */
function readDataset(dir) {
  const dataset = JSON.parse(fs.readFileSync(path.join(dir, 'dataset.json'), 'utf8'));
  const files = Object.fromEntries(DATA_FILES.map(n => [n, fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), 'utf8') : '']));
  if (isObj(dataset) && dataset.v !== FORMAT_VERSION) throw new Error(`${dir}: a format v${dataset.v} dataset; this harness reads v${FORMAT_VERSION} (with tool calls): rebuild it`);
  if (!isObj(dataset) || fingerprintOf(files) !== dataset.fingerprint) throw new Error(`${dir}: its files don't match its fingerprint (changed since the build)`);
  return dataset;
}

function scorer({ root, env = process.env }) {
  return runDir => {
    const file = path.join(runDir, 'scorecard.jsonl');
    const fresh = fs.existsSync(file) && fs.statSync(file).mtimeMs >= fs.statSync(path.join(runDir, 'manifest.json')).mtimeMs;
    if (fresh) return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const { scoreRun } = require('../replay/scorecard');
    const strategies = require('../trading/strategies').loadStrategies(root, env).strategies;
    const accounts = require('../trading/accounts').loadAccounts(root, env).accounts;
    try {
      return scoreRun(runDir, { strategies, accounts, unfinished: true, look: {} }).records;
    } catch (err) {
      throw new Error(`${runDir}: ${err.message} (write its scorecard under a look the ledger allows: node scripts/replay.js scorecard <run dir> ...)`, { cause: err });
    }
  };
}

const readJsonOr = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_err) { return fallback; } };

/**
 * The head trader's machine-local delivery keys (autotrader.js HEAD_DELIVERY_KEYS) a run was made under, present and
 * truthy: from its setup record's config (cfg.<key>, written at its fresh start) or its runner config as the replay
 * driver wrote it (autotrader.json). 'a,b' in the list's order, or null when none is on (a run's digest then is the one
 * it had before the keys existed). Decisions under two deliveries are never pooled (buildDataset refuses them).
 */
const deliveryOf = (setup, runCfg) => require('../autotrader').headDeliveryOf(setup, runCfg);

function sourceFromRun(runDir, { score, times = null, sample = null }) {
  const manifest = readJsonOr(path.join(runDir, 'manifest.json'), null);
  if (!manifest) throw new Error(`${runDir}: not a replay run dir (no manifest.json)`);
  const setup = readJsonOr(path.join(runDir, 'setup.json'), null);
  const { runDecisions } = require('./decision-examples');
  const documents = setup && setup.documents ? setup.documents : null;
  // Each decision records the skills, prompt and code digests its run was made under (its setup record's; a run whose
  // code changed mid-run has none that holds) and the run's exit plan (its manifest's exit record).
  const { manifestExit } = require('./run-experience');
  const exitPlan = manifestExit(manifest).hash || null;
  const code = setup && !setup.codeChanged && typeof setup.code === 'string' ? setup.code : null;
  // The head trader's machine-local delivery keys it ran under (deliveryOf), named only when one is on.
  // (run-experience.js runDelivery: its setup record and every runner config it ran with; a run under two throws.)
  const delivery = require('./run-experience').runDelivery(runDir, manifest);
  const on = delivery ? { delivery } : {};
  const digest = documents ? { skills: documents.skills || null, prompt: documents.harness || null, code, exitPlan, ...on } : { exitPlan, ...on };
  return {
    runId: manifest.runId, start: manifest.start, end: manifest.end, configHash: manifest.hash || null,
    documents, decisions: runDecisions(runDir, { score, times, sample }).map(d => ({ ...d, digest })),
  };
}

function sourceFromSamples(file, { score }) {
  const { readSamples } = require('./decision-sampler');
  const recs = readSamples(file).filter(r => !r.error && Array.isArray(r.times) && r.times.length);
  if (!recs.length) throw new Error(`${file}: no sample that ran`);
  const parts = recs.map(r => sourceFromRun(r.runDir, { score, times: r.times, sample: { t: r.t, repeat: r.repeat, seed: r.seed, sampling: r.sampling } }));
  const [first] = parts;
  if (parts.some(p => p.runId !== first.runId)) throw new Error(`${file}: samples of more than one base run`);
  return { ...first, decisions: parts.flatMap(p => p.decisions), samples: recs.length };
}

module.exports = { FORMAT_VERSION, DIGEST_KEYS, deliveryOf, repeatedSamples, digestStatus, scorer, sourceFromRun, sourceFromSamples, REFUSED_ROLES, DATA_FILES, checkSource, examplesOf, dedupe, balance, buildDataset, fingerprintOf, writeDataset, readDataset };

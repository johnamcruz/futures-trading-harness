'use strict';

/**
 * The goal regression's tier 2 on Claude Code with prepare ahead (tests/goal/tier2-prepare.goal.js; the world's
 * `claude` option, tests/fixtures/goal-world.js): every Claude Code run of the world played by the fake CLI that keeps
 * sessions as the real one does (fake-claude-sessions.js: --resume --fork-session, the plugin's SessionStart and
 * PreToolUse hooks, dontAsk), so a confirm really forks the prepare's session and the gate reads the fork.
 *
 * The deterministic mock, both phases:
 *   - the prepare: one SCENARIO line per candidate the prepare briefing's "Possible at the next close" lists (its read
 *     in quotes), STAND DOWN and INVALID; it keeps the briefing it was made on (preparedBriefing);
 *   - the head trader's run, a fresh one or the confirm: the world's own plan-following mock (goal-world.js headScript)
 *     on the AT-CLOSE briefing: the candle decides, so "on" trades as "off" does;
 *   - the negative control (`trusting`): a confirm that trusts the plan decides on the briefing the prepare was made on
 *     instead (the prepared facts over the at-close ones), and only at a close whose plan was void, which `voidBypass`
 *     (the runner's validity check broken) lets through to it. tier2-prepare.goal.js shows it makes "on" differ;
 *   - `skipLoads`: a confirm that loads nothing again (the prepare's loads are in its context); `headSkillsInPrompt`
 *     the runner config's key (the head trader's skills embedded and attested).
 *
 *   FAULTS: the fallback rows armed before each pass: session-missing (the prepare's session file gone), corrupt-plan,
 *   confirm-error (the confirm's run fails before a compose), confirm-timeout (it hangs to its bound), pnl-change (the
 *   P&L moves a dollar, in the off world too: every plan void by its facts key).
 *   fakeFor(w), headRunOf(w), runPrepareOf(w, env), beforePass(w), preparedBriefing(w)
 */

const fs = require('fs');
const path = require('path');
const { fakeClaude } = require('./fake-claude-sessions');

const ROOT = path.resolve(__dirname, '..', '..');
const FAULTS = Object.freeze(['session-missing', 'corrupt-plan', 'confirm-error', 'confirm-timeout', 'pnl-change']);

/** The prepare's plan text from its prompt's section (one SCENARIO per listed candidate). */
const planText = prompt => [...String(prompt).matchAll(/^ {2}- (P\d+) \S+ (long|short) "([^"]+)"/gm)]
  .map((m, j) => `SCENARIO ${j + 1}: ${m[1]} "${m[3]}" → TAKE if the closing candle meets the listed trigger | PASS if not; reads: "${m[3]}"; why: the plan-following mock`)
  .concat(['STAND DOWN if: entries close or a news window starts', 'INVALID if: a fill, or the trend rule turns', 'PLAN END']).join('\n');

function fakeFor(w) {
  return fakeClaude({
    dir: path.join(w.home, 'claude-sessions'),
    script: (prompt, env) => {
      if (env.FTH_PREPARE === 'prepare') {
        // The briefing it was made on (the bar it read), kept for the trusting confirm.
        const b = require('../../scripts/lib/trading/briefing').readBriefing(w.home, 'MNQ');
        const next = /the bar opening (\S+) closes at/.exec(prompt);
        if (next && b) (w.claude.prepared = w.claude.prepared || {})[next[1]] = b;
        // The prepare loads what an entry needs (the confirm, a fork, has them in its context).
        return [...require('../../scripts/lib/trading/skills-loaded').REQUIRED_FOR_COMPOSED.map(x => ({ load: x })), { result: planText(prompt) }];
      }
      if (/Your plan said: scenario/.test(prompt)) w.claude.confirms += 1;
      const head = w.claude.head;
      return typeof head === 'function' ? head(prompt, env) : head;
    },
  });
}

/** The briefing the prepare for this close was made on (the trusting confirm's), or null. */
function preparedBriefing(w) {
  const b = require('../../scripts/lib/trading/briefing').readBriefing(w.home, 'MNQ');
  const t = b && b.asOf;
  return (w.claude.prepared || {})[t] || null;
}

/** The head trader's run: the fake CLI; a confirm's run failed or hung by the armed fault. */
function headRunOf(w) {
  return async (argv, o) => {
    if (argv.includes('--resume') && w.claude.fault === 'confirm-error') return { ok: false, timedOut: false, code: 1, output: '', stdout: '' };
    if (argv.includes('--resume') && w.claude.fault === 'confirm-timeout') return { ok: false, timedOut: true, code: null, output: '', stdout: '' };
    return w.claude.fake(argv, o);
  };
}

/** The runner's runPrepare (cycle-run.js), through the same fake CLI. */
const runPrepareOf = (w, env) => (c, kind, prompt, limits) => require('../../scripts/lib/cycle-run').runPrepare(c, kind, prompt, limits, { root: ROOT, home: w.home, env, run: w.claude.fake });

/** Before each pass: the armed fault on every plan file there (session-missing, corrupt-plan); the void bypass. */
function beforePass(w) {
  if (w.claude.voidBypass && !w.claude.bypassed) {
    // The broken runner of the negative control: a void or stale plan treated as valid (in this process: the runner's
    // own check, prepare-shadow.js calls PA.confirmPath): matched, it goes to the confirm.
    const PA = require('../../scripts/lib/prepare-ahead');
    const orig = PA.confirmPath;
    PA.confirmPath = args => {
      const r = orig(args);
      w.claude.bypassNow = false;
      if (r.path !== 'void' && r.path !== 'stale') return r;
      const m = PA.matchScenario(args.plan, args.fired);
      if (m.status !== 'matched' || !args.plan.base) return r;
      w.claude.voidConfirms = (w.claude.voidConfirms || 0) + 1;
      // The trusting confirm trusts only here (goal-world.js headScript): any divergence is a void plan's.
      w.claude.bypassNow = true;
      // confirmPath's own confirm shape (every matched scenario, the primary first), so the confirm's message builds.
      const matched = PA.matchedScenarios(args.plan, m);
      return { path: 'confirm', match: { k: m.k, id: m.id, read: m.read, side: m.side }, scenario: matched[0].scenario, kind: matched[0].kind, matched, fired: args.fired, unplanned: m.unplanned, bypassed: r.reason || r.path };
    };
    w.claude.bypassed = true;
  }
  // pnl-change: the account's P&L moves by a dollar before each pass (the same in the off world): every plan made
  // before it is void by its facts key (a fill, a position or a P&L change).
  if (w.claude.fault === 'pnl-change') {
    require('./mock-exchange').update(w.state, x => { x.balance += 1; });
    w.claude.armed = (w.claude.armed || 0) + 1;
    return;
  }
  const dir = path.join(w.home, 'prepare');
  if (!fs.existsSync(dir) || !['session-missing', 'corrupt-plan'].includes(w.claude.fault)) return;
  for (const f of fs.readdirSync(dir).filter(x => /^MNQ-.*\.json$/.test(x))) {
    const file = path.join(dir, f);
    if (w.claude.fault === 'corrupt-plan') { if (fs.readFileSync(file, 'utf8') !== '{"v":1,') { fs.writeFileSync(file, '{"v":1,'); w.claude.armed = (w.claude.armed || 0) + 1; } continue; }
    try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); if (p.session && p.session.transcript && fs.existsSync(p.session.transcript)) { fs.rmSync(p.session.transcript, { force: true }); w.claude.armed = (w.claude.armed || 0) + 1; } } catch (_err) { /* already corrupt */ }
  }
}

module.exports = { FAULTS, planText, fakeFor, headRunOf, runPrepareOf, beforePass, preparedBriefing };

'use strict';

// The autonomous-trading skill was split by job: autonomous-trading keeps the cycle every autonomous run follows (one
// bounded cycle per bar, no questions, positions first and what the prompt carries, guardrails, the result line, the
// read budget, harness tools); runner-lanes takes several lanes, analysts on their own timeframe and the policy
// priority; kill-switch the kill switch, the broker allow-list and the account lock; runner-logs where the runner's
// logs and session records are. This test proves nothing was lost or doubled: every sentence (and every code line) of
// the skill as it was (tests/fixtures/skill-split/autonomous-trading.before.txt, frozen) is in the new homes exactly
// as many times as before, byte-for-byte after whitespace is normalised, in its old order within each home. The only
// exceptions are listed, each with its reason: text that restated trade-session is now a pointer to it. An exception
// that no longer differs fails too, so the list can only shrink.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { units, differences, STRUCTURE } = require('./skill-split');
const { orderErrors } = require('./skill-split-order');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const flat = s => s.replace(/\s+/g, ' ');

// skills/autonomous-trading/SKILL.md as main had it before the split (at e7433091): pinned, so a sentence can't be
// dropped from the fixture and from its new home together.
const BEFORE = 'tests/fixtures/skill-split/autonomous-trading.before.txt';
const BEFORE_SHA256 = '498687248447a47507de60e2ac2a6720d83c128e3e812100b919a1100e343717';
const HOMES = ['autonomous-trading', 'runner-lanes', 'kill-switch', 'runner-logs'];

// Deliberate differences, each with its reason: the head trader loads trade-session every cycle (the order gate
// requires it), so what it already teaches is a pointer here, never a second copy.
const ALLOWED = [
  { old: '**Analysts on their own timeframe.** When the prompt says "Each analyst reads its own timeframe" (e.g. trend-momentum-analyst on 15m, volume-liquidity-analyst on 1h), pass each named analyst its timeframe with the symbol (trade-session step 2).',
    now: '**Analysts on their own timeframe.** When the prompt says "Each analyst reads its own timeframe", run them as trade-session step 2 says ("An analyst on its own timeframe").',
    reason: 'trade-session step 2 ("An analyst on its own timeframe") teaches it: a pointer' },
  { old: 'Its cached report says "(15m, from 10:45 ET, holds until 11:00 ET)": it rests on its own bar and may be up to one of its bars old, so this bar\'s facts come from the bar briefing.',
    copies: 0, reason: 'trade-session step 2: such a report holds until its own next bar close, and this bar\'s facts come from the briefing' },
  { old: 'Merge every analyst\'s latest report and decide once.',
    copies: 0, reason: 'trade-session step 2: "You merge every analyst\'s latest report and decide once for the cycle."' },
  { old: 'A rules strategy\'s signal expires 3 bars of its own timeframe after its bar closed, never more than 45 minutes (3 min on 1m, 9 min on 3m), so a 1m setup can\'t wait.',
    now: 'A rules strategy\'s signal expires as trade-session step 2 says (the trigger check), so a 1m setup can\'t wait.',
    reason: 'the expiry is trade-session step 2\'s trigger check ("The trigger is checked too"): a pointer, keeping the lane fact' },
  { old: 'Every entry carries its stop bracket; a refused entry (`success: false` with an `errorCode` other than 6 (`OrderPending`) or 7 (`UnknownError`), its brackets included) ends the cycle as `blocked` with the broker\'s message, journalled, and is never sent again without its bracket.',
    now: 'A refused entry, or one whose reply was an error, is handled as trade-session step 6 says (a refusal ends the cycle `blocked`).',
    reason: 'trade-session step 6 teaches the refusal (cycle result `blocked`, never re-sent without its bracket): a pointer' },
  { old: 'Any other error on an entry (codes 6 and 7 included) is an unknown outcome, not a refusal: read positions and orders at once, protect or close any position without a covering stop first, and never re-send it.',
    copies: 0, reason: 'trade-session step 6 teaches the unknown outcome; folded into the pointer above' },
];

const homeTexts = () => HOMES.map(s => read(`skills/${s}/SKILL.md`));
const at = name => HOMES.indexOf(name);

test('autonomous-trading split: every unit of the old skill is in exactly one new home, in its old order', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, BEFORE))).digest('hex');
  assert.strictEqual(sha, BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  assert.deepStrictEqual(differences(read(BEFORE), homeTexts(), ALLOWED), []);
  assert.deepStrictEqual(orderErrors(read(BEFORE), homeTexts(), HOMES, ALLOWED), [], 'moved text keeps its old order in each home');
  for (const a of ALLOWED) assert.ok(a.reason, a.old);
});

test('autonomous-trading split: the comparison catches a lost, a doubled, an edited or a reordered sentence', () => {
  const old = read(BEFORE);
  const u = units(old);
  assert.ok(u.length > 70, `the units are fine-grained (${u.length})`);
  assert.ok(u.includes('Preflight reports it as a failed `account lock` check.'), 'a sentence is a unit');
  assert.ok(u.includes('CYCLE RESULT: blocked - [loss-streak] cooldown 18 min'), 'a code line is a unit');
  const homes = homeTexts();
  const swap = (name, text) => homes.map((h, i) => (i === at(name) ? text : h));
  const S = 'Preflight reports it as a failed `account lock` check.';
  const ks = homes[at('kill-switch')];
  assert.ok(ks.includes(S));
  // Lost, doubled, edited.
  assert.notDeepStrictEqual(differences(old, swap('kill-switch', ks.replace(S, '')), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap('runner-logs', `${homes[at('runner-logs')]}\n${S}\n`), ALLOWED), []);
  const edited = ks.replace('the runner starts only\nmanage cycles', 'the runner starts\nmanage cycles');
  assert.notStrictEqual(edited, ks);
  assert.notDeepStrictEqual(differences(old, swap('kill-switch', edited), ALLOWED), []);
  // Reordered: the two paragraphs swapped (nothing lost, the order changed).
  const P1 = /\*\*Kill switch\.\*\*[^]*?\n\n/.exec(ks)[0];
  const P2 = /\*\*One runner per broker account\.\*\*[^]*?\n\n/.exec(ks)[0];
  const swapped = ks.replace(P1, '\u0000').replace(P2, P1).replace('\u0000', P2);
  assert.notStrictEqual(swapped, ks);
  assert.deepStrictEqual(differences(old, swap('kill-switch', swapped), ALLOWED), [], 'a swap loses nothing');
  assert.notDeepStrictEqual(orderErrors(old, swap('kill-switch', swapped), HOMES, ALLOWED), [], 'but changes the order');
  // A pointer reverted to the text it replaced (the exception no longer needed) also fails: the list only shrinks.
  const loose = s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
  const lanes = homes[at('runner-lanes')];
  const reverted = lanes.replace(loose(ALLOWED[3].now), ALLOWED[3].old);
  assert.notStrictEqual(reverted, lanes);
  assert.notDeepStrictEqual(differences(old, swap('runner-lanes', reverted), ALLOWED), []);
  // A section heading dropped: each new skill keeps the format's three sections.
  assert.notDeepStrictEqual(differences(old, swap('runner-logs', homes[at('runner-logs')].replace('## Examples', '## Example')), ALLOWED), []);
});

test('autonomous-trading split: each skill has a short "Use when" index line, and autonomous-trading points to the rest', () => {
  for (const s of HOMES) {
    const d = parseFrontmatter(read(`skills/${s}/SKILL.md`)).data.description;
    assert.ok(d.length <= 160, `${s}: description ${d.length} chars, over 160`);
    assert.match(d, /^Use when /, s);
  }
  const core = flat(read('skills/autonomous-trading/SKILL.md'));
  for (const s of HOMES.slice(1)) assert.match(core, new RegExp(`the \`${s}\` skill`), `autonomous-trading points to ${s}`);
  // The moved jobs left the core: lanes, the kill switch and the lock, the logs.
  assert.doesNotMatch(core, /\*\*Several lanes\.\*\*|<FTH_HOME>\/STOP|One runner per broker account|scans-<day>\.jsonl|gate-log\.jsonl/);
  // Its rule numbers stay (rule 1, rule 4 are named in its text), and the result line is still its own.
  assert.match(core, /5\. \*\*Kill switch and account lock\.\*\* An entry refused with `\[kill-switch\]`, `\[allowed-accounts\]` or `\[account-lock\]`: the `kill-switch` skill\./);
  assert.match(core, /`CYCLE RESULT: <[^>]+> - <reason>`/);
});

test('autonomous-trading split: the pointers are true (trade-session step 2 and step 6 hold what was dropped)', () => {
  const ts = read('skills/trade-session/SKILL.md');
  const step = n => flat(new RegExp(`### ${n}\\. [^]*?(?=\\n### |\\n## )`).exec(ts)[0]);
  const s2 = step(2);
  assert.match(s2, /\*\*An analyst on its own timeframe\.\*\* When the prompt says "Each analyst reads its own timeframe"/);
  assert.match(s2, /holds until its own timeframe's next bar close, so it may be up to one of its bars old/);
  assert.match(s2, /You merge every analyst's latest report and decide once for the cycle\./);
  assert.match(s2, /\*\*The trigger is checked too\.\*\*[^]*?3 bars of its own timeframe ago, and never more than 45 minutes ago \(3 min on 1m, 9 min on 3m/);
  const s6 = step(6);
  assert.match(s6, /`success: false` with an `errorCode` other than 6 \(`OrderPending`\) or 7 \(`UnknownError`\), its brackets included[^]*?\(cycle result `blocked`\); never send the entry again without its bracket/);
  assert.match(s6, /Any other error \(codes 6 and 7 included[^)]*\) is an unknown outcome, not a refusal[^]*?protects or closes any position without a covering stop first, and never re-sends the entry/);
});

test('autonomous-trading split: the per-cycle load shrinks; no role and no gate list changes', () => {
  // The head trader loads autonomous-trading every cycle, and reads every skill's index line (workspace/AGENTS.md).
  // The core and the four index lines together are smaller than the old skill and its one line.
  const indexLine = text => {
    const { data } = parseFrontmatter(text);
    return `- \`${data.name}\` (skills/${data.name}/SKILL.md): ${data.description}`;
  };
  const before = read(BEFORE).length + indexLine(read(BEFORE)).length;
  const after = read('skills/autonomous-trading/SKILL.md').length + homeTexts().reduce((n, t) => n + indexLine(t).length + 1, -1);
  assert.ok(after < before, `the core and the index lines are ${after} characters, not under the old ${before}`);
  const agents = read('workspace/AGENTS.md');
  for (const t of homeTexts()) assert.ok(agents.includes(indexLine(t)), `AGENTS.md lists ${parseFrontmatter(t).data.name}`);
  // No role's body uses the new skills: none loads or indexes them, so no role's prompt grows.
  const { loadRoles } = require('../../scripts/lib/role-skills');
  for (const a of loadRoles(ROOT)) for (const s of HOMES) assert.ok(!a.skills.includes(s) && !a.index.includes(s), `${a.name}: ${s}`);
  // The gate's skill lists are unchanged: the core stays out of them (the prompt says to follow it), and so do the pieces.
  const { REQUIRED_FOR_ENTRY, SITUATIONAL } = require('../../scripts/lib/trading/skills-loaded');
  assert.deepStrictEqual(REQUIRED_FOR_ENTRY, ['trade-session', 'multi-timeframe-analysis', 'strategy-library']);
  for (const s of HOMES) assert.ok(!SITUATIONAL.some(x => x.skill === s), s);
  // Every prompt still names the core.
  const A = require('../../scripts/lib/autotrader');
  const p = A.prompts(A.validateConfig({}), new Date('2026-10-07T14:30:00Z'));
  assert.match(p.trade([{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z', c: 1, file: '/b.json', contractId: 'MNQ' } }]), /Follow the autonomous-trading skill\./);
  for (const s of STRUCTURE) for (const t of homeTexts()) assert.ok(t.includes(`## ${s}`));
});

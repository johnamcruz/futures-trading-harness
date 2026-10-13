'use strict';

// The harness is platform-neutral (CLAUDE.md, "Separation of work" and the ECC hard rules): no
// platform-, firm- or model-specific code, names, env vars, defaults, contract-id formats or paths.
// Platform specifics live in the broker's MCP server (its own repo), firm rules in accounts/, model
// specifics in the user's local config; mcp-configs/brokers.json is the one link.
//
// Every file `git ls-files -co --exclude-standard` lists is scanned (platform-scan.js): NFKC-normalized,
// format characters stripped, Greek and Cyrillic look-alikes folded, case-insensitive, for platform, firm
// and model names, model sizes and a firm's times in any common form.
// Allowed for good: accounts/ (the firms' rule documents), mcp-configs/brokers.json, the scanner and
// this test, and the PERMANENT lines below. SHRINK_ONLY lists what predates the rule, by file and kind;
// no-platform-specifics.pins.json pins a hash of every line each entry excuses. A new entry, or a new or
// changed excused line, fails here; and the pins must stay within the base branch's
// (`git merge-base HEAD origin/main`: every key there, every line there), so a hand edit that adds a
// key or a line fails too, and a base that can't be read fails closed (CI checks out with fetch-depth: 0).
//
// Recording a legitimate shrink (lines removed or reworded away): run
//   FTH_UPDATE_PINS=1 node --test tests/plugin/no-platform-specifics.test.js
// It only removes lines (the new set within the old), and drops the pin of an entry that excuses
// nothing (then delete that entry from SHRINK_ONLY). A reworded excused line is a new line: it can't be
// recorded; take the firm name, account name or time out of it instead. Never add to the list.
//
// The word `qwen` alone is allowed: Qwen Code is a CLI the harness has an adapter for (qwen-extension/,
// QWEN.md, harness "qwen"). Model names and sizes (qwen3, Qwen 2.5, Qwen3.5-9B, 9B, 3.5B) are not.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require('./platform-scan');

const REPO = path.resolve(__dirname, '..', '..');
const PINS = path.join(__dirname, 'no-platform-specifics.pins.json');

const ALLOWED = [/^accounts\//, /^mcp-configs\/brokers\.json$/, /^tests\/plugin\/no-platform-specifics\.(?:test\.js|pins\.json)$/, /^tests\/plugin\/platform-scan\.js$/];
const PERMANENT = [
  { file: 'tests/plugin/ecc-architecture.test.js', pattern: /^\s*const BROKER = .*$/, reason: 'the no-broker-code rule: its denylist of broker endpoints and SDKs' },
];

// Firm rules (the firm's trading day, reset and flatten times) and the shipped account names, in code,
// documents, generated files and the tests that pin them: plan C (dynamic prop account) moves them to
// account files and the tests to fixture accounts (tests/fixtures/accounts/).
const REASONS = {
  firm: 'the firm\'s name in harness text (its trading day, reset or flatten)',
  account: 'a shipped account\'s name (an example, a default, or a test tied to the policy strategies\' account)',
  'firm-time': 'the firm\'s reset or flatten time as harness text',
};
const SHRINK_ONLY = [
  ['README.md', 'firm account firm-time'],
  ['commands/trade-review.md', 'firm-time'],
  ['docs/LEARNED-RULEBOOK.md', 'account'],
  ['docs/QUANT-PLAN.md', 'account'],
  ['docs/REASONING-TRADER-DESIGN.md', 'account firm-time'],
  ['mcp-configs/replay.example.json', 'account'],
  ['qwen-extension/QWEN.md', 'firm firm-time'],
  ['qwen-extension/commands/trade-review.md', 'firm-time'],
  ['rules/trading/execution.md', 'firm firm-time'],
  ['rules/trading/prop-firm.md', 'firm firm-time'],
  ['rules/trading/risk-management.md', 'firm-time'],
  ['scripts/hooks/trading-session-start.js', 'firm-time'],
  ['scripts/lib/replay/config.js', 'account'],
  ['scripts/lib/replay/verdict.js', 'firm account firm-time'],
  ['scripts/lib/trading/account-gate.js', 'firm-time'],
  ['scripts/lib/trading/briefing.js', 'firm firm-time'],
  ['scripts/lib/trading/clock.js', 'firm firm-time'],
  ['scripts/lib/trading/mtf.js', 'firm'],
  ['scripts/lib/trading/order-gate.js', 'firm-time'],
  ['scripts/lib/trading/reasons.js', 'account'],
  ['scripts/lib/trading/report-cache.js', 'account'],
  ['scripts/replay.js', 'account'],
  ['skills/end-of-day/SKILL.md', 'firm-time'],
  ['skills/replay/SKILL.md', 'firm account firm-time'],
  ['strategies/README.md', 'account'],
  ['strategies/prop_flow_1m/STRATEGY.md', 'firm account'],
  ['strategies/prop_portfolio/STRATEGY.md', 'firm account'],
  ['tests/e2e/mock-trading-e2e.test.js', 'account'],
  ['tests/e2e/replay-e2e.test.js', 'account'],
  ['tests/hooks/trading-hooks.test.js', 'account'],
  ['tests/lib/account-gate.test.js', 'account'],
  ['tests/lib/autotrader.test.js', 'account firm-time'],
  ['tests/lib/backtest.test.js', 'account'],
  ['tests/lib/clock.test.js', 'firm-time'],
  ['tests/lib/combine.test.js', 'account'],
  ['tests/lib/harness-tools-order-plan.test.js', 'account'],
  ['tests/lib/harness-tools-reasons.test.js', 'account'],
  ['tests/lib/harness-tools.test.js', 'account'],
  ['tests/lib/order-gate.test.js', 'firm-time'],
  ['tests/lib/prop-live-runner.test.js', 'account'],
  ['tests/lib/reasons.test.js', 'account'],
  ['tests/lib/replay-scorecard.test.js', 'account firm-time'],
  ['tests/lib/replay-verdict.test.js', 'account firm-time'],
  ['tests/lib/replay.test.js', 'account'],
  ['tests/lib/report-cache.test.js', 'account'],
  ['tests/lib/strategies.test.js', 'account'],
  ['tests/lib/translator.test.js', 'firm-time'],
  ['tests/plugin/content.test.js', 'firm firm-time'],
  ['tests/scripts/cli-parity.snapshot.json', 'firm account'],
  ['tests/scripts/harness-tools-mcp.test.js', 'account'],
  ['tests/scripts/replay-clock.test.js', 'account'],
  ['workspace/AGENTS.md', 'firm firm-time'],
  ['workspace/QWEN.md', 'firm firm-time'],
].flatMap(([file, kinds, plan = 'plan C (dynamic prop account)']) => kinds.split(' ').map(kind => ({ file, kind, plan, reason: REASONS[kind] })));

const readRepo = f => fs.readFileSync(path.join(REPO, f));

test('no platform, firm or model names, or a firm\'s times, outside accounts/ and mcp-configs/brokers.json (CLAUDE.md, "Separation of work")', () => {
  const { files } = S.listFiles(REPO);
  const r = S.scan(files, readRepo, { allowed: ALLOWED, permanent: PERMANENT, entries: SHRINK_ONLY });
  assert.deepStrictEqual(r.hits, [], 'platform specifics belong in the broker\'s MCP server, firm rules in accounts/, model specifics in local config');
  let pins = JSON.parse(fs.readFileSync(PINS, 'utf8'));
  if (process.env.FTH_UPDATE_PINS === '1') {
    pins = S.updatePins(pins, r.actual); // only removes lines
    fs.writeFileSync(PINS, `${JSON.stringify(pins, null, 2)}\n`);
  }
  assert.deepStrictEqual(S.pinVerdict(SHRINK_ONLY, r.actual, pins, r.permanentUsed), []);
});

test('the pins only shrink against the base branch (git merge-base HEAD origin/main); an unreadable base fails closed', () => {
  const pins = JSON.parse(fs.readFileSync(PINS, 'utf8'));
  const rel = f => path.relative(REPO, f).split(path.sep).join('/');
  const base = S.readBasePins(REPO, rel(PINS), rel(__filename)); // throws when the base can't be read
  assert.deepStrictEqual(S.baseVerdict(pins, base), []);
  // CI has the base: its checkout fetches every branch and its history.
  const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /- uses: actions\/checkout@v\d+\n\s+with:\n(?:\s+#.*\n)*\s+fetch-depth: 0\n/, 'ci.yml: actions/checkout with fetch-depth: 0');
});


test('the scan reads every file git lists: none skipped, no directory, binaries only by extension or a NUL in the first 8 KB', () => {
  const { listed, excluded, files, links, notFiles } = S.listFiles(REPO);
  assert.deepStrictEqual(notFiles, [], 'every listed path is a file or a symlink');
  assert.strictEqual(files.length + links.length + excluded.length, listed.length);
  // A symlink's target is in the repository and listed itself (qwen-extension/ links the canonical folders).
  for (const l of links) {
    const target = path.relative(REPO, fs.realpathSync(path.join(REPO, l)));
    assert.ok(!target.startsWith('..') && (files.includes(target) || files.some(f => f.startsWith(`${target}/`))), `${l} -> ${target}`);
  }
  const r = S.scan(files, readRepo, { allowed: ALLOWED, permanent: PERMANENT, entries: SHRINK_ONLY });
  assert.strictEqual(r.scanned.length + r.binary.length, files.length, 'every file is scanned or a binary');
  assert.ok(r.binary.every(f => S.isBinary(f, readRepo(f))));
  // A text file with a NUL past the first 8 KB is still scanned whole.
  const late = Buffer.concat([Buffer.from(`${'x'.repeat(9000)}\n`), Buffer.from([0]), Buffer.from('\nTopstepX\n')]);
  assert.deepStrictEqual(S.scan(['docs/late.md'], () => late).hits.map(h => h.split(':')[1]), ['3']);
  assert.ok(S.isBinary('data/bars.xlsx', Buffer.from('text')) && S.isBinary('x.txt', Buffer.from([1, 0, 2])) && !S.isBinary('x.md', Buffer.from('text')));
});

test('the scan catches every term alone, look-alike spellings and a firm\'s times; allows the CLI adapter and the allowed places', () => {
  // The terms the rule names, each alone on a line: every one is a hit, whatever TERMS holds.
  const REQUIRED = ['topstep', 'TopstepX', 'projectx', 'PROJECTX_', 'CON.F.', 'auto oco', 'position brackets', 'gateway.docs',
    'api.topstepx', 'userapi', 'signalr', 'mlx', 'mlx_lm', 'qwen3', '9B', 'dashscope', 'Top Step', 'top-step', 'Project X', 'project-x',
    '\uff34\uff4f\uff50\uff53\uff54\uff45\uff50', 'Top\u200bstep', 'pro\u00adjectx', '15:10 CT', '16:10 ET', '17:00 CT',
    // Greek and Cyrillic look-alikes, model names and sizes.
    'T\u043e\u0440\u0455tep', '\u03a4opste\u03c1', 'pro\u0458ect\u03a7', 'Qwen 2.5', 'qwen-2', 'Qwen 9B', 'model 8B', 'a 70B model', '3.5B params', 'Llama 3 8B',
    // A firm's times in other forms.
    '17:00 cst', '17:00 CDT', '16:10 EDT', '15:10 Central', '4:10 pm Eastern', '5 pm Chicago', '5:00 PM CT', '3:10pm ct',
    '1510 CT', '1610 ET', '17:00 America/Chicago', '16:10 New York', '16:10 America/New_York', '17:00@America/Chicago',
    // A firm's flatten on a line that names the exchange is still the firm's.
    'flatten every account at 15:10 CT before the CME close', 'firm flatten 16:10 ET; Globex', '4:10 pm Eastern, before Globex'];
  for (const term of REQUIRED) assert.strictEqual(S.scan(['docs/t.md'], () => Buffer.from(`${term}\n`)).hits.length, 1, JSON.stringify(term));
  for (const t of S.TERMS) assert.match(t.sample, new RegExp(t.re, 'i'), `${t.re} catches its own sample`);
  const files = {
    'skills/x/SKILL.md': 'Place it on TopstepX first.\n',
    'scripts/lib/x.js': "const ENTRY = env.PROJECTX_MCP_ENTRY;\nconst id = 'CON.F.US.MNQ.Z26';\n",
    'skills/ok/SKILL.md': 'Qwen Code reads QWEN.md; harness "qwen"; qwen-extension/; 16:00 ET close; 18:00 ET open; 9b0f1e hex; 16 GB.\n',
    'skills/setups/SKILL.md': 'The 2B reversal setup: a 2B top or bottom. A 1.5B-share day.\n',
    'skills/exchange/SKILL.md': 'CME Globex reopens at 17:00 CT (18:00 ET); Globex closes at 5 pm Central.\n',
    'accounts/firm_50k/ACCOUNT.md': 'Topstep rules, flatten 15:10 CT.\n',
    'mcp-configs/brokers.json': '{ "projectx": 1 }\n',
    'tests/lib/a.test.js': "combine start topstep_50k\n",
    'skills/topstep-rules/SKILL.md': 'neutral\n',
    'data/bars.xlsx': Buffer.from('topstep'),
  };
  const read = f => (Buffer.isBuffer(files[f]) ? files[f] : Buffer.from(files[f]));
  const { hits } = S.scan(Object.keys(files), read, { allowed: ALLOWED });
  assert.deepStrictEqual(hits.map(h => h.split(':').slice(0, 2).join(':')), [
    'skills/x/SKILL.md:1', 'scripts/lib/x.js:1', 'scripts/lib/x.js:2', 'tests/lib/a.test.js:1',
    'skills/topstep-rules/SKILL.md: the path names a platform, firm or model',
  ]);
});

test('an entry excuses only its kind: a firm entry never excuses a platform name, an account entry never the firm', () => {
  const read = () => Buffer.from('the Topstep day; on TopstepX\nTopstep\'s reset; topstep_100k\napi.topstepx\n');
  const firm = { file: 'docs/a.md', kind: 'firm', plan: 'plan C', reason: 'x' };
  const r = S.scan(['docs/a.md'], read, { entries: [firm] });
  assert.deepStrictEqual(r.hits.map(h => h.split(':')[1]), ['1', '2', '3']);
  assert.strictEqual(r.actual.get(S.key(firm)).lines, 2);
  const both = S.scan(['docs/a.md'], read, { entries: [firm, { ...firm, kind: 'account' }] });
  assert.deepStrictEqual(both.hits.map(h => h.split(':')[1]), ['1', '3']);
});

test('pinVerdict: a new key, a new or swapped line, a duplicate, an unused entry or permanent exception fail; a line gone fails until recorded; no hash to paste', () => {
  const e = { file: 'docs/a.md', kind: 'firm', plan: 'plan C', reason: 'x' };
  const k = S.key(e);
  const at = lines => new Map([[k, { lines: lines.length, excused: lines, hashes: lines.map(S.lineHash).sort() }]]);
  const two = ['Topstep a', 'Topstep b'];
  const pins = { [k]: two.map(S.lineHash).sort() };
  assert.deepStrictEqual(S.pinVerdict([e], at(two), pins), [], 'at the pin');
  assert.deepStrictEqual(S.pinVerdict([e], at([...two].reverse()), pins), [], 'order does not matter');
  assert.match(S.pinVerdict([e], at([...two, 'Topstep c']), pins).join(), /an excused line is new or changed \(3 lines, 2 pinned\)/);
  assert.match(S.pinVerdict([e], at(['Topstep a', 'Topstep z']), pins).join(), /an excused line is new or changed/);
  assert.match(S.pinVerdict([e], at(['Topstep a', 'Topstep a']), pins).join(), /new or changed/, 'a repeated line is not the other one');
  assert.match(S.pinVerdict([e], at(['Topstep a']), pins).join(), /1 pinned line\(s\) gone: record it with FTH_UPDATE_PINS=1/);
  assert.deepStrictEqual(S.pinVerdict([e], at(['Topstep a']), { [k]: [S.lineHash('Topstep a')] }), [], 'recorded');
  assert.match(S.pinVerdict([e], at([]), pins).join(), /excuses nothing/);
  assert.match(S.pinVerdict([e], at(two), {}).join(), /a new exception/);
  assert.match(S.pinVerdict([e, e], at(two), pins).join(), /listed twice/);
  assert.match(S.pinVerdict([], new Map(), pins).join(), /pinned but not listed/);
  assert.match(S.pinVerdict([{ ...e, plan: '' }], at(two), pins).join(), /needs a reason and the plan/);
  const p = { file: 'tests/x.js', pattern: /x/, reason: 'r' };
  assert.match(S.pinVerdict([], new Map(), {}, new Map([[p, 0]])).join(), /permanent exception \(r\) matches nothing/);
  assert.deepStrictEqual(S.pinVerdict([], new Map(), {}, new Map([[p, 1]])), []);
  // No message hands out a hash to paste.
  const all = [at([...two, 'Topstep c']), at(['Topstep a', 'Topstep z']), at(['Topstep a']), at([])].flatMap(m => S.pinVerdict([e], m, pins));
  assert.ok(all.every(m => !/[0-9a-f]{16}/.test(m)), all.join('\n'));
});

test('updatePins only removes lines: a swapped or added line, or a new key, is never written; an entry that excuses nothing loses its pin', () => {
  const at = obj => new Map(Object.entries(obj).map(([k, lines]) => [k, { lines: lines.length, hashes: lines.map(S.lineHash).sort() }]));
  const pins = { 'a|firm': ['x', 'y'].map(S.lineHash).sort(), 'b|firm': [S.lineHash('z')], 'c|firm': [S.lineHash('w')] };
  const out = S.updatePins(pins, at({ 'a|firm': ['x'], 'b|firm': ['z2'], 'c|firm': [], 'new|firm': ['q'] }));
  assert.deepStrictEqual(out, { 'a|firm': [S.lineHash('x')], 'b|firm': [S.lineHash('z')] });
  assert.deepStrictEqual(S.updatePins(pins, at({ 'a|firm': ['x', 'y', 'y'] }))['a|firm'], pins['a|firm'], 'a line gained: kept as it was');
  assert.deepStrictEqual(S.updatePins(pins, at({ 'a|firm': ['y', 'x'], 'b|firm': ['z'], 'c|firm': ['w'] })), pins, 'unchanged');
  assert.deepStrictEqual(S.updatePins(pins, new Map()), {}, 'nothing excused: every pin goes');
});

test('baseVerdict and readBasePins: keys and lines within the base\'s; the change that brings the rule passes; an unreadable base throws', () => {
  const base = { 'a|firm': ['1', '2'] };
  assert.deepStrictEqual(S.baseVerdict({ 'a|firm': ['1'] }, base), []);
  assert.deepStrictEqual(S.baseVerdict({ 'a|firm': ['1', '2'] }, base), []);
  assert.match(S.baseVerdict({ 'a|firm': ['1', '3'] }, base).join(), /a line not pinned on the base branch/);
  assert.match(S.baseVerdict({ 'a|firm': ['1', '1'] }, base).join(), /a line not pinned on the base branch/);
  assert.match(S.baseVerdict({ 'b|firm': ['1'] }, base).join(), /not pinned on the base branch/);
  assert.deepStrictEqual(S.baseVerdict({ 'b|firm': ['1'] }, null), [], 'no rule on the base yet');
  assert.ok(S.baseVerdict({ 'a|firm': ['1', 'abcdef0123456789'] }, base).every(m => !/[0-9a-f]{16}/.test(m)), 'no hash to paste');
  // A real repository: the change that brings the rule, the base's pins, a rename, a deletion, a missing base ref.
  const { spawnSync } = require('child_process');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-pins-'));
  const git = (...args) => assert.strictEqual(spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).status, 0, args.join(' '));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const commitBase = msg => { git('add', '-A'); git('commit', '-qm', msg); git('branch', '-f', 'basebranch'); };
  const PIN = 'tests/plugin/p.pins.json';
  const TEST = 'tests/plugin/t.test.js';
  const read = () => S.readBasePins(dir, PIN, TEST, 'basebranch');
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  write('tests/other.test.js', 'x\n');
  commitBase('base without the rule');
  assert.strictEqual(read(), null, 'the change that brings the rule');
  // Any guard on the base (the test, the scanner, a pins file anywhere under tests/) without the pins here: fails closed.
  for (const guard of [TEST, S.GUARD.scanner, 'tests/elsewhere/old.pins.json']) {
    write(guard, '{}\n');
    commitBase(`guard ${guard}`);
    assert.throws(read, /the guard was renamed or removed/, guard);
    git('rm', '-q', guard);
    commitBase(`no ${guard}`);
  }
  write(PIN, JSON.stringify(base));
  write(S.GUARD.scanner, '\n');
  commitBase('pins');
  // A hand edit on the branch: the base's pins are read, and the added line fails.
  write(PIN, JSON.stringify({ 'a|firm': ['1', '2', '9'] }));
  git('commit', '-qam', 'a hand edit on the branch');
  assert.deepStrictEqual(read(), base, 'the base\'s, not the branch\'s');
  assert.match(S.baseVerdict({ 'a|firm': ['1', '2', '9'] }, read()).join(), /a line not pinned on the base branch/);
  // A rename that adds a key: the base has pins, not at the path checked now: fails closed.
  git('mv', PIN, 'tests/plugin/renamed.pins.json');
  git('commit', '-qm', 'rename');
  assert.throws(() => S.readBasePins(dir, 'tests/plugin/renamed.pins.json', TEST, 'basebranch'), /the guard was renamed or removed/);
  assert.throws(() => S.readBasePins(dir, 'tests/plugin/renamed.pins.json', 'tests/plugin/renamed.test.js', 'basebranch'), /renamed or removed/);
  assert.throws(() => S.readBasePins(dir, PIN, TEST, 'origin/nope'), /the base branch can't be read/);
  fs.rmSync(dir, { recursive: true, force: true });
});

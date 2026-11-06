'use strict';

// The grammar a proposer's quiz pattern must be written in (scripts/lib/train/pattern-grammar.js): a whitelist, so no
// regex form that backtracks without end can reach the grader. Literal text, \b, \s between literals, classes, groups
// of literal alternatives (at most ? after), a few optional parts, and at most gate.maxGaps bounded wildcard gaps.

const test = require('node:test');
const assert = require('node:assert');
const G = require('../../scripts/lib/train/pattern-grammar');
const Q = require('../../scripts/lib/eval/context-quiz');

const GATE = Q.loadQuiz().value.gate;
const LIMITS = { maxGaps: GATE.maxGaps, maxGapChars: GATE.maxGapChars, maxOptionals: GATE.maxOptionals };

const OK = ['\\bwait\\b', 'wait', '(enter|take) now', 'retest (a|the)', '(no)?\\s+wait', 'wait(s|ed)?', 'three\\s+pushes', 'long.{0,40}ok',
  '\\bclose[sd]?\\b', 'needs?', '(?:wait|hold) for', '^wait', 'wait$', 'size: full', "don't enter", 'stop\\. then', 'retest.{0,30}wait.{0,20}close',
  'GOOD → wait', 'a\\s*b', '\\bthe (retest|close)\\b'];
const BAD = ['.{0,60}.{0,60}.{0,60}.{0,60}!', '\\w{0,99}\\w{0,99}\\w{0,99}\\w{0,99}', '\\w*\\w{0,999}\\w*!', '.*.*zzzz', 'abcd(\\w|\\d)*!',
  '(a|b)+', '(wait)*', '(wait){2}', '.*wait', '.+wait', `.{0,${GATE.maxGapChars + 1}}wait`, 'wait.{0,10}', 'a.{0,9}\\s+b', '\\s+wait', 'wait\\s+',
  'wait \\s+for', 'a\\s+\\s+b', '[^a]wait', '[a-z]+wait', '[a-z]{2}wait', '\\dwait', '(?=wait)wait', '(?!x)wait', '(?<n>wait)', 'wait\\1', 'wait|hold', '.',
  'a?b?c?d?wait', '((wait))', '(wait\\s+now)', 'wa{2}it', 'wait+', '(wait|)', '[]wait', 'wait.{0,9}?x', '\\Wwait', 'wa^it', 'wa$it', '(?:a|b'];

test('the grammar: the patterns a proposer needs are accepted; every other form is refused with the rule it breaks', () => {
  for (const src of OK) assert.deepStrictEqual(G.grammarErrors(src, LIMITS), [], src);
  for (const src of BAD) {
    const errs = G.grammarErrors(src, LIMITS);
    assert.ok(errs.length > 0, src);
    assert.ok(errs.every(e => typeof e === 'string' && e.length > 10), src);
  }
  assert.match(G.grammarErrors('.{0,9}a.{0,9}b.{0,9}c', { ...LIMITS, maxGaps: 2 }).join(), /at most 2 wildcard gaps/);
  assert.match(G.grammarErrors('.*wait', LIMITS).join(), /unbounded/);
  assert.match(G.grammarErrors(`.{0,${LIMITS.maxGapChars + 1}}wait`, LIMITS).join(), new RegExp(`at most ${LIMITS.maxGapChars}`));
  assert.match(G.grammarErrors('wait.{0,10}', LIMITS).join(), /followed by literal text/);
  assert.match(G.grammarErrors('\\s+wait', LIMITS).join(), /\\s.*between literal/);
  assert.match(G.grammarErrors('(a|b)+', LIMITS).join(), /repeat/);
  assert.match(G.grammarErrors('a?b?c?d?wait', LIMITS).join(), new RegExp(`at most ${LIMITS.maxOptionals} optional parts`));
  // The limits are the caller's: none, and a gap is refused.
  assert.match(G.grammarErrors('long.{0,40}ok', { ...LIMITS, maxGaps: 0 }).join(), /at most 0 wildcard gaps/);
  assert.throws(() => G.grammarErrors('wait', {}), /maxGaps/);
});

test('the grammar: every example the review found is refused fast, and an accepted pattern runs fast on a long hostile line', () => {
  const hostile = ['a'.repeat(1000), 'z'.repeat(1000), ' '.repeat(1000), '1'.repeat(1000), 'ab '.repeat(334).slice(0, 1000)];
  for (const src of BAD) {
    const t = Date.now();
    G.grammarErrors(src, LIMITS);
    assert.ok(Date.now() - t < 200, src);
  }
  for (const src of OK) {
    const re = new RegExp(src, 'i');
    for (const line of hostile) {
      const t = Date.now();
      re.test(line);
      assert.ok(Date.now() - t < 200, `${src} on ${line.slice(0, 5)}...`);
    }
  }
});

test('the grammar, property-style: random patterns built from its own parts never take long on a 1000-character hostile line', () => {
  // A seeded generator of patterns the grammar accepts (the composer's draw kept only when the grammar takes it).
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const words = ['a', 'aa', 'wait', 'the', 'z', 'zz', 'ab', 'retest'];
  const part = () => {
    const k = rnd(7);
    if (k === 0) return '\\b';
    if (k === 1) return `[${['az', 'a-z', 'sd'][rnd(3)]}]${rnd(2) ? '?' : ''}`;
    if (k === 2) return `(${words[rnd(words.length)]}|${words[rnd(words.length)]})${rnd(2) ? '?' : ''}`;
    if (k === 3) return `${words[rnd(words.length)]}?`;
    if (k === 4) return `.{0,${1 + rnd(LIMITS.maxGapChars)}}`;
    if (k === 5) return ['\\s+', '\\s*', '\\s?'][rnd(3)];
    return words[rnd(words.length)];
  };
  let accepted = 0;
  let worst = 0;
  for (let i = 0; i < 4000 && accepted < 300; i += 1) {
    const src = Array.from({ length: 2 + rnd(9) }, part).join('');
    if (G.grammarErrors(src, LIMITS).length) continue;
    accepted += 1;
    const re = new RegExp(src, 'i');
    const letters = src.replace(/[^a-z]/g, '') || 'a';
    for (const line of ['a'.repeat(1000), 'z'.repeat(1000), ' '.repeat(1000), letters.repeat(1000).slice(0, 1000), `${letters} `.repeat(1000).slice(0, 1000)]) {
      const t = process.hrtime.bigint();
      re.test(line);
      worst = Math.max(worst, Number(process.hrtime.bigint() - t) / 1e6);
    }
  }
  assert.ok(accepted >= 100, `only ${accepted} accepted: the generator exercises too little`);
  assert.ok(worst < 200, `worst ${worst} ms`);
});

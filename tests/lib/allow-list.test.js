'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseAccountList, allowList, isPaperRun, allowListProblem, liveEntryRefusal } = require('../../scripts/lib/broker/allow-list');
const { liveRunBlocked } = require('../../scripts/lib/broker/adapter');
const { shippedBroker } = require('../helpers');

const LIVE = { name: 'live', allowedAccountsEnv: 'LIVE_ALLOWED', paperEnv: { LIVE_TRADING: 'false' } };

test('allow-list: a list of account ids; empty, "any" or junk is no list', () => {
  assert.deepStrictEqual(parseAccountList('7, 12 007'), ['7', '12']);
  for (const raw of [undefined, null, '', '  ', 'any', 'ANY', '7,any', '7;8', '-1', '*']) assert.deepStrictEqual(parseAccountList(raw), [], String(raw));
  assert.deepStrictEqual(allowList(LIVE, { LIVE_ALLOWED: '7' }), { variable: 'LIVE_ALLOWED', ids: ['7'] });
  assert.deepStrictEqual(allowList({ name: 'x' }, { LIVE_ALLOWED: '7' }), { variable: null, ids: [] });
});

test('allow-list: a live entry needs a non-empty list holding its account', () => {
  assert.match(allowListProblem({ name: 'x' }, {}, 7), /names no allow-list variable \("allowedAccountsEnv" in brokers.json\)/);
  assert.match(allowListProblem(LIVE, {}, 7), /LIVE_ALLOWED is empty/);
  assert.match(allowListProblem(LIVE, { LIVE_ALLOWED: 'any' }, 7), /never empty or "any"/);
  assert.match(allowListProblem(LIVE, { LIVE_ALLOWED: '5,6' }, 7), /account 7 is not in LIVE_ALLOWED \(5, 6\)/);
  assert.match(allowListProblem(LIVE, { LIVE_ALLOWED: '7' }, undefined), /names no valid accountId/);
  assert.match(allowListProblem(LIVE, { LIVE_ALLOWED: '7' }, '7x'), /names no valid accountId/);
  assert.strictEqual(allowListProblem(LIVE, { LIVE_ALLOWED: '5, 7' }, 7), null);
  assert.strictEqual(allowListProblem(LIVE, { LIVE_ALLOWED: '7' }, '007'), null);
  // Ids are compared as strings: exact past 2^53, where Number would round two accounts together.
  const big = '9007199254740993';
  assert.deepStrictEqual(parseAccountList(` 000${big}, 0 `), [big, '0']);
  assert.match(allowListProblem(LIVE, { LIVE_ALLOWED: '9007199254740992' }, big), /is not in LIVE_ALLOWED/);
  assert.strictEqual(allowListProblem(LIVE, { LIVE_ALLOWED: big }, ` ${big} `), null);
  assert.match(allowListProblem(LIVE, { LIVE_ALLOWED: big }, Number(big)), /names no valid accountId/, 'an unsafe number is not an id');
});

test('allow-list: paper runs (every paperEnv setting in force) and confirmed replays are exempt; nothing else is', () => {
  assert.strictEqual(isPaperRun(LIVE, { LIVE_TRADING: 'false' }), true);
  assert.strictEqual(isPaperRun(LIVE, { LIVE_TRADING: 'true' }), false);
  assert.strictEqual(isPaperRun(LIVE, {}), false);
  assert.strictEqual(isPaperRun({ name: 'x', paperEnv: {} }, {}), false, 'no paper settings: never paper');
  // An empty paper value is never in force (an unset variable would match it).
  assert.strictEqual(isPaperRun({ name: 'x', paperEnv: { OFF: '' } }, {}), false);
  assert.strictEqual(isPaperRun({ name: 'x', paperEnv: { OFF: '' } }, { OFF: '' }), false);
  assert.strictEqual(isPaperRun({ name: 'x', paperEnv: { A: 'false', OFF: '' } }, { A: 'false' }), false);
  assert.strictEqual(liveEntryRefusal({ broker: LIVE, env: { LIVE_TRADING: 'false' }, accountId: 7 }), null);
  assert.strictEqual(liveEntryRefusal({ broker: LIVE, env: {}, accountId: 7, replay: true }), null);
  assert.match(liveEntryRefusal({ broker: LIVE, env: {}, accountId: 7, replay: 'yes' }), /LIVE_ALLOWED/, 'only replay === true');
  assert.match(liveEntryRefusal({ broker: LIVE, env: {}, accountId: 7 }), /LIVE_ALLOWED/);
});

test('allow-list: the shipped live broker names its allow-list variable; its paper settings exempt it', () => {
  const b = shippedBroker();
  assert.ok(b.allowedAccountsEnv && b.env.includes(b.allowedAccountsEnv), 'named, and forwarded to the server');
  assert.match(allowListProblem(b, {}, 7), new RegExp(`${b.allowedAccountsEnv} is empty`));
  assert.strictEqual(isPaperRun(b, { ...b.paperEnv }), true);
});

test('liveRunBlocked: a live run names an allowed account the server lists; a confirmed replay is exempt', () => {
  const server = { tradingEnabled: true, allowedAccountIds: [7] };
  assert.strictEqual(liveRunBlocked({ broker: LIVE, config: server, env: { LIVE_ALLOWED: '7' }, accountId: '7' }), null);
  assert.match(liveRunBlocked({ broker: LIVE, config: server, env: { LIVE_ALLOWED: '7' }, accountId: '' }), /names its account/);
  assert.match(liveRunBlocked({ broker: LIVE, config: server, env: {}, accountId: '7' }), /LIVE_ALLOWED is empty/);
  assert.match(liveRunBlocked({ broker: LIVE, config: { tradingEnabled: true, allowedAccountIds: 'any' }, env: { LIVE_ALLOWED: '7' }, accountId: '7' }), /allows any account/);
  assert.match(liveRunBlocked({ broker: LIVE, config: { tradingEnabled: false }, env: { LIVE_ALLOWED: '7' }, accountId: '7' }), /trading disabled/);
  const replay = { ...LIVE, replay: true };
  assert.strictEqual(liveRunBlocked({ broker: replay, config: { ...server, allowedAccountIds: 'any', replay: true }, env: {}, accountId: '7' }), null);
  assert.strictEqual(liveRunBlocked({ broker: replay, config: { ...server, replay: true }, env: {}, accountId: '' }), null);
  assert.match(liveRunBlocked({ broker: replay, config: server, env: {}, accountId: '7' }), /LIVE_ALLOWED/, 'the server doesn\'t say replay: live');
  assert.match(liveRunBlocked({ broker: LIVE, config: { ...server, replay: true }, env: {}, accountId: '7' }), /LIVE_ALLOWED/, 'the broker config doesn\'t say replay: live');
});

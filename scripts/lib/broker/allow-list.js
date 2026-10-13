'use strict';

/**
 * The live allow-list: the accounts a live broker server may trade, as the
 * user set them in the server's own environment. The broker config names the
 * variable (`allowedAccountsEnv` in brokers.json), so the harness knows no
 * platform's variable names. A live entry needs a non-empty list holding its
 * account; an empty list, "any", or no variable named is refused, never read
 * as "every account". Paper runs (every `paperEnv` setting in force: the
 * server refuses all orders anyway) and confirmed replays don't need one.
 * Risk-reducing actions (exits, protective stops, cancels, closes) are never
 * checked: callers apply this to entries only.
 *
 *   parseAccountList(raw)                         ['7', ...] or [] (empty, "any", junk)
 *   allowList(broker, env)                        { variable, ids }
 *   isPaperRun(broker, env)                       every paperEnv setting is in env
 *   allowListProblem(broker, env, accountId)      why a live entry on accountId is refused, or null
 *   liveEntryRefusal({ broker, env, accountId, replay })   the same, null for paper and confirmed replays
 *   serverEntryRefusal({ broker, env, accountId, replay, server })   the gateway's check against the server's own
 *       get_server_config: paper only when the server says trading is off; live, the server's allowedAccountIds
 *       must list the account (and the local list too); no readable config, refused
 */

/** An account id as a string of digits without leading zeros ("007" -> "7"), exact at any length; else null. */
function normId(id) {
  if (typeof id === 'number' && !Number.isSafeInteger(id)) return null;
  const s = String(id === undefined || id === null ? '' : id).trim();
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : null;
}

/** A comma or space separated list of account ids, normalized; "any" and junk give []. */
function parseAccountList(raw) {
  const parts = String(raw === undefined || raw === null ? '' : raw).split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  if (!parts.length || parts.some(p => normId(p) === null)) return [];
  return [...new Set(parts.map(normId))];
}

function allowList(broker, env = process.env) {
  const variable = broker && typeof broker.allowedAccountsEnv === 'string' && broker.allowedAccountsEnv.trim() ? broker.allowedAccountsEnv.trim() : null;
  return { variable, ids: variable ? parseAccountList(env[variable]) : [] };
}

function isPaperRun(broker, env = process.env) {
  // An empty or unset value is never "in force" (an unset variable would match a '' setting).
  const settings = Object.entries((broker && broker.paperEnv) || {});
  return settings.length > 0 && settings.every(([k, v]) => {
    const want = String(v === undefined || v === null ? '' : v);
    const have = env[k] === undefined || env[k] === null ? '' : String(env[k]);
    return want !== '' && have === want;
  });
}

function allowListProblem(broker, env, accountId) {
  const name = (broker && broker.name) || 'the broker';
  const { variable, ids } = allowList(broker, env);
  if (!variable) return `broker "${name}" names no allow-list variable ("allowedAccountsEnv" in brokers.json), so live entries are refused: name the server's allowed-accounts variable there and set it to the account(s) this harness may trade`;
  if (!ids.length) return `${variable} is empty or not a list of account ids (got ${JSON.stringify(String(env[variable] || ''))}): a live run needs it set to the account(s) this harness may trade (e.g. ${variable}=12345), never empty or "any"`;
  const id = normId(accountId);
  if (id === null) return `the order names no valid accountId (${JSON.stringify(accountId)}), so it can't be checked against ${variable}`;
  if (!ids.includes(id)) return `account ${id} is not in ${variable} (${ids.join(', ')}): add it there to trade it live`;
  return null;
}

function liveEntryRefusal({ broker, env = process.env, accountId, replay = false }) {
  if (replay === true || isPaperRun(broker, env)) return null;
  return allowListProblem(broker, env, accountId);
}

/** The server's allowedAccountIds as normalized ids, or null when it is not a non-empty list of ids. */
function serverAccounts(server) {
  const list = server && server.allowedAccountIds;
  if (!Array.isArray(list) || !list.length) return null;
  const ids = list.map(normId);
  return ids.includes(null) ? null : ids;
}

function serverEntryRefusal({ broker, env = process.env, accountId, replay = false, server }) {
  if (replay === true) return null;
  if (!server || typeof server !== 'object' || Array.isArray(server) || typeof server.tradingEnabled !== 'boolean') {
    return `the broker server's get_server_config could not be read (${server && server.error ? server.error : 'no tradingEnabled in its answer'}), so the entry can't be checked against its allowed accounts`;
  }
  // Paper only when the server itself has trading off: a paper claim the server contradicts is a live run.
  if (server.tradingEnabled === false) return null;
  const local = allowListProblem(broker, env, accountId);
  if (local) return local;
  const ids = serverAccounts(server);
  if (!ids) return `the broker server allows any account (get_server_config: allowedAccountIds ${JSON.stringify(server.allowedAccountIds)}): a live entry needs its allowed-accounts setting to list account ${normId(accountId)}`;
  if (!ids.includes(normId(accountId))) return `account ${normId(accountId)} is not among the broker server's allowed accounts (${ids.join(', ')})`;
  return null;
}

/**
 * The gateway's server check, its get_server_config read once per process (as its clock is pinned) and kept only
 * when readable: `violations(args, replay, already)` -> [] or one allowed-accounts violation for an entry (one `already`
 * refused is not checked again). `broker`
 * is the gateway's configured broker (else the broker config's); a failed read refuses the entry and is retried.
 */
function createServerAttestation({ env = process.env, broker = null, call }) {
  let cached = null;
  const read = async () => {
    if (cached) return cached;
    try {
      const r = await call('get_server_config', {});
      if (!r || r.isError) throw new Error(String((r && r.content && r.content[0] && r.content[0].text) || 'no result').slice(0, 200));
      const cfg = JSON.parse(r.content[0].text);
      if (cfg && typeof cfg === 'object' && typeof cfg.tradingEnabled === 'boolean') cached = cfg;
      return cfg;
    } catch (err) {
      return { error: err.message };
    }
  };
  return {
    async violations(args, replay, already = []) {
      if (already.length) return []; // refused anyway: the server isn't asked
      let b = broker;
      try {
        b = b || require('./config').activeBroker(env);
      } catch (err) {
        return [{ check: 'allowed-accounts', message: `${err.message}. Exits, protective stops, cancels and close_position still go.` }];
      }
      const why = serverEntryRefusal({ broker: b, env, accountId: (args || {}).accountId, replay, server: replay === true ? null : await read() });
      return why ? [{ check: 'allowed-accounts', message: `${why}. Exits, protective stops, cancels and close_position still go.` }] : [];
    },
  };
}

module.exports = { createServerAttestation, normId, parseAccountList, allowList, isPaperRun, allowListProblem, liveEntryRefusal, serverEntryRefusal };

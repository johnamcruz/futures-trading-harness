'use strict';

/**
 * The order gate's and the order ledger's timing, one home each: every user imports these, so tightening one never
 * leaves a copy loose. Pinned (exact): a test holds each value exactly, and each user named below says which direction is
 * stricter for it; the gate fails closed on what these bound, and none is a setting.
 *
 *   PENDING_ORDER_TTL_MS  a market order sent this recently may not show in the broker's positions yet: the gateway's
 *                         order ledger keeps it this long (scripts/mcp-gateway.js), the account gate projects the net
 *                         position from it and counts it in flight for the prop one-position check (account-gate.js),
 *                         and an order still in another gateway's lane is given this beyond the lane's wait
 *                         (order-tracker.js graceFor). Longer is stricter (an order counts as pending longer).
 *   ORDER_GRACE_MS        how long an order's outcome may take to show at the broker: an order of unknown outcome
 *                         blocks new entries until then (order-markers.js; longer is stricter); the runner's end of day
 *                         waits this long for the account to read flat before it counts a failed run toward the kill
 *                         switch (runner.js; shorter is stricter), and matches a fill to the entry record sent up to
 *                         this long before it (runner.js).
 *   CALL_TIMEOUT_MS       how long the gateway, the broker client and the tools-server check wait on one call before
 *                         failing closed (trading/mcp-gateway.js, broker/mcp-client.js, harness-tools/preflight.js);
 *                         the contract translator's lookups wait longer (mcp-gateway.js LOOKUP_TIMEOUT_MS).
 */

const PENDING_ORDER_TTL_MS = 30000;
const ORDER_GRACE_MS = 120000;
const CALL_TIMEOUT_MS = 15000;

module.exports = { PENDING_ORDER_TTL_MS, ORDER_GRACE_MS, CALL_TIMEOUT_MS };

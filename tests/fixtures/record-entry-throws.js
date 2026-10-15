'use strict';
// Preload (NODE_OPTIONS=--require) for a gateway wiring test: recording an entry order throws,
// as a failure past its own guard would. Only the gateway process is touched.
if (/mcp-gateway\.js$/.test(process.argv[1] || '')) {
  require('../../scripts/lib/trading/order-tracker').recordEntryOrder = () => { throw new Error('injected record failure'); };
}

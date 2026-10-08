'use strict';

// node --require <this file>: installs the backtest clock (no-op outside a backtest).
require('./lib/sim-clock').installSimClock(process.env);

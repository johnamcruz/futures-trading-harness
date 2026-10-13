---
name: ext_reader
description: A test fixture strategy that reads a neutral broker bar field with field() - a number now and a bar back (ext.a, ext.a[1]) and a flag (ext.b.flag); fires when price moves the same way. Test use only.
version: 1
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
signal: rules
rules:
  long:
    - field("ext.a") >= 0.5
    - field("ext.a")[1] < 0.5
    - field("ext.b.flag") >= 1
    - close > close[1]
  short:
    - field("ext.a") <= -0.5
    - field("ext.a")[1] > -0.5
    - field("ext.b.flag") < 1
    - close < close[1]
exit:
  target_r: 2
risk:
  stop: atr:1
  min_rr: 2
source: tests/fixtures/golden-bars.js (the golden regression tests)
---

# Strategy: Ext Reader (`setup:ext_reader`)

A fixture for the golden regression tests: the only strategy that reads the
neutral broker field `ext`, so adding that field to the bars changes its
decisions and nobody else's.

## When to Use

- Only in tests (`FTH_STRATEGIES_DIRS` or `loadStrategyFile`).

## How It Works

### Context filter

- None.

### Trigger

- Long when `ext.a` is at least 0.5 on this bar but was under 0.5 on the bar
  before, `ext.b.flag` is true, and the bar closes above the previous close;
  short when `ext.a` is at most -0.5 but was over -0.5 the bar before,
  `ext.b.flag` is false, and the bar closes below the previous close. A bar
  without the field never fires.

### Entry, stop, targets

- Market entry, stop 1 x ATR(20), target 2R.

### Skip when

- Never traded.

## Examples

```text
setup:ext_reader long ext.a 0.6 (0.2 the bar before), flag true, close 21500.25 above 21499.75, stop 21490.25, target 21520.25, risk $20
```

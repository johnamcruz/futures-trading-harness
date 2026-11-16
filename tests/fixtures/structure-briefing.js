'use strict';

// A synthetic bar briefing in the printed layout the structure-read truth parses (scripts/lib/learning/structure-read.js):
// its first line, Summary lines (Market state, Day so far, Pullback) and the [m3] and [m15] detail lines. Numbers are
// made up (tick-correct: MNQ 0.25); no recorded data.

function briefing({
  t = '2022-03-07T15:00:00.000Z', symbol = 'MNQ',
  last = { kind: 'CHoCH', direction: 'up', level: 14010.5, swingAt: '09:42', at: '09:51', barsAgo: 3, protected: { side: 'low', level: 13990.25, at: '09:45', brokenAt: null } },
  previous = { kind: 'BOS', direction: 'down', level: 13995, swingAt: '09:33', at: '09:39', barsAgo: 7, protected: { side: 'high', level: 14010.5, at: '09:39', brokenAt: '09:51' } },
  last15 = { kind: 'BOS', direction: 'up', level: 14020, swingAt: '08:45', at: '09:30', barsAgo: 2, knownAt: '09:45' },
  prev15 = { kind: 'CHoCH', direction: 'up', level: 13980, swingAt: '07:00', at: '08:00', barsAgo: 6, knownAt: '08:15' },
  cisd3 = { dir: 'bullish', level: 14001, confirmedClose: '09:48', displacement: 'strong' }, cisd15 = 'unavailable (not enough bars)',
  pullback = '- Pullback (15m, long leg 13980 -> 14030): depth 38% of the leg; 4 bars since the extreme.',
  daySoFar = '- Day so far (10 3m bars; `day-context`): trending up: efficiency 0.61 (x sqrt(bars) 1.93), RTH VWAP crosses 2, range 3.1 x 3m ATR(14), net up.',
  marketState = '- Market state (3m): in the up leg: HL 13990.25 holds; 4h+1h up; class trend-up.',
  m3Broken = false,
} = {}) {
  const lb = JSON.stringify({ last, previous });
  return [
    `--- bar_briefing {"symbol":"${symbol}"} as of ${t} ---`,
    `Bar briefing ${symbol} 3m, bar 09:57 ET closed 10:00 ET (03-07), price 14005.75; times in ET:`,
    `Summary (${symbol} 3m, 10:00 ET):`,
    '- Price 14005.75. 1R = 6.5 pts.',
    ...(marketState ? [marketState] : []),
    ...(daySoFar ? [daySoFar] : []),
    ...(pullback ? [pullback] : []),
    '- Rules setups: none fired on this bar.',
    '',
    'Detail by timeframe:',
    `[m3] version m3@${t}, valid until 10:03 ET`,
    '  price: 14005.75',
    m3Broken ? '  lastBreak: {"last": broken' : `  lastBreak: ${lb}`,
    `  cisd: ${JSON.stringify({ '3m': cisd3, '5m': 'unavailable (not built from 3m bars)', '15m': cisd15 })}`,
    `[m15] version m15@${t}, valid until 10:15 ET`,
    `  lastBreak: ${JSON.stringify({ last: last15, previous: prev15 })}`,
    `[h1] version h1@${t}, valid until 11:00 ET`,
    `  lastBreak: ${JSON.stringify({ last: { kind: 'BOS', direction: 'down', level: 1, knownAt: '07:00' }, previous: null })}`,
    '',
    `--- end of bar_briefing {"symbol":"${symbol}"} (sha256 ${'0'.repeat(64)}) ---`,
    '',
  ].join('\n');
}

module.exports = { briefing };

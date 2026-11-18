# The MTF structure read against the hindsight truth (gate 1)

The built module (`scripts/lib/trading/mtf-structure.js`) measured on real 3m bars: the tune half (2021-05-24 to
2022-12-31, 404 sessions) and, read once after every other gate, the hold-out (2023-01-01 to 2024-06-28; the loader
refuses any bar dated 2024-07-01 or later). The window is 09:30 to 12:00 ET. No skill, agent or script cites this
document. It reports measurements; it sets no rule.

## The truth and the scorer

Each stage event with a frozen impulse extreme is **resumed** if a setup-frame close beyond that extreme (past the tie)
comes before a parent-frame close through the parent's protected swing (past the tie), and **reversed** if the other comes
first. The scorer is the prototype's `outcome`, copied with only its inputs passed in, hashed before the tune run (sha256
`086ab374d33a0507...`). Beside each resumed share is the **price-position baseline**: the share a random walk would
give from where the close stands between the protected swing and the impulse extreme ((close - protected) / (extreme -
protected), averaged over the resolved events).

## Hard rows (tune)

| row | bar | result |
|---|---|---|
| stages in order, every instance, all three levels | 0 violations | 0 |
| protected moves without a qualifying event | 0 | 0 |
| truthfulness of every printed in-window line (every price and time on a line is in the record) | 0 violations | 0 |
| ready prints with the structural stop already traded | 0 | 0 |
| one stage word per line, two lines on every bar | 0 violations | 0 |
| the record on the runner's window (10280 3m bars) equals the full pass | >= 99.5% of in-window bars; every differing bar partial | 100% (20200 of 20200); 0 differ without partial |
| the independent oracle agrees with the module on every in-window bar (stage, the parent's way, the impulse extreme, the pullback's protected swing, the entry model) | every difference ruled on by the reviewer | 0 differences on 20200 bars x 3 levels |

## Reported rows (tune; no pass or fail)

In-window bars 20200, sessions 404. Stage events per session and the sessions with at least one:

| level | event | events | per session | sessions with one |
|---|---|---|---|---|
| 15m>3m | completed | 165 | 0.41 | 145 (35.9%) |
| 15m>3m | confirmed | 100 | 0.25 | 94 (23.3%) |
| 15m>3m | developing | 573 | 1.42 | 363 (89.9%) |
| 15m>3m | ended before established | 158 | 0.39 | 138 (34.2%) |
| 15m>3m | established | 216 | 0.53 | 196 (48.5%) |
| 15m>3m | invalidated | 209 | 0.52 | 186 (46%) |
| 15m>3m | parent turned | 7 | 0.02 | 7 (1.7%) |
| 15m>3m | superseded | 46 | 0.11 | 45 (11.1%) |
| 1h>15m | completed | 59 | 0.15 | 59 (14.6%) |
| 1h>15m | confirmed | 29 | 0.07 | 29 (7.2%) |
| 1h>15m | conservative | 8 | 0.02 | 8 (2%) |
| 1h>15m | developing | 135 | 0.33 | 133 (32.9%) |
| 1h>15m | ended before established | 38 | 0.09 | 38 (9.4%) |
| 1h>15m | established | 35 | 0.09 | 35 (8.7%) |
| 1h>15m | invalidated | 107 | 0.26 | 104 (25.7%) |
| 1h>15m | parent turned | 11 | 0.03 | 11 (2.7%) |
| 1h>15m | potential | 246 | 0.61 | 219 (54.2%) |
| 1h>15m | reset | 44 | 0.11 | 38 (9.4%) |
| 1h>15m | reversing | 24 | 0.06 | 24 (5.9%) |
| 1h>15m | superseded | 20 | 0.05 | 20 (5%) |
| 1h>15m | timing only | 96 | 0.24 | 89 (22%) |
| 1h>15m | weakening | 71 | 0.18 | 59 (14.6%) |
| 4h>1h | completed | 25 | 0.06 | 25 (6.2%) |
| 4h>1h | confirmed | 23 | 0.06 | 23 (5.7%) |
| 4h>1h | developing | 58 | 0.14 | 58 (14.4%) |
| 4h>1h | ended before established | 23 | 0.06 | 23 (5.7%) |
| 4h>1h | established | 17 | 0.04 | 17 (4.2%) |
| 4h>1h | invalidated | 14 | 0.03 | 14 (3.5%) |
| 4h>1h | parent turned | 3 | 0.01 | 3 (0.7%) |
| 4h>1h | potential | 49 | 0.12 | 49 (12.1%) |
| 4h>1h | reset | 17 | 0.04 | 17 (4.2%) |
| 4h>1h | reversing | 6 | 0.01 | 6 (1.5%) |
| 4h>1h | superseded | 10 | 0.02 | 10 (2.5%) |
| 4h>1h | timing only | 30 | 0.07 | 30 (7.4%) |
| 4h>1h | weakening | 23 | 0.06 | 23 (5.7%) |

Prints (in-window bars by stage):

| level | stage | bars | share | sessions with one |
|---|---|---|---|---|
| 15m>3m | COMPLETED | 165 | 0.8% | 145 (35.9%) |
| 15m>3m | CONFIRMED REVERSAL | 862 | 4.3% | 108 (26.7%) |
| 15m>3m | DEVELOPING | 4646 | 23% | 368 (91.1%) |
| 15m>3m | ESTABLISHED | 2572 | 12.7% | 233 (57.7%) |
| 15m>3m | INVALIDATED | 209 | 1% | 186 (46%) |
| 15m>3m | NONE | 11746 | 58.1% | 394 (97.5%) |
| 1h>15m | COMPLETED | 59 | 0.3% | 59 (14.6%) |
| 1h>15m | CONFIRMED REVERSAL | 1515 | 7.5% | 67 (16.6%) |
| 1h>15m | DEVELOPING | 4129 | 20.4% | 215 (53.2%) |
| 1h>15m | ESTABLISHED | 878 | 4.3% | 81 (20%) |
| 1h>15m | INVALIDATED | 107 | 0.5% | 104 (25.7%) |
| 1h>15m | NONE | 6368 | 31.5% | 298 (73.8%) |
| 1h>15m | POTENTIAL | 5819 | 28.8% | 273 (67.6%) |
| 1h>15m | REVERSING | 426 | 2.1% | 38 (9.4%) |
| 1h>15m | WEAKENING | 899 | 4.5% | 69 (17.1%) |
| 4h>1h | COMPLETED | 25 | 0.1% | 25 (6.2%) |
| 4h>1h | CONFIRMED REVERSAL | 1154 | 5.7% | 44 (10.9%) |
| 4h>1h | DEVELOPING | 4594 | 22.7% | 151 (37.4%) |
| 4h>1h | ESTABLISHED | 1285 | 6.4% | 54 (13.4%) |
| 4h>1h | INVALIDATED | 14 | 0.1% | 14 (3.5%) |
| 4h>1h | NONE | 5969 | 29.5% | 186 (46%) |
| 4h>1h | POTENTIAL | 5369 | 26.6% | 163 (40.3%) |
| 4h>1h | REVERSING | 837 | 4.1% | 28 (6.9%) |
| 4h>1h | WEAKENING | 953 | 4.7% | 47 (11.6%) |

Entry-ready (primary level), by side mode and model. `rule` is the printed default (the entry rule's 4h+1h side); `parent` (the 1h structure only) is counted from the same records. A print is a bar the clause says `ready`; an event is the bar the condition is met. 1R is the 3m reference stop (0.5 x ATR(20)).

| side mode | model | events | prints | sessions with a print | carried in from before 09:30 | mean bars ready | withheld (bars) | structural stop pts P50 / P90 | in R P50 / P90 |
|---|---|---|---|---|---|---|---|---|---|
| parent | aggressive | 69 | 713 | 57 (14.1%) | 10.1% | 9.14 | stop traded 101, warning 85 | 53.75 / 124.5 | 5.28 / 9.46 |
| parent | balanced | 23 | 148 | 24 (5.9%) | 3.4% | 6.17 | stop traded 260, warning 18 | 41 / 88.5 | 4.41 / 9.01 |
| parent | conservative | 8 | 167 | 12 (3%) | 44.9% | 13.92 | stop traded 232, warning 8 | 70.25 / 245 | 7.55 / 13.33 |
| rule | aggressive | 69 | 329 | 33 (8.2%) | 16.1% | 7.65 | stop traded 66, warning 32, against the side 278, no side 194 | 66.25 / 136 | 5.53 / 10.26 |
| rule | balanced | 23 | 60 | 11 (2.7%) | 0% | 5.45 | stop traded 116, against the side 112, no side 138 | 57.25 / 129.25 | 4.38 / 9.18 |
| rule | conservative | 8 | 131 | 10 (2.5%) | 48.9% | 13.1 | stop traded 142, against the side 70, warning 8, no side 56 | 65.75 / 146.25 | 6.73 / 13.36 |

The hindsight truth of each in-window stage event, beside the price-position baseline:

| level | stage event | n | resolved | resumed | baseline | difference (points) |
|---|---|---|---|---|---|---|
| 15m>3m | confirmed | 100 | 100 | 72% | 72.6% | -0.6 |
| 15m>3m | developing | 567 | 567 | 51.1% | 46.1% | 5 |
| 15m>3m | established | 216 | 216 | 40.3% | 29.7% | 10.6 |
| 1h>15m | confirmed | 29 | 29 | 72.4% | 73.1% | -0.7 |
| 1h>15m | developing | 134 | 134 | 33.6% | 23.8% | 9.8 |
| 1h>15m | established | 34 | 34 | 35.3% | 21.3% | 14 |
| 1h>15m | reversing | 24 | 24 | 66.7% | 62.6% | 4.1 |
| 1h>15m | weakening | 71 | 71 | 43.7% | 31.7% | 12 |
| 4h>1h | confirmed | 23 | 23 | 78.3% | 72.2% | 6.1 |
| 4h>1h | developing | 58 | 58 | 39.7% | 45.1% | -5.4 |
| 4h>1h | established | 16 | 16 | 68.8% | 43.8% | 25 |
| 4h>1h | reversing | 6 | 6 | 50% | 55.9% | -5.9 |
| 4h>1h | weakening | 23 | 22 | 68.2% | 58% | 10.2 |

Instances (all hours):

| level | instances | ESTABLISHED | false ESTABLISHED (INVALIDATED or the parent turned, no WEAKENING first) | resets per WEAKENING | lag to WEAKENING P50 / P90 (3m bars) | lag to REVERSING P50 / P90 | protected moves on a non-BOS label | ESTABLISHED, a 3m BOS with the parent, no WEAKENING | I7: first break back / the BOS |
|---|---|---|---|---|---|---|---|---|---|
| 4h>1h | 459 | 102 | 19 (18.6%) | 0.46 | 29 / 295 | 139 / 325 | 10 | 0 | 21 / 9 |
| 1h>15m | 1924 | 398 | 53 (13.3%) | 0.49 | 7 / 193 | 24 / 199 | 42 | 0 | 135 / 90 |
| 15m>3m | 4695 | 2113 | 743 (35.2%) | - | - / - | - / - | 321 | 0 | 0 / 0 |

The 1h structure agrees with the entry rule's side on 76.7% of the sided in-window bars (12658 of 16510).
Line bytes: the primary at most 696, both lines at most 1086, 653 on average; cut on 18 bars at the configured budgets.

## The finding on the base rates

No stage predicts the outcome beyond where price stands. The resumed share of each stage sits near the price-position
baseline at every level; the larger differences (ESTABLISHED and WEAKENING at the primary level) are on small samples
(n of 34 and 71). The line carries no rate and the skill words every stage as a structure state; any later base-rate line
in a skill needs lift over this baseline on the hold-out.

## The three bars, frozen before the hold-out

2026-11-18, from gate1-tune.json, before the hold-out read (SPEC v2 gate 1; the v4 addendum's rounding rule: a <= bar rounds the tune value UP to the whole percent or 0.1; lag bars take the tune count). tune bar: the rounded tune value; hold-out: within tune + 2 SE (shares: SE = sqrt(p(1-p)/n_holdout); resets per WEAKENING: SE = sqrt(rate/n_holdout WEAKENING); lag P50: tune + 1 bar).

| row | level | tune | bar |
|---|---|---|---|
| falseEstablishedShare | 4h>1h | 18.6 | <= 19 |
| falseEstablishedShare | 1h>15m | 13.3 | <= 14 |
| falseEstablishedShare | 15m>3m | 35.2 | <= 36 |
| resetsPerWeakening | 4h>1h | 0.46 | <= 0.5 |
| resetsPerWeakening | 1h>15m | 0.49 | <= 0.5 |
| weakeningLagP50Bars | 4h>1h | 29 | <= 29 (hold-out <= 30) |
| weakeningLagP50Bars | 1h>15m | 7 | <= 7 (hold-out <= 8) |

## The seeded audit (seed 20261117)

30 instances per level drawn from the tune half's instances that reached DEVELOPING; every transition checked against the
raw primitives recomputed for the audit (`breaksOf`, `findCisds` and the candle closes from `completedSeries`, not the
module's own frames): the event exists on that base bar, its frame, kind and direction are right, and the order holds.

4h>1h: 30 instances, 130 transitions, 0 wrong; 1h>15m: 30 instances, 136 transitions, 0 wrong; 15m>3m: 30 instances, 83 transitions, 0 wrong.

### 4h>1h: 30 instances, 130 transitions checked, 0 wrong

| # | parent | closed | transitions (each against the raw primitive) |
|---|---|---|---|
| 1 | down | ended before established | POTENTIAL 2022-03-06, 22:30: 15m CHoCH up ok; DEVELOPING 2022-03-07, 08:00: 60m CHoCH up ok; ended 2022-03-07, 11:00: a 60m break down ok |
| 2 | up | completed | POTENTIAL 2022-10-14, 03:30: 15m CHoCH down ok; DEVELOPING 2022-10-14, 05:00: 60m CHoCH down ok; COMPLETED 2022-10-14, 09:00: a 60m close beyond 14434.75 ok |
| 3 | up | completed | DEVELOPING 2021-10-11, 19:00: 60m CHoCH down ok; ESTABLISHED 2021-10-12, 17:00: 60m BOS down ok; WEAKENING 2021-10-12, 20:15: 15m CHoCH up ok; REVERSING 2021-10-13, 13:30: 15m BOS up ok; CONFIRMED 2021-10-13, 14:00: a 60m close 18104.25 through 18087.25 ok; COMPLETED 2021-10-14, 12:00: a 60m close beyond 18356.25 ok |
| 4 | down | ended before established | POTENTIAL 2022-05-20, 15:30: 15m CHoCH up ok; DEVELOPING 2022-05-23, 03:00: 60m CHoCH up ok; ended 2022-05-23, 05:00: a 60m break down ok |
| 5 | down | ended before established | POTENTIAL 2021-09-28, 14:30: 15m CHoCH up ok; DEVELOPING 2021-09-29, 04:00: 60m CHoCH up ok; ended 2021-09-29, 12:00: a 60m break down ok |
| 6 | down | ended before established | POTENTIAL 2022-12-23, 05:30: 15m CHoCH up ok; DEVELOPING 2022-12-23, 06:00: 60m CHoCH up ok; ended 2022-12-23, 10:00: a 60m break down ok |
| 7 | up | invalidated | POTENTIAL 2021-07-15, 06:15: 15m CHoCH down ok; DEVELOPING 2021-07-15, 08:00: 60m CHoCH down ok; INVALIDATED 2021-07-15, 14:00: a 240m close 18056.75 through 18148.25 ok |
| 8 | down | ended before established | POTENTIAL 2022-12-27, 20:45: 15m CHoCH up ok; DEVELOPING 2022-12-28, 03:00: 60m CHoCH up ok; ended 2022-12-28, 05:00: a 60m break down ok |
| 9 | down | ended before established | POTENTIAL 2021-12-21, 12:15: 15m CHoCH up ok; DEVELOPING 2021-12-21, 13:00: 60m CHoCH up ok; ended 2021-12-22, 04:00: a 60m break down ok |
| 10 | up | superseded | POTENTIAL 2021-10-08, 10:00: 15m CHoCH down ok; DEVELOPING 2021-10-08, 12:00: 60m CHoCH down ok; ESTABLISHED 2021-10-10, 19:00: 60m BOS down ok; WEAKENING 2021-10-11, 08:45: 15m CHoCH up ok; reset 2021-10-11, 07:00: a 15m close through 18059 ok; CONFIRMED 2021-10-11, 10:00: a 60m close 18214 through 18121.5 ok; superseded 2021-10-11, 19:00: a 60m break down ok |
| 11 | up | completed | POTENTIAL 2021-10-20, 07:45: 15m CHoCH down ok; DEVELOPING 2021-10-20, 14:00: 60m CHoCH down ok; ESTABLISHED 2021-10-21, 02:00: 60m BOS down ok; WEAKENING 2021-10-21, 03:30: 15m CHoCH up ok; CONFIRMED 2021-10-21, 10:00: a 60m close 18735.25 through 18722 ok; COMPLETED 2021-10-21, 16:00: a 60m close beyond 18801.5 ok |
| 12 | down | invalidated | POTENTIAL 2022-02-14, 07:45: 15m CHoCH up ok; DEVELOPING 2022-02-14, 12:00: 60m CHoCH up ok; INVALIDATED 2022-02-14, 22:00: a 240m close 17670.5 through 17649 ok |
| 13 | up | parent turned | POTENTIAL 2021-07-26, 19:45: 15m CHoCH down ok; DEVELOPING 2021-07-27, 04:00: 60m CHoCH down ok; ESTABLISHED 2021-07-27, 10:00: 60m BOS down ok; WEAKENING 2021-07-27, 14:30: 15m CHoCH up ok; REVERSING 2021-07-27, 16:00: 15m BOS up ok |
| 14 | down | superseded | POTENTIAL 2022-05-12, 10:15: 15m CHoCH up ok; DEVELOPING 2022-05-12, 11:00: 60m CHoCH up ok; ESTABLISHED 2022-05-12, 20:00: 60m BOS up ok; WEAKENING 2022-05-15, 21:30: 15m CHoCH down ok; REVERSING 2022-05-15, 23:30: 15m BOS down ok; reset 2022-05-12, 23:45: a 15m close through 15486.5 ok; reset 2022-05-13, 03:45: a 15m close through 15501.5 ok; reset 2022-05-13, 08:00: a 15m close through 15534 ok; reset 2022-05-13, 10:00: a 15m close through 15561.25 ok; reset 2022-05-15, 18:15: a 15m close through 15784.25 ok; CONFIRMED 2022-05-16, 10:00: a 60m close 15606.75 through 15647.25 ok; superseded 2022-05-17, 02:00: a 60m break up ok |
| 15 | up | ended before established | POTENTIAL 2022-01-12, 11:00: 15m CHoCH down ok; DEVELOPING 2022-01-12, 21:00: 60m CHoCH down ok; ended 2022-01-13, 09:00: a 60m break up ok |
| 16 | down | ended before established | POTENTIAL 2021-08-11, 07:00: 15m CHoCH up ok; DEVELOPING 2021-08-11, 09:00: 60m CHoCH up ok; ended 2021-08-12, 03:00: a 60m break down ok |
| 17 | down | invalidated | DEVELOPING 2022-05-25, 15:00: 60m CHoCH up ok; ESTABLISHED 2022-05-26, 10:00: 60m BOS up ok; INVALIDATED 2022-05-26, 10:00: a 240m close 15468 through 15429.25 ok |
| 18 | up | ended before established | POTENTIAL 2021-06-25, 03:30: 15m CHoCH down ok; DEVELOPING 2021-06-25, 10:00: 60m CHoCH down ok; ended 2021-06-28, 04:00: a 60m break up ok |
| 19 | up | completed | POTENTIAL 2022-07-29, 03:45: 15m CHoCH down ok; DEVELOPING 2022-07-29, 05:00: 60m CHoCH down ok; ESTABLISHED 2022-07-29, 09:00: 60m BOS down ok; WEAKENING 2022-07-29, 10:15: 15m CHoCH up ok; REVERSING 2022-07-29, 13:00: 15m BOS up ok; CONFIRMED 2022-07-29, 14:00: a 60m close 16249.5 through 16222.25 ok; COMPLETED 2022-07-29, 15:00: a 60m close beyond 16272.25 ok |
| 20 | down | completed | POTENTIAL 2022-08-29, 19:45: 15m CHoCH up ok; DEVELOPING 2022-08-30, 01:00: 60m CHoCH up ok; ESTABLISHED 2022-08-30, 04:00: 60m BOS up ok; WEAKENING 2022-08-30, 08:00: 15m CHoCH down ok; CONFIRMED 2022-08-30, 10:00: a 60m close 15804 through 15852.75 ok; COMPLETED 2022-08-30, 11:00: a 60m close beyond 15725.75 ok |
| 21 | down | ended before established | POTENTIAL 2022-02-24, 09:45: 15m CHoCH up ok; DEVELOPING 2022-02-24, 10:00: 60m CHoCH up ok; ended 2022-02-25, 04:00: a 60m break down ok |
| 22 | up | superseded | POTENTIAL 2022-01-13, 10:15: 15m CHoCH down ok; DEVELOPING 2022-01-13, 11:00: 60m CHoCH down ok; ESTABLISHED 2022-01-13, 16:00: 60m BOS down ok; WEAKENING 2022-01-14, 01:00: 15m CHoCH up ok; CONFIRMED 2022-01-14, 02:00: a 60m close 18871.75 through 18867 ok; superseded 2022-01-14, 08:00: a 60m break down ok |
| 23 | down | ended before established | POTENTIAL 2021-08-16, 15:15: 15m CHoCH up ok; DEVELOPING 2021-08-16, 16:00: 60m CHoCH up ok; ended 2021-08-17, 09:00: a 60m break down ok |
| 24 | down | completed | POTENTIAL 2022-12-20, 10:00: 15m CHoCH up ok; DEVELOPING 2022-12-20, 11:00: 60m CHoCH up ok; ESTABLISHED 2022-12-20, 21:00: 60m BOS up ok; WEAKENING 2022-12-21, 15:30: 15m CHoCH down ok; REVERSING 2022-12-22, 07:30: 15m BOS down ok; reset 2022-12-21, 10:15: a 15m close through 14400 ok; CONFIRMED 2022-12-22, 10:00: a 60m close 14259.75 through 14317.25 ok; COMPLETED 2022-12-22, 11:00: a 60m close beyond 14179.75 ok |
| 25 | down | invalidated | POTENTIAL 2022-01-03, 13:45: 15m CHoCH up ok; DEVELOPING 2022-01-03, 16:00: 60m CHoCH up ok; INVALIDATED 2022-01-03, 18:03: a 240m close 19846.75 through 19815 ok |
| 26 | down | completed | POTENTIAL 2022-04-12, 01:45: 15m CHoCH up ok; DEVELOPING 2022-04-12, 09:00: 60m CHoCH up ok; ESTABLISHED 2022-04-14, 01:00: 60m BOS up ok; WEAKENING 2022-04-14, 03:15: 15m CHoCH down ok; REVERSING 2022-04-14, 06:45: 15m BOS down ok; CONFIRMED 2022-04-14, 08:00: a 60m close 17553.5 through 17562.25 ok; COMPLETED 2022-04-14, 16:00: a 60m close beyond 17256.5 ok |
| 27 | down | ended before established | POTENTIAL 2022-09-16, 14:30: 15m CHoCH up ok; DEVELOPING 2022-09-16, 16:00: 60m CHoCH up ok; ended 2022-09-19, 04:00: a 60m break down ok |
| 28 | up | completed | POTENTIAL 2022-11-30, 20:45: 15m CHoCH down ok; DEVELOPING 2022-12-01, 05:00: 60m CHoCH down ok; COMPLETED 2022-12-01, 10:00: a 60m close beyond 15335.75 ok |
| 29 | down | ended before established | POTENTIAL 2021-11-29, 08:45: 15m CHoCH up ok; DEVELOPING 2021-11-29, 10:00: 60m CHoCH up ok; ended 2021-11-30, 11:00: a 60m break down ok |
| 30 | up | ended before established | POTENTIAL 2021-06-06, 20:00: 15m CHoCH down ok; DEVELOPING 2021-06-07, 04:00: 60m CHoCH down ok; ended 2021-06-07, 09:00: a 60m break up ok |

### 1h>15m: 30 instances, 136 transitions checked, 0 wrong

| # | parent | closed | transitions (each against the raw primitive) |
|---|---|---|---|
| 1 | down | superseded | POTENTIAL 2022-09-14, 00:33: 3m CHoCH up ok; DEVELOPING 2022-09-14, 03:15: 15m CHoCH up ok; ESTABLISHED 2022-09-14, 04:45: 15m BOS up ok; WEAKENING 2022-09-14, 05:12: 3m CHoCH down ok; REVERSING 2022-09-14, 05:54: 3m BOS down ok; CONFIRMED 2022-09-14, 08:00: a 15m close 15337.75 through 15365.75 ok; superseded 2022-09-14, 09:45: a 15m break up ok |
| 2 | down | ended before established | POTENTIAL 2022-06-27, 19:03: 3m CHoCH up ok; DEVELOPING 2022-06-27, 20:15: 15m CHoCH up ok; ended 2022-06-27, 22:00: a 15m break down ok |
| 3 | down | superseded | DEVELOPING 2021-06-02, 07:00: 15m CHoCH up ok; ESTABLISHED 2021-06-02, 08:30: 15m BOS up ok; WEAKENING 2021-06-02, 10:54: 3m CHoCH down ok; REVERSING 2021-06-02, 13:24: 3m BOS down ok; reset 2021-06-02, 09:48: a 3m close through 17029.5 ok; CONFIRMED 2021-06-02, 13:30: a 15m close 16967.25 through 16980 ok; superseded 2021-06-02, 16:15: a 15m break up ok |
| 4 | up | ended before established | POTENTIAL 2022-02-15, 15:42: 3m CHoCH down ok; DEVELOPING 2022-02-15, 19:00: 15m CHoCH down ok; ended 2022-02-16, 00:15: a 15m break up ok |
| 5 | down | ended before established | POTENTIAL 2022-11-18, 13:09: 3m CHoCH up ok; DEVELOPING 2022-11-18, 15:15: 15m CHoCH up ok; ended 2022-11-21, 00:15: a 15m break down ok |
| 6 | down | completed | POTENTIAL 2022-04-07, 00:51: 3m CHoCH up ok; DEVELOPING 2022-04-07, 02:00: 15m CHoCH up ok; ESTABLISHED 2022-04-07, 05:00: 15m BOS up ok; WEAKENING 2022-04-07, 06:57: 3m CHoCH down ok; CONFIRMED 2022-04-07, 07:30: a 15m close 17904.75 through 17909.5 ok; COMPLETED 2022-04-07, 11:45: a 15m close beyond 17748.5 ok |
| 7 | up | invalidated | POTENTIAL 2021-05-28, 15:51: 3m CHoCH down ok; DEVELOPING 2021-05-28, 16:00: 15m CHoCH down ok; ESTABLISHED 2021-05-30, 21:45: 15m BOS down ok; reset 2021-05-31, 04:48: a 3m close through 17018.25 ok; INVALIDATED 2021-05-31, 05:00: a 60m close 17009.25 through 17016.25 ok |
| 8 | up | completed | POTENTIAL 2022-08-14, 18:03: 3m CHoCH down ok; DEVELOPING 2022-08-14, 20:00: 15m CHoCH down ok; ESTABLISHED 2022-08-14, 21:15: 15m BOS down ok; WEAKENING 2022-08-15, 05:51: 3m CISD up ok; REVERSING 2022-08-15, 07:00: 3m BOS up ok; reset 2022-08-15, 03:15: a 3m close through 16853.5 ok; reset 2022-08-15, 05:39: a 3m close through 16825.75 ok; CONFIRMED 2022-08-15, 09:45: a 15m close 16880.25 through 16874.5 ok; COMPLETED 2022-08-15, 10:00: a 15m close beyond 16907.5 ok |
| 9 | down | superseded | DEVELOPING 2021-12-06, 03:15: 15m CHoCH up ok; ESTABLISHED 2021-12-06, 04:15: 15m BOS up ok; WEAKENING 2021-12-06, 04:33: 3m CHoCH down ok; CONFIRMED 2021-12-06, 04:45: a 15m close 19087.75 through 19093.5 ok; superseded 2021-12-06, 08:45: a 15m break up ok |
| 10 | down | superseded | POTENTIAL 2022-06-09, 16:51: 3m CHoCH up ok; DEVELOPING 2022-06-09, 22:30: 15m CHoCH up ok; ESTABLISHED 2022-06-10, 02:15: 15m BOS up ok; WEAKENING 2022-06-10, 02:36: 3m CHoCH down ok; REVERSING 2022-06-10, 02:51: 3m BOS down ok; CONFIRMED 2022-06-10, 03:30: a 15m close 15620.75 through 15638 ok; superseded 2022-06-10, 05:45: a 15m break up ok |
| 11 | up | ended before established | POTENTIAL 2022-02-08, 12:09: 3m CHoCH down ok; DEVELOPING 2022-02-08, 14:30: 15m CHoCH down ok; ended 2022-02-08, 16:00: a 15m break up ok |
| 12 | up | ended before established | DEVELOPING 2021-06-25, 03:30: 15m CHoCH down ok; ended 2021-06-25, 05:45: a 15m break up ok |
| 13 | down | ended before established | POTENTIAL 2021-11-15, 19:57: 3m CHoCH up ok; DEVELOPING 2021-11-15, 20:15: 15m CHoCH up ok; ended 2021-11-15, 23:30: a 15m break down ok |
| 14 | down | superseded | POTENTIAL 2021-11-23, 13:54: 3m CHoCH up ok; DEVELOPING 2021-11-23, 15:00: 15m CHoCH up ok; ESTABLISHED 2021-11-23, 20:30: 15m BOS up ok; WEAKENING 2021-11-23, 21:03: 3m CHoCH down ok; REVERSING 2021-11-23, 22:06: 3m BOS down ok; CONFIRMED 2021-11-23, 23:15: a 15m close 19625.75 through 19638 ok; superseded 2021-11-24, 00:45: a 15m break up ok |
| 15 | down | invalidated | POTENTIAL 2021-05-31, 11:39: 3m CHoCH up ok; DEVELOPING 2021-05-31, 18:15: 15m CHoCH up ok; ESTABLISHED 2021-05-31, 19:30: 15m BOS up ok; INVALIDATED 2021-05-31, 20:00: a 60m close 17022.5 through 17019.75 ok |
| 16 | up | superseded | POTENTIAL 2022-08-03, 14:42: 3m CHoCH down ok; DEVELOPING 2022-08-03, 16:15: 15m CHoCH down ok; ESTABLISHED 2022-08-03, 18:15: 15m BOS down ok; WEAKENING 2022-08-03, 18:51: 3m CHoCH up ok; REVERSING 2022-08-03, 21:00: 3m BOS up ok; CONFIRMED 2022-08-03, 21:00: a 15m close 16590 through 16583.75 ok; superseded 2022-08-03, 23:45: a 15m break down ok |
| 17 | down | parent turned | DEVELOPING 2021-07-20, 10:45: 15m CHoCH up ok |
| 18 | down | parent turned | DEVELOPING 2021-09-09, 20:15: 15m CHoCH up ok; ESTABLISHED 2021-09-10, 00:45: 15m BOS up ok; WEAKENING 2021-09-10, 01:09: 3m CISD down ok; REVERSING 2021-09-10, 05:39: 3m BOS down ok |
| 19 | up | ended before established | POTENTIAL 2022-03-18, 04:33: 3m CHoCH down ok; DEVELOPING 2022-03-18, 07:30: 15m CHoCH down ok; ended 2022-03-18, 08:45: a 15m break up ok |
| 20 | down | invalidated | POTENTIAL 2021-09-15, 10:33: 3m CHoCH up ok; DEVELOPING 2021-09-15, 12:30: 15m CHoCH up ok; INVALIDATED 2021-09-15, 13:00: a 60m close 18793.75 through 18788.5 ok |
| 21 | up | invalidated | DEVELOPING 2022-09-20, 13:30: 15m CHoCH down ok; INVALIDATED 2022-09-20, 14:00: a 60m close 15085.75 through 15098.5 ok |
| 22 | down | completed | POTENTIAL 2022-11-28, 15:57: 3m CHoCH up ok; DEVELOPING 2022-11-28, 20:15: 15m CHoCH up ok; ESTABLISHED 2022-11-28, 21:00: 15m BOS up ok; WEAKENING 2022-11-29, 03:54: 3m CHoCH down ok; REVERSING 2022-11-29, 04:09: 3m BOS down ok; reset 2022-11-28, 21:33: a 3m close through 14890.25 ok; reset 2022-11-29, 01:33: a 3m close through 14926 ok; reset 2022-11-29, 03:21: a 3m close through 14935.5 ok; CONFIRMED 2022-11-29, 04:45: a 15m close 14909.5 through 14917.25 ok; COMPLETED 2022-11-29, 10:15: a 15m close beyond 14825 ok |
| 23 | up | completed | POTENTIAL 2022-07-19, 18:27: 3m CHoCH down ok; DEVELOPING 2022-07-19, 20:15: 15m CHoCH down ok; COMPLETED 2022-07-19, 20:30: a 15m close beyond 15662.25 ok |
| 24 | up | ended before established | DEVELOPING 2022-07-08, 05:15: 15m CHoCH down ok; ended 2022-07-08, 06:30: a 15m break up ok |
| 25 | down | ended before established | POTENTIAL 2022-03-14, 18:33: 3m CHoCH up ok; DEVELOPING 2022-03-14, 22:45: 15m CHoCH up ok; ended 2022-03-15, 01:30: a 15m break down ok |
| 26 | down | superseded | POTENTIAL 2021-12-01, 18:03: 3m CHoCH up ok; DEVELOPING 2021-12-01, 19:00: 15m CHoCH up ok; ESTABLISHED 2021-12-01, 21:00: 15m BOS up ok; WEAKENING 2021-12-01, 22:12: 3m CISD down ok; REVERSING 2021-12-02, 01:24: 3m BOS down ok; reset 2021-12-01, 22:00: a 3m close through 19336.75 ok; CONFIRMED 2021-12-02, 03:15: a 15m close 19270.25 through 19289 ok; superseded 2021-12-02, 04:15: a 15m break up ok |
| 27 | down | invalidated | POTENTIAL 2022-02-24, 08:36: 3m CHoCH up ok; DEVELOPING 2022-02-24, 09:45: 15m CHoCH up ok; INVALIDATED 2022-02-24, 10:00: a 60m close 16691.5 through 16576 ok |
| 28 | up | completed | POTENTIAL 2022-09-02, 01:21: 3m CHoCH down ok; DEVELOPING 2022-09-02, 01:45: 15m CHoCH down ok; ESTABLISHED 2022-09-02, 06:30: 15m BOS down ok; WEAKENING 2022-09-02, 06:57: 3m CISD up ok; COMPLETED 2022-09-02, 08:45: a 15m close beyond 15644.75 ok |
| 29 | up | invalidated | POTENTIAL 2022-08-17, 01:30: 3m CHoCH down ok; DEVELOPING 2022-08-17, 02:45: 15m CHoCH down ok; ESTABLISHED 2022-08-17, 06:00: 15m BOS down ok; WEAKENING 2022-08-17, 07:42: 3m CISD up ok; reset 2022-08-17, 07:18: a 3m close through 16860 ok; INVALIDATED 2022-08-17, 09:00: a 60m close 16845 through 16847 ok |
| 30 | up | ended before established | DEVELOPING 2022-01-28, 14:15: 15m CHoCH down ok; ended 2022-01-28, 15:45: a 15m break up ok |

### 15m>3m: 30 instances, 83 transitions checked, 0 wrong

| # | parent | closed | transitions (each against the raw primitive) |
|---|---|---|---|
| 1 | up | superseded | DEVELOPING 2022-10-03, 20:36: 3m CHoCH down ok; ESTABLISHED 2022-10-03, 20:45: 3m BOS down ok; CONFIRMED 2022-10-03, 20:57: a 3m close 14634.75 through 14629 ok; superseded 2022-10-03, 22:00: a 3m break down ok |
| 2 | up | parent turned | DEVELOPING 2022-09-22, 09:24: 3m CHoCH down ok |
| 3 | down | superseded | DEVELOPING 2022-09-05, 02:51: 3m CHoCH up ok; ESTABLISHED 2022-09-05, 03:03: 3m BOS up ok; CONFIRMED 2022-09-05, 03:09: a 3m close 15429.75 through 15439.75 ok; superseded 2022-09-05, 04:30: a 3m break up ok |
| 4 | up | invalidated | DEVELOPING 2021-07-07, 20:45: 3m CHoCH down ok; ESTABLISHED 2021-07-07, 21:06: 3m BOS down ok; INVALIDATED 2021-07-07, 21:15: a 15m close 18149 through 18152 ok |
| 5 | up | invalidated | DEVELOPING 2022-09-08, 02:57: 3m CHoCH down ok; ESTABLISHED 2022-09-08, 03:18: 3m BOS down ok; INVALIDATED 2022-09-08, 03:30: a 15m close 15583.75 through 15601 ok |
| 6 | down | invalidated | DEVELOPING 2022-05-19, 06:45: 3m CHoCH up ok; ESTABLISHED 2022-05-19, 07:24: 3m BOS up ok; INVALIDATED 2022-05-19, 07:30: a 15m close 15193.25 through 15175.5 ok |
| 7 | down | ended before established | DEVELOPING 2022-03-03, 04:48: 3m CHoCH up ok; ended 2022-03-03, 05:15: a 3m break down ok |
| 8 | up | ended before established | DEVELOPING 2021-11-03, 08:24: 3m CHoCH down ok; ended 2021-11-03, 09:06: a 3m break up ok |
| 9 | up | parent turned | DEVELOPING 2022-06-27, 08:06: 3m CHoCH down ok; ESTABLISHED 2022-06-27, 08:30: 3m BOS down ok |
| 10 | up | ended before established | DEVELOPING 2022-03-17, 10:33: 3m CHoCH down ok; ended 2022-03-17, 11:09: a 3m break up ok |
| 11 | down | invalidated | DEVELOPING 2022-07-05, 10:12: 3m CHoCH up ok; INVALIDATED 2022-07-05, 10:15: a 15m close 14832 through 14792.5 ok |
| 12 | down | completed | DEVELOPING 2022-11-14, 06:36: 3m CHoCH up ok; ESTABLISHED 2022-11-14, 07:18: 3m BOS up ok; CONFIRMED 2022-11-14, 08:51: a 3m close 15024 through 15025.75 ok; COMPLETED 2022-11-14, 09:36: a 3m close beyond 14995.5 ok |
| 13 | down | superseded | DEVELOPING 2022-02-18, 03:03: 3m CHoCH up ok; ESTABLISHED 2022-02-18, 03:42: 3m BOS up ok; CONFIRMED 2022-02-18, 04:12: a 3m close 17590 through 17597.25 ok; superseded 2022-02-18, 04:57: a 3m break up ok |
| 14 | down | completed | DEVELOPING 2021-09-27, 05:03: 3m CHoCH up ok; ESTABLISHED 2021-09-27, 05:15: 3m BOS up ok; COMPLETED 2021-09-27, 05:30: a 3m close beyond 18678 ok |
| 15 | down | ended before established | DEVELOPING 2022-02-03, 13:21: 3m CHoCH up ok; ended 2022-02-03, 14:30: a 3m break down ok |
| 16 | up | ended before established | DEVELOPING 2022-09-22, 18:45: 3m CHoCH down ok; ended 2022-09-22, 19:42: a 3m break up ok |
| 17 | up | ended before established | DEVELOPING 2022-07-27, 13:03: 3m CHoCH down ok; ended 2022-07-27, 13:33: a 3m break up ok |
| 18 | up | ended before established | DEVELOPING 2021-09-21, 08:15: 3m CHoCH down ok; ended 2021-09-21, 08:51: a 3m break up ok |
| 19 | up | completed | DEVELOPING 2021-07-30, 07:27: 3m CHoCH down ok; ESTABLISHED 2021-07-30, 08:03: 3m BOS down ok; CONFIRMED 2021-07-30, 09:33: a 3m close 18229 through 18225 ok; COMPLETED 2021-07-30, 09:45: a 3m close beyond 18249.25 ok |
| 20 | down | completed | DEVELOPING 2021-09-17, 12:03: 3m CHoCH up ok; ESTABLISHED 2021-09-17, 12:27: 3m BOS up ok; CONFIRMED 2021-09-17, 13:18: a 3m close 18678.25 through 18681.5 ok; COMPLETED 2021-09-17, 13:48: a 3m close beyond 18644.75 ok |
| 21 | up | invalidated | DEVELOPING 2022-05-26, 09:21: 3m CHoCH down ok; INVALIDATED 2022-05-26, 09:30: a 15m close 15266.75 through 15270.25 ok |
| 22 | up | invalidated | DEVELOPING 2022-01-26, 14:15: 3m CHoCH down ok; ESTABLISHED 2022-01-26, 14:45: 3m BOS down ok; INVALIDATED 2022-01-26, 15:00: a 15m close 17614.25 through 17676.75 ok |
| 23 | down | invalidated | DEVELOPING 2021-09-15, 12:00: 3m CHoCH up ok; ESTABLISHED 2021-09-15, 12:24: 3m BOS up ok; INVALIDATED 2021-09-15, 13:00: a 15m close 18793.75 through 18788.5 ok |
| 24 | up | invalidated | DEVELOPING 2021-11-23, 10:27: 3m CHoCH down ok; INVALIDATED 2021-11-23, 10:30: a 15m close 19598.25 through 19636.75 ok |
| 25 | up | ended before established | DEVELOPING 2021-09-13, 19:18: 3m CHoCH down ok; ended 2021-09-13, 19:54: a 3m break up ok |
| 26 | down | superseded | DEVELOPING 2022-09-27, 14:03: 3m CHoCH up ok; ESTABLISHED 2022-09-27, 14:42: 3m BOS up ok; CONFIRMED 2022-09-27, 20:00: a 3m close 14597.5 through 14600.5 ok; superseded 2022-09-27, 20:12: a 3m break up ok |
| 27 | up | superseded | DEVELOPING 2021-05-25, 04:06: 3m CHoCH down ok; ESTABLISHED 2021-05-25, 04:18: 3m BOS down ok; CONFIRMED 2021-05-25, 05:51: a 3m close 17051.25 through 17048.5 ok; superseded 2021-05-25, 06:15: a 3m break down ok |
| 28 | down | ended before established | DEVELOPING 2021-10-12, 11:57: 3m CHoCH up ok; ended 2021-10-12, 12:57: a 3m break down ok |
| 29 | down | superseded | DEVELOPING 2021-08-06, 04:30: 3m CHoCH up ok; ESTABLISHED 2021-08-06, 04:54: 3m BOS up ok; CONFIRMED 2021-08-06, 05:21: a 3m close 18496 through 18496.5 ok; superseded 2021-08-06, 05:36: a 3m break up ok |
| 30 | up | ended before established | DEVELOPING 2022-12-21, 02:03: 3m CHoCH down ok; ended 2022-12-21, 02:57: a 3m break up ok |

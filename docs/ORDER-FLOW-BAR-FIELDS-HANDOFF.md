# Bar-field words: what the broker servers add

A hand-off note for the live and the replay broker servers (their own
repositories; the harness does not edit them). The harness has no meaning
for any extra bar field and writes none (`docs/ORDER-FLOW.md`). Until a
server says what a field means, the briefing prints the field's values bare
(the `Broker bar fields` line) and the agents treat it as unknown
(`skills/broker-bar-fields`). Nothing here changes any bar, any tool or any
order.

## What to add

In `get_server_config`, one optional key, `barFields`
(`docs/BROKER-MCP-INTERFACE.md`): for each field the server wants a reader
to see, an entry `{ meaning, per?, digits? }` keyed by the field's dotted
path on a bar.

- `meaning`: one line, the server's own words, at most 250 characters:
  what the value measures, which sign is which side, and its range or unit.
  The live server writes it from its design document; the replay server
  carries the same text (the replay reproduces the live server's output, so
  the words are the same too, and a golden file can pin them).
- `per`: set it on a size that only reads against the bar's volume
  (a net signed volume, a count of large prints): the harness shows the
  value divided by that bar value. Leave it off a value that is already a
  ratio or a bounded score.
  A window value (the last 3 or 5 bars) is a sum over several bars: divide
  it by a bar value of the same span if the server serves one (`per` may name
  any value on the bar, such as a window volume), and otherwise say in
  the meaning which volume the share is of, so a reader does not read a share
  above 1 as an error.
- `digits`: decimals to show (0 to 6). Required with `per`; give it on a
  bounded score too (two is enough for a value in -1 to 1) so the line is
  not 17 decimals wide.
- At most 6 entries are printed. Choose the few that matter for a decision
  once per completed bar. Suggested set, for a server that computes these
  (the names are the server's): the bar's net signed volume (`per: "v"`),
  the 3-bar and 5-bar window values of it, the large buy and large sell
  prints (`per: "v"`), the trade-based and the quote-based pressure scores,
  and whether the bar is complete. A server may order them as it likes; the
  harness keeps its order.

Example entry (illustrative; the words are the server's to write):

```json
"barFields": {
  "flow.windows.3.delta": { "meaning": "<the 3-bar window's net signed volume: positive when buyers lifted the offer more than sellers hit the bid>", "per": "v", "digits": 2 },
  "flow.ofiQuote": { "meaning": "<the quote-based pressure score, -1 to 1, positive when the bid side added more than the offer side>", "digits": 2 }
}
```

## Parity

Live is the truth. The replay server returns the same `barFields` text for
the same field, and the replay's golden files add the key. Where history
infers a side that live reads from the exchange flag, or a score is not yet
validated against live, the meaning says so in the same words on both
servers; the harness will print it as written.

## What the harness does with it

It reads `barFields` once when the runner starts (never again in a run),
prints each described field's last three values beside the server's words,
and leaves every other field to the JSON. It draws no conclusion from any
field: the gate, sizing, exits and entry checks do not read them
(`skills/broker-bar-fields`, `skills/vwap-volume-profile`). The check:
`node scripts/check-broker-mcp.js -- <server command>`.

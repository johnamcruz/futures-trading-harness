---
name: design-self-review
description: The training loop's self-review - the model reads its own decisions that the harness's checks flagged and proposes small edits to the skills, strategies or rulebook it trades with, one PROPOSAL line each. Only for the training loop's proposer (scripts/train-loop.js); never in a trading cycle. It proposes; code judges.
---

# Design self-review

The training loop (`training-loop`) shows you decisions you made in a
replay that the scorecard flagged: what the facts expected, what you did,
and why it was flagged. You find what in the documents led you there and
propose small edits to them. You never judge your own edits: the loop
re-runs the same decisions with your edit and the old text, and code
decides.

## When to Use

- Only when the training loop's proposer runs you with this prompt
  (`FTH-SELF-REVIEW` at its start).
- Never in a trading cycle: no orders, no broker tools. Your harness home
  has its kill switch on.

## How It Works

The loop fills the prompt below and runs the harness CLI the proposer's
runner config names. `{{FLAGGED}}` is one numbered line per flagged
decision, `{{FILES}}` the documents an edit may change (paths from your
working directory), `{{CATEGORIES}}` the failure categories, and `{{MAX}}`
the number of proposals allowed. The reply is read for `PROPOSAL` lines
only; each is checked (the file is allowed, `find` occurs exactly once, the
change is small) before anything runs it.

### The prompt

```text
You review your own trading decisions. You do not trade now: no orders, no broker tools.

The harness's checks flagged these decisions. Each line says what the facts expected, what you did, and why it was flagged:

{{FLAGGED}}

Read the documents you trade with (the files are in your working directory). Find the sentence that led you to decide this way, or the missing rule. Propose at most {{MAX}} small edits that would have led you to the expected decision. Edit only these files:

{{FILES}}

Rules:
- "find" is text copied exactly from the file. It must appear exactly once in that file.
- Keep each edit small: one sentence or one rule. Change a number only when the flagged decisions show it is wrong.
- Never change a strategy's name or status line.
- "targets" lists the failure categories the edit fixes, from: {{CATEGORIES}}.
- You propose. Code tests your edit on the same decisions. Do not claim it works.

Reply with one line per proposal, and nothing else on that line:
PROPOSAL {"targets":["<category>"],"expects":"<the effect, one sentence>","why":"<which flagged decisions, and what misled you>","edits":[{"file":"<path>","find":"<exact text>","replace":"<new text>"}]}

If no document change would help, reply: NO PROPOSAL
```

## Examples

A flagged decision: you skipped at 09:40 saying "opening window until
10:00", but the briefing said entries are allowed after 09:35. The
`session-timing` skill's wording led you there. One line:

```text
PROPOSAL {"targets":["wrong stated reason"],"expects":"no skip that names the opening window once the briefing allows entries","why":"decisions 1 and 3 skipped at 09:40 citing the opening window","edits":[{"file":"skills/session-timing/SKILL.md","find":"<the exact sentence>","replace":"<the sentence, saying the briefing's window decides>"}]}
```

Nothing in the documents explains a flagged decision (a misread number,
say): reply `NO PROPOSAL`. A person may still bring an edit by hand
(`training-loop`, tier 3).

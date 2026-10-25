---
name: design-self-review
description: Only for the training loop's proposer (FTH-SELF-REVIEW prompt) - review flagged decisions and propose skill or rule edits. Never in a trading cycle.
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

### The probe prompt

With the loop's `probe` setting (Propose-Probe-Compose, `docs/TRAINING.md`)
the loop uses this prompt instead. `{{FLOW}}` is the trading flow's steps
in order, `{{FINDINGS}}` the round's findings grouped by the step they
block (in rank order inside a step; a trend finding lists a few of its
legs, each with what you said, any contradiction and the plan that passed
there, never a date, time or price, then the base rate of valid plans on
bars with no leg and a few such plans that lost), `{{LESSONS}}` a short summary of
what earlier probes showed, with sample sizes, `{{K}}` the number of edits.
Each edit is tested alone on the same practice moments, then the ones that
helped are combined by code.

```text
You review your own trading decisions. You do not trade now: no orders, no broker tools.

A trade is built in this order: {{FLOW}}. A practice replay checked how you built yours. These are the problems it found, grouped by the step they block, each with an id:

{{FINDINGS}}

What earlier tests of edits showed (evidence only; n is how many decisions each test had, and a small n shows little):

{{LESSONS}}

Read the skills and the desk roles in your working directory. Propose at most {{K}} small edits. Fix the earliest step first: a later step can't work while an earlier one blocks it. Each edit fixes one finding above, in one file, and works without the others: each is tested alone. Edit only these files:

{{FILES}}

Rules:
- Edit the skill or the role the finding names. A finding with neither: edit the skill or role whose text misled you.
- An edit helps you read the facts better. It never makes you take a trade the facts don't support.
- A trend leg shows what you said and a plan code verified there → fix the read or rule that hid the plan.
- A leg's contradiction → fix how that step's read is read, in the skill the finding names.
- Plans that lost sit beside the legs → tell the legs from the losers; never just enter more.
- Write rules as short lines (at most 120 characters), condition then action: "- <when this holds> → <do this>".
- Add no numbers, in digits or words ("three", "half").
- Never edit the frontmatter (a skill's name and description; a role's tools and skill lists).
- In a role: never edit its "Load the skills" sentence, its headings, its report formats or its VERDICT, FACTS, EXECUTED or ABORTED lines.
- Keep the file small: never make it longer than it needs to be.
- "find" is text copied exactly from the file. It must appear exactly once in that file.
- "kind" is one of: {{KINDS}}.
- "targets" lists the failure categories the edit fixes, from: {{CATEGORIES}}.
- You propose. Code tests each edit on the same decisions. Do not claim it works.

Reply with one line per edit, and nothing else on that line. For a skill:
PROPOSAL {"tag":{"skill":"<skill>","finding":"<id>","kind":"<kind>"},"targets":["<category>"],"expects":"<the effect, one sentence>","why":"<what misled you>","edits":[{"file":"skills/<skill>/SKILL.md","find":"<exact text>","replace":"<new text>"}]}
For a role, the tag names it ("agent" in place of "skill") and the file is agents/<role>.md.

If no change would help, reply: NO PROPOSAL
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

---
name: harness-root
description: Find the harness root, written <root> (the folder with strategies/ and scripts/), from the briefing, FTH_ROOT or the workspace, and write absolute paths.
---

# Harness Root

Skills write paths in the harness as `<root>/...`: a strategy file, a
script a person runs, the tests.

## When to Use

- When a path in the harness is needed (a strategy file, the runner's logs):
  find the harness root, written `<root>` below.
- Interactively, when no briefing names it.

## How It Works

### Find the harness root (`<root>`)

The absolute path of the folder that contains `strategies/` and `scripts/`. In order:

1. The autonomous prompt or the session briefing ("Harness root (FTH_ROOT): /abs/path").
2. The `FTH_ROOT` environment variable (`echo $FTH_ROOT`).
3. The parent of the `workspace/` folder you were started in, or two
   directories above this skill's folder for a plugin install.

Always write absolute paths (a bars file, a strategy file).

## Examples

```text
The briefing says "Harness root (FTH_ROOT): /home/u/fth" → the orb strategy is /home/u/fth/strategies/orb/STRATEGY.md.
No briefing, FTH_ROOT unset, started in /home/u/fth/workspace → <root> is /home/u/fth.
```

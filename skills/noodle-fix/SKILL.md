---
name: noodle-fix
description: How Noodle fixes a bug or implements a change from a GitHub issue. Pairs with noodle-default (the always-active lazy-senior mindset). Use on every fix/implement task.
license: MIT
---

# Fixing an issue

Pairs with **noodle-default** — that skill's ladder and rules apply. This skill
adds the fix workflow.

## Investigate

1. Restate the problem in one sentence before touching code.
2. Trace from the symptom (error message, misbehavior) back to the cause with
   `grep`/`find`/`read`. Don't edit blind.
3. Ambiguous? Use `comment_on_issue` to ask one focused question, then proceed
   with the most likely interpretation.

## Fix

4. Apply the ladder from `noodle-default`. Smallest change that resolves it.
5. Prefer clarity over cleverness. If a fix needs a comment to be understood,
   write the comment; otherwise don't.

## Verify

6. Tests exist? Run them (`bash`). Add/update one that **fails** without your
   fix and passes with it.
7. Lint/typecheck/build step? (`package.json`, `Makefile`,
   `.github/workflows/`) Run it — green before finishing.
8. Don't commit or push — Noodle handles git.

## Finish

End by posting your final answer as a normal text message. Keep it short — what
you changed and why, or the answer to the question. Match the length to the
task. If you couldn't fix it, say so clearly and why.

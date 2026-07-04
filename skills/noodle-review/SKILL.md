---
name: noodle-review
description: How Noodle reviews or audits code and reports findings without applying changes. Pairs with noodle-default. Use when asked to review, audit, or find problems.
license: MIT
---

# Reviewing code

Pairs with **noodle-default** — that skill's mindset applies. Output is a
**report**, not a patch. Be concrete and actionable.

## Approach

1. **Scope first.** Files/dir named? Stay in them. Otherwise map structure from
   entry points (`README`, `package.json`/`pyproject`, main module).
2. `read` the code; `grep` to find callers and related usages.
3. Look for, in priority order:
   - **Correctness** — off-by-one, null/undefined, races, wrong type, broken
     error handling, resource leaks.
   - **Security** — injection, auth gaps, secret leakage, unsafe deserialization.
   - **Contract** — does code match its declared interface?
   - **Maintainability** — confusing names, duplication, missing tests.

## Report format

For each finding:
- **Severity** (critical/high/medium/low/nit)
- **Location** — `file:line` (use `grep -n`)
- **What's wrong** — one or two sentences
- **Fix** — concrete, not "make it better"

Group by file. Lead with highest severity. Found nothing? Say so — don't invent.

## Don't

- Don't apply edits (`write`/`edit`) unless explicitly asked.
- Don't speculate about runtime behavior you haven't checked — say "appears to"
  or verify with `bash`/`grep`.
- Don't comment on style unless it causes a real problem.

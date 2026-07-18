# AGENTS.md

## Goal

Noodle is a self-hosted GitHub bot that uses AI coding agents to automate bug finding and code improvement across a codebase. It listens for GitHub events, clones the repository, runs an AI agent on an isolated branch, and delivers results back as PRs or issues.

### How it works

1. **User triggers the agent** from one of four entry points:
   - **Issues** — open/reopen an issue, or comment with `@mention`, `/command`, or `#profile` tag
   - **PRs** — comment on an open PR with `@mention`, `/command`, or `#profile` tag
   - **Events** — any GitHub webhook event matching a stored trigger rule (push, PR lifecycle, etc.)
   - **Schedules** — cron jobs that run on a configurable interval

2. **Noodle clones the repo** and creates an isolated branch:
   - **Issue mode (no open PR)**: fresh branch `<agent>/issue-<N>` off the default branch. Opens a new PR targeting the default branch.
   - **Issue mode (open PR exists)**: fresh branch `<agent>/issue-<N>` derived from the PR's branch. Opens a **stacked PR** targeting the existing PR's branch.
   - **PR comment mode**: fresh branch derived from the PR's branch. Opens a **stacked PR** targeting the existing PR's branch.
   - **Cron/Trigger mode**: long-lived branch that stacks across runs for traceability.

3. **The AI agent runs** on the cloned branch with a system prompt + the user's task:
   - Issue/PR: the issue title, body, comments, and URL are injected into the prompt
   - Cron/Trigger: a freeform task prompt plus event context (for triggers)

4. **Results are delivered**:
   - **Issue mode (no open PR)**: commits changes, pushes branch, opens a PR with `Fixes #N`, posts a comment on the issue
   - **Issue mode (open PR exists)**: commits changes, pushes branch, opens a **stacked PR** targeting the existing PR's branch, posts a comment on the issue
   - **PR comment mode**: commits changes, pushes branch, opens a **stacked PR** targeting the existing PR's branch, posts a comment on the PR
   - **Cron/Trigger mode**: commits changes, pushes branch, opens a **new issue** with the agent's findings

### Summary

| Mode | Trigger | Branch | Output |
|------|---------|--------|--------|
| Issue (no open PR) | Issue opened/commented with `@`, `/cmd`, `#tag` | `<agent>/issue-<N>` off default branch | New PR targeting default branch |
| Issue (open PR exists) | Same as above | `<agent>/issue-<N>` derived from PR branch | Stacked PR targeting existing PR |
| PR Comment | Comment on PR with `@`, `/cmd`, `#tag` | Fresh branch derived from PR branch | Stacked PR targeting existing PR |
| Cron | Timer (configurable interval) | Long-lived, stacked | New issue with findings |
| Trigger | Any webhook event matching stored rules | Long-lived, stacked | New issue with findings |

### Key design decisions

- **Stacked PRs**: when an existing PR is involved (PR comment or issue-with-PR), the agent creates a fresh branch from the PR's branch and opens a stacked PR on top of it — no force-push, no branch reuse
- **Opt-in by default**: issues don't trigger the agent unless they contain an `@mention`, keyword, `/command`, or `#profile` tag — or unless `trigger_on_open` is enabled
- **Concurrency control**: a `cooking` label prevents duplicate runs on the same issue/PR
- **Profile routing**: `#profile` tag > slash command pin > label match > keyword regex > default profile
- **Self-hosted**: runs on your own infrastructure, connects to your GitHub App or PAT, uses your chosen AI provider

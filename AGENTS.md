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
- **Profile routing**: `#profile` tag > matched command's `profile` field > label match > keyword regex > default profile
- **Self-hosted**: runs on your own infrastructure, connects to your GitHub App or PAT, uses your chosen AI provider

### Prompting (input shaping)

Every run sends the agent a single user prompt assembled from a **base system prompt + extensions**. The base is always active; slash commands extend it; profile tags override only the profile. The composition is identical in structure across all three run paths (issue/PR, cron, trigger) — they differ only in which extensions apply.

**The base system prompt** (`system_prompt` setting in the DB, seeded by `seedDefaultSettings` in `src/server/ui-routes.ts`):
- Declares the agent's role (autonomous software engineer on a GitHub repo)
- Says to **always load `noodle-default`** — the always-active engineering mindset skill
- Says the final message IS the deliverable
- Carries a `{system}` tag that expands at runtime to the live system-info block (CPU/RAM/tier)

It's written to be **complete on its own** — a pure `@mention` run (no slash command) sends the base alone, with no framing slot filled. The agent never perceives a seam between the base and an extension.

**Extensions compose on top of the base:**

| Trigger | Base | Framing slot | Profile |
|---------|------|--------------|---------|
| `@noodle-agent` (pure mention) | ✓ active | empty | default/routed |
| `/noodle` | ✓ active | empty (builtin is a no-op — base already covers it) | default/routed |
| `/noodle-fix` | ✓ active | fix framing (loads `noodle-fix` skill) | default/routed |
| `/noodle-review` | ✓ active | review framing (loads `noodle-review` skill) | default/routed |
| `/custom-cmd` | ✓ active | that command's `system_prompt` | default/routed, or `cmd.profile` if set |
| `#GLM` | ✓ active | empty (no command matched) | **GLM** (tag override) |
| `/noodle-fix` + `#GLM` | ✓ active | fix framing | **GLM** |
| Custom cmd with `profile` set + `#GLM` | ✓ active | custom framing | **GLM** (tag wins over `cmd.profile`) |

**Priority rules:**
- **Profile**: `#profile` tag > matched command's `profile` field > label/keyword/default routing
- **Commands**: first match wins. `resolveByTrigger` (`src/server/command-store.ts`) scans segments newest-first (latest comment → issue body) and tests longest-trigger-first within each segment, so `/noodle-fix` beats `/noodle`. Multiple `/commands` in a thread → the most recent one wins.

**How the prompt is assembled** (issue/PR mode, `runJob` in `src/engine/run.ts`; cron/trigger mirror this in their own files):

1. `expandTags(baseSystemPrompt)` resolves `{system}`, `{system.tier}`, `{pr}`, `{issue}`, etc. to live data. If the base used `{system}`, the sysInfo block is already inlined — it's not appended again (avoids duplication).
2. The matched command's `system_prompt` (if any) is also `expandTags`-ed and placed in the framing slot.
3. `buildRunPrompt(framing, issue, comments, repo, fullSysInfo, isPR)` assembles: `[expanded base + sysInfo]` → `---` → `You are working on an issue/PR in <repo>` → `<framing>` → `## Issue/PR block + Discussion + URL`.

Cron/trigger use `buildSchedulerPrompt` / `buildTriggerPrompt` instead of `buildRunPrompt` (no issue context — they inject the freeform task + event context), but the base-system-prompt + expandTags prepend is identical.

**System info guidance** (`buildSysInfoGuidance` in `src/util/sysinfo.ts`): a compact facts block (CPU cores, memory, environment) plus a **one-liner** capability hint ("Resource-constrained — skip builds/tests" vs "Capable box — light verification OK"). The raw numbers + the one-liner let the agent infer what it can and can't do — no verbose explanation, to keep token count down. Shared by all three modes.

**Built-in commands** (`seedBuiltinCommand` in `src/server/command-store.ts`): `/noodle`, `/noodle-fix`, `/noodle-review` are seeded into the `commands` DB table on boot with `is_builtin = 1` (non-deletable). `/noodle`'s `system_prompt` is empty (the base covers it); the other two carry their skill-loading framing. User commands created via the UI extend the same mechanism. The DB is the single source of truth — `defaultCommandPrompt`/`fixCommandPrompt`/`reviewCommandPrompt` in `src/engine/prompt.ts` are only used to seed the builtins and as legacy fallbacks.

### Final messages & footer (output shaping)

Every run captures the agent's last assistant message (`extractLastAssistantText` in `src/engine/run.ts`), then shapes it into the delivered comment / PR body / issue body before posting. The shaping pipeline runs in every mode (issue, PR, cron, trigger) and has two stages:

1. **Phrasing** — the raw answer is passed through `phraseOutput` (`src/engine/title.ts`), a single LLM call to the local relay (port 4445, same model that just ran). This **cleans the presentation** — strips thinking-token residue, tool-call chatter ("Let me check…", "Running grep…"), fixes markdown headings/lists — but **never summarises**: its system prompt enforces "PRESERVE EVERY TECHNICAL DETAIL". Sibling to `generateIssueTitle` (used to title cron/trigger output issues), same relay pattern. Falls back to the raw message on any failure (relay down, empty result, throw), so a run is never blocked by phrasing.

2. **Footer** — appended after a `---` separator on every output (`buildFooter` in `src/engine/run.ts`): agent name, profile + model, cook time / tool calls / turns, token usage, cost (when priced), and a random fun line.

**Failed-state invariant:** phrasing is only reached in the **non-errored** branch. When the agent's own LLM call fails (`stopReason === "error"`), the run takes the template error path (`buildErrorComment` / `buildCronErrorBody` / `buildTriggerErrorBody`) and is marked `failed` — it is never routed through `phraseOutput`. Error bodies carry the footer too, so a triage list sees the same stats block regardless of outcome.

**Where each output is composed:**

| Builder | File | Used for | Body shape |
|---------|------|----------|------------|
| `buildPrBody` | `run.ts` | Issue/PR run with code changes | phrased answer + changed files + footer + `Closes <url>` |
| `buildIssueComment` | `run.ts` | Issue/PR run (no changes, or PR opened) | phrased answer + footer |
| `buildErrorComment` | `run.ts` | Issue/PR run errored | templated error notice + footer |
| `buildCronIssueBody` | `scheduler-run.ts` | Cron run succeeded | phrased findings + footer |
| `buildCronErrorBody` | `scheduler-run.ts` | Cron run errored | templated error notice + footer |
| `buildTriggerIssueBody` | `trigger-run.ts` | Trigger run succeeded | phrased findings + footer |
| `buildTriggerErrorBody` | `trigger-run.ts` | Trigger run errored | templated error notice + footer |

### Self-trigger suppression (no infinite loops)

The agent posts its output as comments and swaps labels. Without a guard, those actions would re-fire the webhook and trigger another run — e.g. an answer comment containing `@noodle` or `#GLM` in its text would wake the agent again the moment it's posted.

Noodle detects its **own** events via `sender.login` and ignores them — but only for the two action types that are outputs, never for inputs:

| Webhook event | When sent by the bot itself | Rationale |
|---------------|-----------------------------|-----------|
| `issue_comment.created` | **Suppressed** | A bot comment is an *output*, never a wake signal. This is the main loop guard — the answer comment's text can contain `@`, `/`, or `#` triggers. |
| `issues.labeled` | **Suppressed** | The bot's own `cooking` → `cooked` label swaps must not re-fire under `trigger_on_open`. |
| `issues.opened` / `reopened` | **NOT suppressed** | Cron/Trigger runs *open new issues* to deliver findings — that new issue must be able to chain into another agent run (see below). |
| `issues.assigned` | **NOT suppressed** (still scoped to the bot) | Assignment to the bot itself is always an unconditional wake. |
| Any event matched by a stored **Trigger** rule | **NOT suppressed** | The event-driven trigger path is the agent→agent chaining mechanism for Trigger mode. |

**Login matching** (`isSelfSender` in `src/github/webhook.ts`): comparison strips the GitHub-App `[bot]` suffix and is case-insensitive, so `selfLogin` set with or without `[bot]` matches a `<app-slug>[bot]` sender. In App mode `selfLogin` defaults to `<GITHUB_APP_SLUG>[bot]` (falls back to `<agent-slug>[bot]`, then `NOODLE_LOGIN` if set explicitly).

### Agent → agent chaining (Cron/Trigger mode)

In Cron and Trigger mode, the agent's output is a **new issue** (`gh.createIssue`), not a comment. That freshly-opened issue fires an `issues.opened` webhook, which:

- passes the opt-in wake filter when its body carries a wake signal (e.g. the agent's findings mention the agent name), and/or
- matches a stored **Trigger** rule (`push`, `issues`, `pull_request`, etc.)

Either path can enqueue another agent run. This is intentional — it lets a cron run surface a finding and have it picked up by a downstream agent. The self-trigger suppression rule above is deliberately **narrowed to comments and label swaps** so this chaining path keeps working: `issues.opened`/`reopened` from the bot itself are never suppressed.

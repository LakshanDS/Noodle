# Noodle — Build Plan

A self-hostable, open-source GitHub agent. You add it as a GitHub App to your
repos, open issues, and Noodle drives the **pi** agent toolkit
(`@earendil-works/pi-coding-agent`) to read code, fix bugs, and open PRs.
Multiple **agent profiles** (each pinned to a different LLM) are routed by
issue text / labels / slash-commands, defaulting to a cheap model. It supports
both webhook-driven runs and a periodic cron scan.

**Noodle is written in TypeScript/Node** and imports pi directly as a library
(no IPC, no subprocess). pi is MIT-licensed and explicitly designed to be
embedded.

---

## Architecture in one picture

```
                        ┌─────────────────────────────────────────────┐
   GitHub ──webhook──▶  │   Noodle (TypeScript / Node)                 │
                        │                                              │
                        │   server/http.ts    ──┐                      │
                        │   server/scheduler  ──┼──▶ queue (SQLite)    │
                        │   cli.ts (run)      ──┘         │            │
                        │                               ▼            │
                        │                          engine/run.ts      │
                        │                               │            │
                        │   ┌───────────────────────────┴──────────┐ │
                        │   │ engine/workspace.ts  (clone/branch)   │ │
                        │   │ engine/prompt.ts     (build prompt)   │ │
                        │   │ github/client.ts     (octokit)        │ │
                        │   │ profiles/resolve.ts  (route model)    │ │
                        │   └────────────────────────────┬──────────┘ │
                        └────────────────────────────────┼────────────┘
                                                         │ import (in-process)
                                                         ▼
                        ┌────────────────────────────────────────────────┐
                        │  @earendil-works/pi-coding-agent               │
                        │   createAgentSession({ model, tools, cwd })    │
                        │   • multi-provider LLM (Anthropic/OpenAI/...)  │
                        │   • read/bash/edit/write/grep/find/ls tools    │
                        │   • skills, extensions                         │
                        └────────────────────────────────────────────────┘
```

**Separation of concerns:** Noodle owns *everything around the coding task*
(GitHub, git, config, routing, queue, webhooks, scheduler). pi owns the
*coding task* (LLM calls, tool execution, file edits). One process, one runtime.

---

## What pi gives us for free (no need to build)

> **API surface below is verified at runtime** against
> `@earendil-works/pi-coding-agent@0.80.3` + `@earendil-works/pi-ai@0.80.3`.
> (The pi docs claim a top-level `getModel()` export from `pi-ai`; that does
> **not** exist. Model resolution goes through `ModelRegistry.find()`.)

- **Unified multi-provider LLM layer**: `ModelRegistry.create(authStorage)`
  then **`.find(provider, id)`** returns a resolved `Model`; **`.getAvailable()`**
  lists models with valid API keys; **`.registerProvider(...)`** adds custom /
  local (Ollama) endpoints. API keys via env vars (`ANTHROPIC_API_KEY`, etc.)
  or `authStorage.setRuntimeApiKey(provider, key)`. Providers: Anthropic,
  OpenAI, Google, OpenRouter, Groq, DeepSeek, Ollama, any OpenAI-compatible.
- **Headless agent SDK** (`@earendil-works/pi-coding-agent`, verified exports):
  `createAgentSession({ model, tools, cwd, customTools,
  sessionManager: SessionManager.inMemory() })` → `await session.prompt(text)`.
  No TUI required.
- **Built-in tools** (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`),
  allowlistable via `tools: [...]`, scoped to a `cwd`.
- **Custom tools** via `defineTool(...)` — schemas use the **`Type`** helper,
  re-exported from `@earendil-works/pi-ai` (do NOT import `typebox` directly;
  use the one pi ships to avoid a type-mismatch). `StringEnum` is also there.
- **Skills system** (Agent Skills standard, `SKILL.md`) — bundle Noodle
  skills via `DefaultResourceLoader({ skillsOverride })`.
- **Extension hooks** (`on("turn_start")`, `pi.exec(...)`) — for git
  checkpointing; example extensions exist to crib from.

## What Noodle builds (the product surface)

1. **Profile config + routing** — multiple profiles, route by issue content.
2. **Git workspace management** — clone to temp dir, branch, commit, push.
3. **GitHub integration** — App auth (installation tokens), issue/PR API,
   webhook payload handling, HMAC verification.
4. **CLI runner** (Phase 1) → **webhook server + scheduler** (Phase 2).
5. **Noodle skills/tools** — teach pi to comment on issues, respect repo
   conventions, summarize changes for the PR body.

---

## Project structure (single TypeScript package)

```
Noodle/
├── package.json                  # type:module, bin: { noodle: ./dist/cli.js }
├── tsconfig.json
├── .env.example
├── noodle.config.example.yaml
├── README.md
├── PLAN.md                       # this file
├── src/
│   ├── cli.ts                    # entry: `noodle <command>` — commander dispatch
│   ├── config/
│   │   ├── schema.ts             # zod schema for noodle.config.yaml
│   │   └── load.ts               # read YAML + .env, validate, resolve profiles
│   ├── profiles/
│   │   ├── types.ts              # AgentProfile (resolved)
│   │   └── resolve.ts            # issue → profile (routing logic), pure fn
│   ├── engine/
│   │   ├── run.ts                # orchestrate one job end-to-end
│   │   ├── workspace.ts          # clone, branch, commit, push (simple-git)
│   │   ├── prompt.ts             # build the prompt sent to pi from an issue
│   │   └── tools.ts              # Noodle custom tools (comment_on_issue, ...)
│   ├── github/
│   │   ├── auth.ts               # PAT (Phase 1); JWT→installation token (Phase 2)
│   │   ├── client.ts             # octokit wrapper: getIssue/comments/comment/branch/push/PR
│   │   └── webhook.ts            # (Phase 2) verify HMAC, parse event, enqueue
│   ├── server/                   # (Phase 2)
│   │   ├── http.ts               # fastify webhook receiver
│   │   ├── queue.ts              # SQLite-backed job queue
│   │   └── scheduler.ts          # cron scan of installed repos
│   └── util/
│       ├── log.ts                # structured logging (pino)
│       └── paths.ts              # resolve bundled skill dirs, tmp dir
├── skills/                       # Noodle skills bundled with the agent
│   ├── noodle-fix/
│   │   └── SKILL.md
│   └── noodle-review/
│       └── SKILL.md
└── tests/
    ├── resolve.test.ts
    ├── prompt.test.ts
    └── config.test.ts
```

---

## Dependency choices (Node)

| Concern         | Library          | Why                                       |
|-----------------|------------------|-------------------------------------------|
| Config schema   | `zod`            | typed validation, clear errors            |
| CLI             | `commander`      | mature, ergonomic                         |
| GitHub API      | `octokit`        | official SDK, full coverage               |
| Git             | `simple-git`     | clone/branch/commit/push, per-job         |
| Web server      | `fastify`        | fast, clean hooks (Phase 2)               |
| Job queue       | SQLite (`better-sqlite3`) | zero-infra self-hosting (Phase 2) |
| HMAC / hashing  | Node `crypto`    | webhook signature verification            |
| Logging         | `pino`           | structured logs for long-running jobs     |
| YAML            | `yaml`           | config file                               |
| .env            | `dotenv`         | load secrets at startup                   |
| Tool schemas    | `typebox`        | required by pi's `defineTool`             |
| Tests           | `vitest`         | fast, ESM-native                          |

---

## Phase 1 — CLI runner (MVP, prove the loop)

**Goal:** `noodle run --repo owner/name --issue 42` clones the repo, runs pi on
the issue, opens a PR. End-to-end, no server.

### Step 1.1 — Repo scaffolding
- `package.json`: `type: module`, `bin: { noodle: ./dist/cli.js }`, deps as
  above. Dev: `typescript`, `tsx`, `vitest`, `@types/node`.
- `tsconfig.json` (NodeNext, strict).
- `.env.example`, `noodle.config.example.yaml`, `.gitignore`, `README.md`.

### Step 1.2 — Config schema (`src/config/`)
`noodle.config.yaml`:
```yaml
default_profile: cheap

profiles:
  claude:
    provider: anthropic
    model: claude-sonnet-4-20250514
    thinking_level: medium
    tools: [read, bash, edit, write, grep, find, ls]
  cheap:
    provider: openrouter
    model: anthropic/claude-3-5-haiku
    thinking_level: "off"
    tools: [read, grep, find, ls]
  local:
    provider: ollama
    base_url: http://localhost:11434/v1
    model: qwen2.5-coder:32b

routing:                       # first match wins
  - { kind: slash,   match: "/claude",                profile: claude }
  - { kind: label,   match: "bug",                    profile: cheap }
  - { kind: keyword, match: "refactor|architecture",  profile: claude }

repos:                        # optional per-repo overrides
  owner/name:
    default_profile: claude
```
- `zod` validates the file; `.env` carries secrets; profiles resolve to a pi
  `Model` object via `getModel(provider, model)` (or a custom
  `Model<'openai-completions'>` literal for local).

### Step 1.3 — Profile routing (`src/profiles/resolve.ts`)
Input: issue `{ title, body, labels }` + comments. Logic (first match wins):
1. Scan issue body, then comments, for `/word` slash commands → exact profile.
2. Match labels against `routing[].label` rules.
3. Keyword regex on title + body.
4. Fall back to `default_profile`.
Returns a resolved `AgentProfile`. Pure function → easy unit tests.

### Step 1.4 — GitHub client (`src/github/`)
- **Phase 1 auth: a classic PAT** (`GITHUB_TOKEN` env). (Phase 2 upgrades to
  a GitHub App + installation tokens.)
- `octokit`-backed, thin methods: `getIssue`, `getIssueComments`,
  `createIssueComment`, `createBranch`, `pushBranch`, `createPullRequest`.

### Step 1.5 — Engine: workspace + pi run (`src/engine/run.ts`)
Orchestrates one job:
1. Fetch issue + comments via `github/client`.
2. `resolveProfile(issue)` → pick model.
3. `workspace.clone(repo, ref)` → temp dir `tmp/<job-id>/`, branch
   `noodle/issue-<n>`.
4. Build prompt (`prompt.ts`): instructions + issue title/body + comments + a
   short repo-context note (top-level file list).
5. Create pi session headless:
   ```ts
   // model resolved via the registry (verified API):
   const model = modelRegistry.find(profile.provider, profile.model);
   const { session } = await createAgentSession({
     cwd: workspace.path,
     model,
     authStorage, modelRegistry,
     sessionManager: SessionManager.inMemory(),
     resourceLoader: noodleLoader,   // bundles Noodle skills
     tools: profile.tools,
     customTools: [commentOnIssueTool],  // see below
   });
   ```
6. `await session.prompt(builtPrompt)` — subscribe to `message_update` /
   `tool_*` events for logging.
7. After the run: `git add -A && git diff --cached` — if non-empty, commit +
   push branch + open PR titled `fixes #<n>: <issue title>`, body summarizes
   changes and ends with `Closes #<n>`. If empty, comment on the issue
   explaining why.
8. Always comment on the issue with a short summary (model used, files touched,
   PR link or "no changes").

**Noodle custom tool** (`defineTool`):
- `comment_on_issue(text)` — lets pi post progress / clarifying questions back
  to the issue mid-run, so the human sees activity without waiting for the PR.

(Git checkpointing is handled by Noodle directly at run boundaries in Phase 1
— simpler than an extension. Revisit as a pi extension in Phase 3.)

### Step 1.6 — CLI (`src/cli.ts`)
`commander` commands:
- `noodle run --repo <owner/name> --issue <n>` → run one job (Phase 1 core).
- `noodle run --repo <owner/name> --scan` → list open issues, route each,
  print what *would* run (dry-run). Foundation for the cron scan.
- `noodle config validate` → validate config + that required secrets are set.
- `noodle doctor` → check pi install, API keys present, GitHub token valid.

### Step 1.7 — Noodle skills (`skills/`)
Bundled via `DefaultResourceLoader({ skillsOverride })` and copied into each
workspace's `.agents/skills/` so pi discovers them automatically:
- `noodle-fix/SKILL.md` — "investigate the bug, locate code with grep/find,
  make the minimal change, add/update tests, run them via bash, don't touch
  unrelated files."
- `noodle-review/SKILL.md` — "read target files, list concrete findings with
  file:line, propose fixes, don't apply unless asked."

### Step 1.8 — Tests + docs
- `vitest` unit tests for: config schema, profile routing (highest-value
  logic), prompt builder.
- One smoke test that mocks `createAgentSession`.
- `README.md`: install, config, the PAT-based `noodle run` flow, a worked
  example.

**Phase 1 exit criteria:** From a clean checkout, configure `.env` +
`noodle.config.yaml`, run `noodle run --repo me/proj --issue 5`, and watch a PR
appear. Fully reproducible on your machine.

---

## Phase 2 — Webhook server + scheduler (after Phase 1 is green)

### Step 2.1 — GitHub App setup
- App registration, `GITHUB_APP_ID` + `GITHUB_PRIVATE_KEY` (PEM).
  `github/auth.ts`: build JWT from PEM, exchange for an **installation access
  token** per repo (1h TTL, cached). Replaces the PAT.
  Permissions: `contents:write`, `pull-requests:write`, `issues:write`.

### Step 2.2 — Webhook receiver (`src/server/http.ts`)
- `fastify` POST `/webhook`; verify `X-Hub-Signature-256` HMAC with
  `GITHUB_WEBHOOK_SECRET`. Parse `issues.opened`, `issue_comment.created`
  (for slash-command reruns), `pull_request.*`. Respond `202` immediately,
  enqueue the job — never block on the agent.

### Step 2.3 — Job queue (`src/server/queue.ts`)
- SQLite-backed (`better-sqlite3`) job table with statuses
  (queued/running/done/failed), dedupe by event id, one job per (repo, issue).
  A worker loop pulls and runs `engine.runJob`. Zero extra infra to self-host.

### Step 2.4 — Scheduler / cron scan (`src/server/scheduler.ts`)
- Configurable interval (e.g. 30 min): iterate installations/repos, fetch open
  issues newer than last-seen, enqueue any matching routing rules. This is the
  "periodically wake up and find bugs" path.
- Rate-limit aware (respect `X-RateLimit-*`).
- Optional `scan` profile mode: run pi read-only over recently changed files
  and *open* issues when it finds problems (closes the loop on
  "agent finds bugs → I open issue → agent fixes").

### Step 2.5 — Tunneling/dev docs
- Dev: `cloudflared tunnel` / `ngrok` to expose the local server.
- Prod: reverse proxy (Caddy/nginx) + HTTPS.

**Phase 2 exit criteria:** App installed on a real repo, open an issue, watch
Noodle open a PR automatically with no manual command. Cron scan runs on schedule.

---

## Phase 3 — Hardening (post-MVP, as needed)

- **Docker-per-job isolation** — run each agent job in an ephemeral container
  before exposing to untrusted repos. Use pi's pluggable
  `BashOperations`/`ReadOperations` to route tool calls into the container.
- **Cost tracking** — pi-ai emits token/cost data; aggregate per profile/repo.
- **Concurrency limits, retries, timeouts** on the queue.
- **Minimal web UI** (job list, logs, profile editor) — only if YAML/logs prove
  insufficient.
- **Git checkpointing as a pi extension** — turn per-turn snapshotting into a
  reusable extension instead of run-boundary logic.

---

## Implementation order (what I'll actually do first)

1. Scaffold package, tsconfig, deps, `.env.example`, config example.
2. Config schema + loader (zod) + `noodle config validate`.
3. Profile types + `resolveProfile` + unit tests.
4. GitHub client (PAT-based) with `getIssue`/`createComment`/`createPR`.
5. Engine: workspace (simple-git) + `run.ts` wiring `createAgentSession` +
   prompt builder.
6. Noodle skills + the `comment_on_issue` custom tool.
7. CLI `run` command end-to-end + `doctor` + `scan`.
8. README + worked example; run full test suite.

Then validate Phase 1 against a real test repo before touching webhooks.

---

## Decisions (confirmed)

- **Language: TypeScript / Node** (matches pi, imports pi directly as a library
  — single runtime, no IPC).
- **License: MIT** (to match pi and keep it freely reusable).
- **Single config file + .env** for the MVP (no web UI).
- **PAT for Phase 1, GitHub App for Phase 2.**
- **Zero-infra self-hosting**: SQLite queue, no Redis required.
- Built under `F:\Projects\Noodle`.

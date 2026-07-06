# Noodle

<!-- test: agent smoke test — verified the issue → PR loop end to end. safe to remove. -->

A self-hostable, open-source GitHub agent. Add it to a repo, open an issue, and
Noodle drives the [**pi**](https://github.com/earendil-works/pi) agent toolkit
to read the code, fix the bug, and open a pull request.

Multiple **agent profiles** (each pinned to a different LLM) are routed per
issue — use a strong model for hard features and a cheap one for small fixes.

> Three ways to run Noodle: the **CLI** (`noodle run --repo … --issue …` for
> one-off jobs), the **GitHub Action** (zero-ops — GitHub's runners do the work),
> and the **server** (`noodle serve`: a long-lived process with a webhook
> receiver, a SQLite job queue, retries, an N-worker pool, a cron scheduler,
> and graceful shutdown). All three drive the same engine. See [PLAN.md](./PLAN.md).

---

## How it works

```
issue → Noodle fetches it → routes a profile → clones a temp branch
      → probes the host (CPU/RAM/container) for resource-aware verification
      → pi (the coding agent) edits code → Noodle commits + pushes + opens PR
      → labelled cooking → cooked/failed → posts a summary comment on the issue
```

A follow-up comment on the same issue (e.g. `/noodle`) **reuses the open PR's
branch** and stacks further commits there instead of opening a new one — a
retry after the PR was closed or merged gets a fresh branch.

Noodle owns the GitHub/git/routing/scheduling layer; pi owns the coding task
(LLM calls, file edits, tool use). One process, one runtime.

### Waking the agent (opt-in)

Noodle is **opt-in by default**: it only runs an issue when explicitly asked.
A bare new issue does **not** wake it. Any of these wake signals trigger a run:

| Signal | Example | Notes |
|--------|---------|-------|
| `@<agent>` mention | `@noodle`, `@noodle-agent`, `@noodle[bot]` | In the issue body or a comment |
| `/<agent>` slash command | `/noodle fix this` | Classic command form |
| `#<profile>` tag | `#claude rerun with claude` | **Also selects that profile** |
| Assignment | assign the issue to the agent | Always honored |

To pick a **specific profile** from a comment, use a `#tag`: `#claude fix the
build` wakes the agent *and* routes it to the `claude` profile (overriding the
default/label/keyword routing). `@noodle fix this` uses the default profile;
`#claude fix this` uses claude — no need to combine them. `#123` issue refs
never collide (tags only match configured profile names).

The wake behavior is configurable under `triggers:` in the config
(`trigger_on_mention`, `trigger_keywords`, `trigger_on_open`). Set
`trigger_on_open: true` to restore "fire on every new issue" (legacy behavior).

### Concurrency — one run per issue at a time

If the agent is already cooking on an issue (the `<name> is cooking` label is
present), a second wake signal is held off until the current run finishes —
Noodle posts a short "already cooking" note and skips. The terminal labels
(`<name> cooked here` / `<name> got Cooked`) do **not** block a follow-up.

## What's built

- **Profile routing** — slash commands (`/claude`), labels, keyword regex, or a
  default. First match wins. Per-repo overrides supported.
- **Multi-provider models** — Anthropic, OpenAI, OpenRouter, Google, Groq,
  DeepSeek, **plus any custom OpenAI-compatible or Anthropic-compatible endpoint**
  (Ollama, vLLM, LM Studio, corporate gateways, proxies). Mix built-in and
  custom providers across profiles freely.
- **The full run loop** — fetch issue → route profile → clone → branch → run pi
  → commit → push → PR → comment, with status labels applied throughout.
- **Status labels** — `<name> is cooking` while the run is in progress, swapped
  to `<name> cooked here` on success or `<name> got Cooked` on error; the agent
  creates the labels on the first run so a repo doesn't need to set them up.
- **Follow-up runs reuse the open PR** — re-commenting `/noodle` on an issue
  whose previous PR is still open stacks further commits on the same branch
  and updates that PR, instead of opening a new one. A retry after the PR has
  been closed/merged just gets a fresh branch.
- **Resource-aware verification** — Noodle probes the host (CPU cores, RAM,
  cgroup cap, container vs bare-metal) at run time and tells the agent whether
  this box can survive a build/test run or must verify by reasoning. A small
  VPS gets the "don't run the suite" guidance; a real workstation gets a
  lighter "keep it minimal" nudge.
- **Stall watcher (run-hardening)** — a two-budget watchdog aborts a run that
  has emitted no agent activity for N minutes: a tight budget for silence while
  waiting on the LLM (catches dropped sockets fast, default 15min) and a looser
  budget for silence while a tool is running (a building bash command
  legitimately produces no events until it writes output, default 60min). A
  chatty build that emits `tool_execution_update` events never trips either.
- **Job queue + retries (server mode)** — a SQLite-backed queue with dedup per
  (repo, issue), an N-worker pool (`queue.concurrency`), and exponential-backoff
  retries (`queue.max_attempts`, default 3 attempts; `queue.retry_backoff_seconds`,
  default 60s base). Permanent errors (auth, config, model-not-found, stall
  timeout) are skipped — only transient failures (network blips, 5xxs) retry.
  pi already retries `429`s with backoff.
- **Lazy-by-default mindset** — Noodle ships its own `noodle-fix` skill fusing
  the lazy ladder with grug-brain principles: minimal diff, stdlib first, no
  over-engineering, root-cause over symptom. Every fix defaults to "the best
  code is the code never written."
- **Structured output** — the agent ends by posting its final message as a
  normal text answer; Noodle appends a rich footer (profile, model, duration,
  token counts, cost, tool calls) and uses the answer verbatim in both the PR
  body and the issue comment. An errored run posts an honest, templated error
  comment instead of the agent's opening utterance, and a run with no changes
  gets a short notice.
- **Persisted sessions** — every run writes its full conversation (messages,
  tool calls, tool results) to `./sessions/<jobId>/` via pi's built-in session
  manager — resumable and inspectable without re-running.
- **Run store (SQLite)** — serve mode records one row per run (status, profile,
  model, PR, comment, summary, error, session file path) so a dashboard / future
  web UI has a queryable source of truth.
- **Noodle skills (composable)** — `noodle-default` (the always-active
  lazy-senior mindset) is paired with a task skill: `noodle-fix` for fixes,
  `noodle-review` for audits. Task skills stay lean — they extend the default
  rather than duplicate it, so adding a new task type later is one small file.
- **A custom tool** — `comment_on_issue`, so the agent can ask the reporter a
  question mid-run without us needing a second LLM call.
- **Custom endpoints with full pricing + reasoning controls** — `*_token_price`
  fields drive real USD cost reporting, `reasoning: true` opts custom
  endpoints into thinking_level forwarding, `cache_read_price` /
  `cache_write_price` for Anthropic-protocol proxies that support prompt
  caching. See [Custom endpoints](#custom-endpoints-any-openai-compatible-or-anthropic-compatible-server).
- **Rebrandable agent name** — `agent_name` in the config rebrands everything
  user-facing (labels, comment footers, branch slug) without code changes.
- **CLI** — `run`, `run --scan` (dry-run), `config validate`, `doctor`, and
  (server mode) `serve`.
- **Webhook server + job queue (server mode)** — `noodle serve` runs a long-lived
  process: a fastify webhook receiver (HMAC-verified), a SQLite-backed worker
  pool, and (optional) cron scheduler. GitHub-App installation tokens are
  minted and cached (1h TTL); serve mode re-mints credentials per git+HTTP op
  so long runs (>1h) don't die on token expiry. Graceful shutdown on SIGINT/
  SIGTERM drains workers, then closes the server and DB.
- **Cron scheduler (server mode)** — periodically polls a configured list of
  repos for open issues updated since the last scan and enqueues any that
  match the routing rules. Per-repo "last seen" watermark is persisted in
  SQLite, so restarts don't reprocess the backlog. Scoped to the agent's own
  bot login in App mode so the agent only runs when an issue is *assigned* to
  it (assign-to-a-human is ignored).

---

## Prerequisites

- **Node.js ≥ 22.19** (required by pi)
- A **GitHub Personal Access Token** with `repo` scope (or fine-grained:
  `contents:write`, `pull-requests:write`, `issues:write`)
- At least one **LLM API key** (Anthropic, OpenAI, OpenRouter, …)

## Install

```bash
git clone <this repo> Noodle
cd Noodle
npm install
npm run build        # outputs ./dist
```

For development you can skip the build and use `npm run dev` (= `tsx src/cli.ts`).

## Configure

1. Copy the examples and edit them:

   ```bash
   cp .env.example .env
   cp noodle.config.example.yaml noodle.config.yaml
   ```

2. Fill in `.env`. For CLI use a **PAT**; for `noodle serve` a **GitHub App**
   (recommended) — see [Server mode](#server-mode-noodle-serve) for the App
   setup.

   ```dotenv
   # CLI
   GITHUB_TOKEN=ghp_xxx
   # or, in App mode, instead of GITHUB_TOKEN:
   # GITHUB_APP_ID=123456
   # GITHUB_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----…
   # GITHUB_WEBHOOK_SECRET=whsecret
   # NOODLE_LOGIN=noodle-agent

   # whichever provider(s) you use
   ANTHROPIC_API_KEY=sk-ant-xxx
   ```

3. Edit `noodle.config.yaml` to define your profiles and routing. The example
   file is fully commented and also covers the server (`server`), storage
   (`storage`), scheduler (`scheduler`), per-run controls (`run` — the stall
   watcher), and job-queue behavior (`queue` — concurrency / retries).

4. Validate:
   ```bash
   npm run dev -- config validate
   ```

5. (Optional) Check the runtime is ready (auth, LLM keys, pi importable):
   ```bash
   npm run dev -- doctor
   ```

## Run

Fix a single issue:

```bash
npm run dev -- run --repo owner/name --issue 42
```

Noodle will clone the repo, run pi on the issue, and (if it produced changes)
open a pull request that closes the issue, then comment on the issue with a
summary.

Check your setup:

```bash
npm run dev -- doctor
```

## Use it as a GitHub Action (no self-hosting)

Don't want to run Noodle yourself? Add it as a GitHub Action and GitHub's
runners do the work — they spin up on a trigger, run the agent, open the PR,
and shut down. No server, no scheduler, no webhook to maintain.

This is the zero-ops path: you bring the repo + secrets, Noodle brings the
agent. (Self-hosting the CLI or the server gives you more control; the Action
is the simplest way to start.)

### Setup

1. **Commit a config** to the repo you want Noodle to work on:

   ```bash
   cp noodle.config.example.yaml noodle.config.yaml
   # edit it to define your profiles + routing, then commit
   ```

2. **Add secrets** under *Settings → Secrets and variables → Actions*:
   - `GITHUB_TOKEN` — already provided by GitHub, no action needed.
   - At least one LLM key, matching your profiles: `ANTHROPIC_API_KEY`,
     `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, …

3. **Add the workflow.** Create `.github/workflows/noodle.yml`:

   ```yaml
   name: Noodle
   on:
     issues:
       types: [opened, reopened, labeled]
     issue_comment:
       types: [created]

   permissions:
     contents: write
     pull-requests: write
     issues: write

   jobs:
     noodle:
       if: |
         github.event_name == 'issues' ||
         (github.event_name == 'issue_comment' &&
          (startsWith(github.event.comment.body, '/noodle') ||
           contains(github.event.comment.body, '@noodle') ||
           contains(github.event.comment.body, '#claude')))
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: LakshanDS/Noodle@v1
           with:
             config: noodle.config.yaml
           env:
             GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
             ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
   ```

   That runs Noodle when an issue is opened/reopened/labeled, or when someone
   comments `/noodle` on an issue. A full annotated copy is in
   [`examples/github-action.yml`](./examples/github-action.yml).

Open an issue — Noodle clones, fixes, opens a PR, comments, done.

### Action inputs

| Input    | Required | Default                | Notes |
|----------|----------|------------------------|-------|
| `issue`  | no       | from the event         | Issue number. Inferred from `issues` / `issue_comment` events if omitted. |
| `repo`   | no       | current repository     | `owner/name`. |
| `config` | no       | `noodle.config.yaml`   | Path to your Noodle config. |

### Caveats

- **PRs opened by the default `GITHUB_TOKEN` don't trigger downstream
  `on: pull_request` workflows** — a standard GitHub limitation. If you need CI
  to run on Noodle's PRs automatically, authenticate with a **PAT** or a
  **GitHub App** (set `GITHUB_TOKEN` to that credential via a secret).
- **Provider keys are job-level env** — set them under the `uses:` step's
  `env:` (or job-level `env:`), matching the provider names in your config.
- Noodle is currently **issue-driven**. `pull_request` events aren't wired up
  yet — point the Action at issues (or run the server with webhooks for issues
  + commented `/noodle`) for now.

### Custom endpoints (any OpenAI-compatible or Anthropic-compatible server)

Point a profile at your own endpoint — Ollama, vLLM, LM Studio, a corporate
gateway, or any server that mimics the OpenAI or Anthropic API:

```yaml
profiles:
  vllm:
    provider: vllm                  # any name you like
    api: openai-completions         # protocol: openai-completions | anthropic-messages | ...
    base_url: http://localhost:8000/v1
    model: meta-llama/Llama-3.1-70B-Instruct
    api_key_env: VLLM_API_KEY       # env var with the key (omit for no-auth local endpoints)
    context_window: 131072          # model metadata pi needs for custom endpoints
    max_tokens: 32000
    # Real USD cost reporting — set to your provider's published rates so the
    # comment footer shows actual spend (otherwise pi prices custom models at $0).
    input_token_price: 0.90         # USD per 1M input tokens
    output_token_price: 0.90        # USD per 1M output tokens
    # cache_read_price / cache_write_price only matter for endpoints that
    # support prompt caching (e.g. an Anthropic-protocol proxy); leave 0 otherwise.
    # reasoning: true               # forward thinking_level to reasoning-capable models
    thinking_level: medium
    api_rpm: 30                     # throttle floor (see Rate limiting below)
    tools: [read, bash, edit, write, grep, find, ls]
```

`api` selects the wire protocol — `openai-completions` covers Ollama/vLLM/
LM Studio/DeepSeek/Cerebras and anything OpenAI-compatible; `anthropic-messages`
covers Anthropic-protocol proxies/gateways; the schema also accepts
`openai-responses`, `azure-openai-responses`, `google-generative-ai`,
`google-vertex`, `mistral-conversations`, and `bedrock-converse-stream` for
rarer shapes. Built-in providers (anthropic, openai, openrouter, …) are
resolved by name and need neither `api` nor `base_url` — only custom endpoints do.

pi-ai has a built-in price table for the built-in providers; the `*_price`
fields are only used for custom endpoints, where pi would otherwise report
$0.

### Rate limiting (`api_rpm`)

`api_rpm` caps the LLM requests-per-minute a profile will make. Noodle installs a
pre-request throttle via pi's `before_provider_request` hook, so the agent loop's
back-to-back turns never exceed it. **Default: `30`.** Set `0` for unlimited.

```yaml
profiles:
  nim:
    provider: nvidia
    api: openai-completions
    base_url: https://integrate.api.nvidia.com/v1
    model: minimaxai/minimax-m3
    api_key_env: NVIDIA_API_KEY
    api_rpm: 40   # → at least 1500ms between LLM calls (0 = unlimited)
```

pi already retries `429` responses with exponential backoff (3 attempts, 2000ms
base); this throttle is the proactive floor that prevents most 429s from firing.

## Server mode: `noodle serve`

For a live, self-hosted agent — open an issue, watch a PR appear with no manual
command — run Noodle as a long-running server. It receives GitHub webhooks,
queues jobs in SQLite, and runs them through the same engine as the CLI.

```
GitHub ──webhook──▶ noodle serve (fastify)
                      │  HMAC-verify (X-Hub-Signature-256)
                      ▼
                   SQLite job queue (deduped per repo+issue)
                      ▼
                   worker → GitHub-App install token → engine.runJob → PR
```

### 1. Create a GitHub App

Under *Settings → Developer settings → GitHub Apps → New GitHub App*:

- **Permissions**: `contents:write`, `pull-requests:write`, `issues:write`.
- **Subscribe to events**: `issues`, `issue_comment`.
- **Webhook URL**: your server's `/webhook` (use `cloudflared tunnel` / `ngrok`
  in dev; a reverse proxy with HTTPS in prod). Set the webhook secret.
- Generate a **private key** (PEM) and note the **App ID**.

Install the App on the repos you want Noodle to work on.

### 2. Configure environment

```dotenv
# .env — server mode
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----...   # PEM, multiline
# GITHUB_PRIVATE_KEY_FILE=/path/to/app.private-key.pem   # alternative: read from a file
GITHUB_WEBHOOK_SECRET=whsecret                          # matches the App's webhook secret
ANTHROPIC_API_KEY=sk-ant-xxx                            # whichever provider(s) you use
NOODLE_LOGIN=noodle-agent                               # the App's bot login, to scope `assigned`
```

PAT mode (`GITHUB_TOKEN`) still works for `noodle serve` if you don't want a
full App — but App tokens are short-lived and per-installation, which is the
recommended path for a long-running server.

> **Assignment trigger.** Noodle runs when an issue is **assigned to it** —
> assign-to-a-human is ignored. In App mode set `NOODLE_LOGIN` to the App's bot
> login (e.g. `my-noodle[bot]`); in PAT mode Noodle resolves its own login
> automatically, or you can set `NOODLE_LOGIN` explicitly. If neither is set,
> Noodle falls back to a derived default from `agent_name` (e.g. `Noodle` →
> `noodle-agent`) so the assignment trigger still works out of the box.

### 3. Enable the scheduler (optional)

Add a `scheduler` block to `noodle.config.yaml` so Noodle also polls repos on a
timer — the "periodically wake up and find bugs" path, independent of webhooks:

```yaml
scheduler:
  enabled: true
  interval_minutes: 30
  repos:
    - owner/name
```

### 4. Run

```bash
npm run dev -- serve
# or with overrides:
npm run dev -- serve --host 0.0.0.0 --port 3000
```

Open an issue in an installed repo — Noodle clones, fixes, opens a PR, comments,
done. `GET /health` returns `{ "status": "ok" }` for uptime checks. SIGINT /
SIGTERM drain the worker, close the server, and close the DB cleanly.

### Dry-run scan

```bash
npm run dev -- run --repo owner/name --scan
```

Lists what the scheduler *would* enqueue right now (no agent runs, no jobs
queued) — handy for validating routing rules before enabling the scheduler.

## Routing at a glance

In the issue body, a comment, labels, or keywords — first match wins. Matches
in any **comment** (not just the issue body) are scanned too, so a `/claude`
follow-up comment reroutes that issue.

| Trigger                              | Example              | → profile |
|--------------------------------------|----------------------|-----------|
| `/word` in body or comment           | `/claude please`     | claude    |
| label (case-insensitive)             | `bug`                | cheap     |
| keyword regex (title + body)         | `refactor\|architecture` | claude |
| (nothing matches)                    |                      | default   |

## Project layout

```
src/
├── cli.ts              noodle CLI (run / config validate / doctor / serve)
├── config/             zod schema + loader for noodle.config.yaml
├── profiles/           issue → profile routing + custom-endpoint registration
├── github/             octokit client + PAT/App auth provider + webhook parsing
├── engine/             workspace (git) + prompt + the run loop + stall watcher + throttle + tools
├── server/             fastify webhook server + SQLite job queue + run store + cron scheduler + serve wiring
└── util/               logging, paths, slugify, sysinfo (host probe)
skills/                 noodle-default, noodle-fix, noodle-review (Noodle's own)
tests/                  config + routing + custom-providers + output + stall + throttle + sysinfo + stop-reason + summary-fallback + dispose-guard + webhook + auth + queue + run-store + scheduler + workspace + client + log + skills tests
```

### Skills — composable mindset

Noodle owns its skills outright — no third-party skill dependencies. The model
is **composition**: `noodle-default` holds the always-active lazy-senior /
grug-brain mindset (the ladder, the rules, the conventions) once. Each task
skill (`noodle-fix`, `noodle-review`, ...) is a lean extension that says "pairs
with noodle-default" and adds only its task-specific workflow. Adding a new task
type later = one small file. All skills are copied into each workspace's
`.agents/skills/` so pi discovers them, and the prompt instructs the agent to
load `noodle-default` + the relevant task skill before starting.

## Develop

```bash
npm test               # vitest
npm run typecheck      # tsc --noEmit
npm run build          # compile to dist/
```

## Roadmap

The project's original Phase 1 (CLI runner), Phase 2 (webhook server +
scheduler), and the bulk of Phase 3 hardening (run-stall watcher, queue
concurrency, retries, run-store / dashboard source of truth, cost reporting via
pi's token accounting) are all shipped. Still on the list from
[PLAN.md](./PLAN.md):

- **Docker-per-job isolation** — route pi's `BashOperations`/`ReadOperations`
  into an ephemeral container, so unpinned repos can't escape into the host.
- **Optional web UI** — job list, logs, profile editor. The `runs` table is
  already there as the source of truth; only the surface to render it is left.
- `pull_request` webhook events (currently issues-only).

## License

MIT.

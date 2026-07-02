# Noodle

A self-hostable, open-source GitHub agent. Add it to a repo, open an issue, and
Noodle drives the [**pi**](https://github.com/earendil-works/pi) agent toolkit
to read the code, fix the bug, and open a pull request.

Multiple **agent profiles** (each pinned to a different LLM) are routed per
issue — use a strong model for hard features and a cheap one for small fixes.

> **Status: Phase 1 (CLI runner).** `noodle run --repo … --issue …` works end
> to end. The webhook server + scheduler (live GitHub App mode) are Phase 2 —
> see [PLAN.md](./PLAN.md).

---

## How it works

```
issue → Noodle fetches it → routes a profile → clones a temp branch
      → pi (the coding agent) edits code → Noodle commits + pushes + opens PR
      → posts a summary comment on the issue
```

Noodle owns the GitHub/git/routing/scheduling layer; pi owns the coding task
(LLM calls, file edits, tool use). One process, one runtime.

## What's built (Phase 1)

- **Profile routing** — slash commands (`/claude`), labels, keyword regex, or a
  default. First match wins. Per-repo overrides supported.
- **Multi-provider models** — Anthropic, OpenAI, OpenRouter, Google, Groq,
  DeepSeek, **plus any custom OpenAI-compatible or Anthropic-compatible endpoint**
  (Ollama, vLLM, LM Studio, corporate gateways, proxies). Mix built-in and
  custom providers across profiles freely.
- **The full run loop** — clone → branch → run pi → commit → push → PR → comment.
- **Lazy-by-default mindset** — Noodle ships its own `noodle-fix` skill fusing
  the ponytail lazy-ladder with grug-brain developer principles: minimal diff,
  stdlib first, no over-engineering, root-cause over symptom. Every fix defaults
  to "the best code is the code never written."
- **Structured output** — the agent must call a `finish_run` tool with a summary;
  that becomes the PR body and issue comment (with a deterministic fallback if
  the agent doesn't call it).
- **Noodle skills (composable)** — `noodle-default` (the always-active
  lazy-senior mindset) is paired with a task skill: `noodle-fix` for fixes,
  `noodle-review` for audits. Task skills stay lean — they extend the default
  rather than duplicate it, so adding a new task type later is one small file.
- **A custom tool** — `comment_on_issue`, so the agent can ask the reporter a
  question mid-run.
- **CLI** — `run`, `config validate`, `doctor`.

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

2. Fill in `.env`:
   ```dotenv
   GITHUB_TOKEN=ghp_xxx
   ANTHROPIC_API_KEY=sk-ant-xxx      # whichever provider(s) you use
   ```

3. Edit `noodle.config.yaml` to define your profiles and routing. The example
   file is fully commented.

4. Validate:
   ```bash
   npm run dev -- config validate
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
    context_window: 131072
    max_tokens: 32000
```

`api` selects the protocol — `openai-completions` covers Ollama/vLLM/LM Studio/
DeepSeek/Cerebras and anything OpenAI-compatible; `anthropic-messages` covers
Anthropic-protocol proxies/gateways. Built-in providers (anthropic, openai,
openrouter, …) don't need `api`/`base_url` — only custom endpoints do.

## Routing at a glance

In the issue body, a comment, labels, or keywords — first match wins:

| Trigger                              | Example              | → profile |
|--------------------------------------|----------------------|-----------|
| `/word` in body or comment           | `/claude please`     | claude    |
| label (case-insensitive)             | `bug`                | cheap     |
| keyword regex (title + body)         | `refactor\|architecture` | claude |
| (nothing matches)                    |                      | default   |

## Project layout

```
src/
├── cli.ts              noodle CLI (run / config validate / doctor)
├── config/             zod schema + loader for noodle.config.yaml
├── profiles/           issue → profile routing (pure, tested)
├── github/             octokit client + PAT auth
├── engine/             workspace (git) + prompt + the run loop + tools
└── util/               logging, paths
skills/                 noodle-default, noodle-fix, noodle-review (Noodle's own)
tests/                  config + routing + output + skills unit tests
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

- **Phase 2** — GitHub App (installation tokens), webhook server, SQLite job
  queue, cron scheduler for proactive scanning. See [PLAN.md](./PLAN.md).
- **Phase 3** — Docker-per-job isolation, cost tracking, optional web UI.

## License

MIT.

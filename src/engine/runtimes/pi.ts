/**
 * pi runtime adapter — the default `AgentRuntime` implementation.
 *
 * Wraps `@earendil-works/pi-coding-agent` behind the runtime-neutral
 * `AgentRuntime` contract (see `../runtime.ts`). Owns everything pi-specific:
 *   - session construction (`createAgentSession`, `SessionManager`)
 *   - the resource loader + settings manager + throttle extension wiring
 *   - pi's native `AgentSessionEvent` → normalized `RuntimeEvent` translation
 *   - pi's `getSessionStats()` → `RuntimeStats` passthrough
 *   - `RuntimeCustomTool` → pi's `defineTool(...)` (via `../tools.ts:toPiTool`)
 *
 * Everything above this layer (`runJob`, `runCronJob`, the stall watcher, the
 * run store) is pi-agnostic, so swapping in OpenCode changes nothing here.
 *
 * The event translation lives in `piEventToRuntimeEvent` — a pure mapper that's
 * unit-tested independently of a real pi session.
 */

import { join } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  DefaultResourceLoader,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai/compat";
import { registerCustomProviders } from "../../profiles/custom-providers.js";
import { throttleForRpm, throttleExtensionFactory } from "../throttle.js";
import { buildSettingsManager } from "../pi-settings.js";
import { StallWatcher } from "../stall.js";
import { toPiTool } from "../tools.js";
import type {
  AgentRuntime,
  RuntimeBootOptions,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionHandle,
  RuntimeStats,
} from "../runtime.js";

/**
 * pi runtime — the default and historically only agent engine in Noodle.
 * Stateless beyond the config it's handed at boot; one shared instance is fine
 * (each run gets its own session + SessionManager).
 */
export const PiRuntime: AgentRuntime = {
  name: "pi",
  boot: (opts) => bootPiSession(opts, { fresh: true }),
  resume: (sessionPath, opts) => bootPiSession(opts, { fresh: false, sessionPath }),
};

/**
 * Boot (or resume) a pi session and wrap it as a `RuntimeSessionHandle`.
 *
 * Mirrors the session-construction block that lived in `run.ts`/`cron-run.ts`
 * before the runtime refactor: register custom providers, resolve the model,
 * build the settings manager + resource loader (with the per-profile throttle
 * extension), create or reopen the SessionManager, then `createAgentSession`.
 *
 * `fresh: false` reopens an existing persisted session (for the restart loop);
 * `fresh: true` starts a new one. The returned handle carries the stall watcher
 * already attached.
 */
async function bootPiSession(
  opts: RuntimeBootOptions,
  mode: { fresh: true } | { fresh: false; sessionPath: string },
): Promise<RuntimeSessionHandle> {
  const { cwd, sessionDir, profile, stallBudgets, customTools } = opts;

  // --- model + provider resolution -----------------------------------------
  // AuthStorage/ModelRegistry are constructed per-session. Custom-endpoint
  // profiles (Ollama/vLLM/proxies) are registered with pi's registry first.
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  // The provider-key map is rebuilt per run; we only need this profile's key.
  // registerCustomProviders expects the full config tree, so we build a minimal
  // view carrying just this profile.
  const providerKeyMap = registerCustomProviders(
    { profiles: { [profile.name]: profile } } as never,
    modelRegistry,
  );
  const providerKey = providerKeyMap.get(profile.name) ?? profile.provider;
  let model: Model<Api> | undefined;
  try {
    model = modelRegistry.find(providerKey, profile.model);
  } catch (e) {
    throw new Error(
      `Could not resolve model "${providerKey}/${profile.model}". ` +
        `Check the profile config and that the model id is valid. (${(e as Error).message})`,
    );
  }
  if (!model) {
    throw new Error(
      `Could not resolve model "${providerKey}/${profile.model}". ` +
        `Check the profile config and that the model id is valid.`,
    );
  }

  // --- settings + resource loader ------------------------------------------
  const throttle = throttleForRpm(profile.api_rpm);
  const settingsManager = buildSettingsManager(cwd, join(cwd, ".noodle-agent"), profile);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, ".noodle-agent"),
    settingsManager,
    ...(throttle
      ? { extensionFactories: [throttleExtensionFactory(throttle, `${profile.provider}/${profile.model}`)] }
      : {}),
  });
  await loader.reload();

  // --- session manager (fresh or resumed) ----------------------------------
  const sessionManager = mode.fresh
    ? SessionManager.create(cwd, sessionDir)
    : SessionManager.open(mode.sessionPath, sessionDir, cwd);

  // --- create the pi session + wrap as RuntimeSession ----------------------
  const customToolsPi = (customTools ?? []).map(toPiTool);
  const { session } = await createAgentSession({
    cwd,
    model,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader: loader,
    thinkingLevel: profile.thinking_level,
    tools: profile.tools,
    ...(customToolsPi.length ? { customTools: customToolsPi } : {}),
    sessionManager,
  });

  // Translate pi's native events into RuntimeEvents for subscribers.
  const wrapped = wrapPiSession(session);
  const watcher = new StallWatcher(wrapped, stallBudgets);
  const unsubscribeStall = watcher.attach();
  return {
    session: wrapped,
    sessionPath: sessionManager.getSessionFile() ?? undefined,
    watcher,
    unsubscribeStall,
  };
}

/**
 * Wrap a pi `AgentSession` as a runtime-neutral `RuntimeSession`. Subscribers
 * receive translated `RuntimeEvent`s; `prompt`/`abort`/`dispose`/`getSessionStats`
 * pass through unchanged; `messages` is exposed for answer/stop-reason extraction.
 */
function wrapPiSession(session: unknown): RuntimeSession {
  const s = session as {
    prompt: (t: string) => Promise<void>;
    subscribe?: (fn: (raw: unknown) => unknown) => (() => void) | void;
    abort: () => Promise<void>;
    dispose?: () => Promise<void>;
    getSessionStats?: () => RuntimeStats | undefined;
    messages?: RuntimeSession["messages"];
  };
  return {
    prompt: (text: string) => s.prompt(text),
    subscribe: (fn: (e: RuntimeEvent) => void) => {
      const unsub = s.subscribe?.((raw: unknown) => {
        const ev = piEventToRuntimeEvent(raw);
        if (ev) fn(ev);
      }) as (() => void) | undefined;
      return () => unsub?.();
    },
    abort: () => s.abort(),
    dispose: s.dispose ? () => s.dispose!() : undefined,
    getSessionStats: s.getSessionStats ? () => s.getSessionStats!() : undefined,
    get messages() {
      return s.messages;
    },
  };
}

/**
 * PURE: translate a native pi `AgentSessionEvent` into a normalized
 * `RuntimeEvent`, or `null` to drop it. Exported for unit testing.
 *
 * Maps the event types Noodle cares about (logging + stall):
 *   agent_start            → agent_start
 *   agent_end              → agent_end (carrying willRetry)
 *   message_end            → message_end (assistant role + text only)
 *   tool_execution_start   → tool_start (tool name + args)
 *   tool_execution_end     → tool_end   (tool name + isError + output text)
 *   auto_retry_start       → retry      (attempt/maxAttempts/error)
 *   compaction_start/end   → compaction (phase; error on failed end)
 *   tool_execution_update  → activity   (chatty-build pokes for the stall watcher)
 *   everything else        → activity
 *
 * `message_end` for non-assistant roles is dropped (null) — pi emits it for
 * tool/user messages too, and only the assistant's reply is useful as a log.
 */
export function piEventToRuntimeEvent(raw: unknown): RuntimeEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  switch (e.type) {
    case "agent_start":
      return { type: "agent_start" };

    case "agent_end":
      return { type: "agent_end", willRetry: e.willRetry === true ? true : undefined };

    case "message_end": {
      const msg = e.message as { role?: string; content?: unknown } | undefined;
      if (msg?.role && msg.role !== "assistant") return null;
      const text = extractPiMessageText(msg).trim();
      return { type: "message_end", role: msg?.role ?? "assistant", text };
    }

    case "tool_execution_start":
      return {
        type: "tool_start",
        tool: String(e.toolName ?? "?"),
        args: e.args as Record<string, unknown> | undefined,
      };

    case "tool_execution_end": {
      const out = extractPiToolResultText(e.result).trim();
      return {
        type: "tool_end",
        tool: String(e.toolName ?? "?"),
        isError: e.isError === true,
        output: out,
      };
    }

    case "auto_retry_start":
      return {
        type: "retry",
        attempt: Number(e.attempt ?? 0),
        maxAttempts: Number(e.maxAttempts ?? 0),
        error: String(e.errorMessage ?? ""),
      };

    case "compaction_start":
      return { type: "compaction", phase: "start" };

    case "compaction_end":
      return { type: "compaction", phase: "end", error: e.errorMessage ? String(e.errorMessage) : undefined };

    default:
      // Everything else (turn_*, message_start/update, tool_execution_update,
      // auto_retry_end, queue_update, …) is "the agent is alive" — poke the
      // stall watcher without a log line.
      return { type: "activity" };
  }
}

/**
 * Pull the concatenated text out of a pi AgentMessage (an assistant message's
 * content is an array of TextContent | ThinkingContent | ToolCall). Returns the
 * full assistant reply text, or "" if there's no text content.
 */
function extractPiMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown[] }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } =>
      typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Pull the returned text out of a pi AgentToolResult. The result's `content` is
 * an array of TextContent | ImageContent — concatenate the text blocks. Some
 * tools return a plain string or other shape — coerce to string.
 */
function extractPiToolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return String(result);
  const content = (result as { content?: unknown[] }).content;
  if (!Array.isArray(content)) return String(result);
  return content
    .filter((b): b is { type: "text"; text: string } =>
      typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("\n");
}

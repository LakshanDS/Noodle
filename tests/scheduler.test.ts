import { describe, it, expect } from "vitest";
import {
  filterTriggered,
  selectIssuesToEnqueue,
  runScanOnce,
  type ScanStateStore,
} from "../src/server/scheduler.js";
import type { NoodleConfig } from "../src/config/schema.js";
import type { IssueData } from "../src/github/client.js";

const config: NoodleConfig = {
  default_profile: "cheap",
  // Opt-in trigger filter: require an @-mention (or trigger_keyword) to wake
  // the agent. Tests in this file use `trigger_on_open: true` (legacy
  // always-fire style) unless they're specifically exercising the trigger
  // filter, so the routing assertions don't have to know about it.
  triggers: {
    trigger_on_mention: true,
    trigger_keywords: [],
    trigger_on_open: true,
  },
  profiles: {
    cheap: { provider: "openrouter", model: "haiku", thinking_level: "off", tools: ["read"] },
    claude: { provider: "anthropic", model: "sonnet", thinking_level: "off", tools: ["read"] },
  },
  routing: [
    { kind: "slash", match: "/claude", profile: "claude" },
    { kind: "label", match: "bug", profile: "cheap" },
  ],
  repos: {},
  server: { host: "0.0.0.0", port: 3000 },
  storage: { sqlite_path: "./noodle.db" },
  scheduler: { enabled: true, interval_minutes: 30, repos: ["owner/repo"] },
};

const issue = (n: number, over: Partial<IssueData> = {}): IssueData => ({
  number: n,
  title: `issue ${n}`,
  body: "",
  labels: [],
  html_url: `https://github.com/owner/repo/issues/${n}`,
  ...over,
});

describe("selectIssuesToEnqueue", () => {
  it("routes each issue and returns it with the matched profile", () => {
    const issues = [
      issue(1, { body: "/claude please" }),
      issue(2, { labels: ["bug"] }),
      issue(3), // falls back to default
    ];
    const selected = selectIssuesToEnqueue(issues, config, "owner/repo");
    expect(selected.map((s) => s.profile)).toEqual(["claude", "cheap", "cheap"]);
    expect(selected.map((s) => s.issue.number)).toEqual([1, 2, 3]);
  });

  it("returns an empty list for an empty input", () => {
    expect(selectIssuesToEnqueue([], config, "owner/repo")).toEqual([]);
  });

  it("respects per-repo default_profile override", () => {
    const cfg: NoodleConfig = {
      ...config,
      repos: { "owner/repo": { default_profile: "claude" } },
    };
    const selected = selectIssuesToEnqueue([issue(1)], cfg, "owner/repo");
    expect(selected[0].profile).toBe("claude");
  });

  it("drops issues that don't carry a trigger (opt-in filter)", () => {
    // Default opt-in config (no always-open) drops anything that doesn't
    // @-mention the agent or match a configured keyword. The scheduler
    // stops enqueueing random new issues that weren't invited. The full
    // list from selectIssuesToEnqueue keeps the filtered-out entries (with
    // `triggered: false`) so a dry-run can show why each issue was held;
    // `filterTriggered` slices the wake-signal-accepting subset that the
    // scheduler / serve path actually enqueues.
    const strict: NoodleConfig = {
      ...config,
      triggers: {
        trigger_on_mention: true,
        trigger_keywords: [],
        trigger_on_open: false,
      },
    };
    const inv = issue(1, { body: "/claude please fix" });    // no mention, no keyword
    const notInv = issue(2, { labels: ["bug"] });           // label-only, also no mention
    const inv2 = issue(3, { body: "@noodle can you fix this?" }); // mention
    const inv3 = issue(4, { body: "agent-fix: please look" }); // keyword
    const allReturned = selectIssuesToEnqueue(
      [inv, notInv, inv2, inv3],
      strict,
      "owner/repo",
    );
    // `selectIssuesToEnqueue` returns the FULL list with a triggered flag.
    expect(allReturned.map((s) => s.issue.number)).toEqual([1, 2, 3, 4]);
    // Only the @-mention passes under the mention-only strict config.
    const triggered = filterTriggered(allReturned);
    expect(triggered.map((s) => s.issue.number)).toEqual([3]);

    // With a trigger_keyword configured, the keyword match passes too.
    const withKeyword: NoodleConfig = {
      ...config,
      triggers: {
        trigger_on_mention: true,
        trigger_keywords: ["agent-fix"],
        trigger_on_open: false,
      },
    };
    const keywordResult = selectIssuesToEnqueue(
      [inv, notInv, inv2, inv3],
      withKeyword,
      "owner/repo",
    );
    expect(filterTriggered(keywordResult).map((s) => s.issue.number)).toEqual([3, 4]);
  });
});

/** In-memory ScanStateStore for tests. */
class MemState implements ScanStateStore {
  private map = new Map<string, string>();
  getLastUpdated(repo: string) {
    return this.map.get(repo) ?? null;
  }
  setLastUpdated(repo: string, ts: string) {
    this.map.set(repo, ts);
  }
}

describe("runScanOnce", () => {
  it("lists, selects, enqueues, and advances the watermark", async () => {
    const enqueued: { repo: string; n: number }[] = [];
    const state = new MemState();
    const before = new Date(Date.now() - 1000).toISOString();
    state.setLastUpdated("owner/repo", before);

    await runScanOnce(config, {
      listOpenIssues: async () => [issue(1, { body: "/claude" }), issue(2)],
      enqueue: async (repo, n) => {
        enqueued.push({ repo, n });
      },
      state,
    });

    expect(enqueued).toEqual([
      { repo: "owner/repo", n: 1 },
      { repo: "owner/repo", n: 2 },
    ]);
    // Watermark advanced past the previous value.
    expect(new Date(state.getLastUpdated("owner/repo")!).getTime()).toBeGreaterThan(
      new Date(before).getTime(),
    );
  });

  it("passes the stored lastSeen as the `since` filter to listOpenIssues", async () => {
    const state = new MemState();
    const iso = "2025-01-01T00:00:00.000Z";
    state.setLastUpdated("owner/repo", iso);
    let seenSince: string | undefined;
    await runScanOnce(config, {
      listOpenIssues: async (_repo, since) => {
        seenSince = since;
        return [];
      },
      enqueue: async () => {},
      state,
    });
    expect(seenSince).toBe(iso);
  });

  it("swallows per-repo errors so one bad repo doesn't stop the scan", async () => {
    const state = new MemState();
    const enqueued: number[] = [];
    const cfg: NoodleConfig = {
      ...config,
      scheduler: { ...config.scheduler, repos: ["bad/repo", "good/repo"] },
    };
    await runScanOnce(cfg, {
      listOpenIssues: async (repo) => {
        if (repo === "bad/repo") throw new Error("404");
        return [issue(1)];
      },
      enqueue: async (_repo, n) => {
        enqueued.push(n);
      },
      state,
    });
    // good/repo still got scanned despite bad/repo throwing.
    expect(enqueued).toEqual([1]);
  });
});

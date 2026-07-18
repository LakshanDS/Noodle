import { describe, it, expect } from "vitest";
import { expandTags } from "../src/engine/tags.js";
import type { SysFacts } from "../src/util/sysinfo.js";
import type { GitHubClient, IssueData, PullRequestData } from "../src/github/client.js";

/** Build a mock GitHubClient with controllable issue/PR lists. */
function mockGh(issues: IssueData[] = [], prs: PullRequestData[] = []): GitHubClient {
  return {
    listOpenIssues: async () => issues,
    listOpenPRs: async () => prs,
  } as unknown as GitHubClient;
}

const facts: SysFacts = {
  cpus: 4,
  totalMemoryMb: 8192,
  freeMemoryMb: 4096,
  memoryLimitMb: undefined,
  inContainer: false,
  platform: "linux x64",
  tier: "capable",
};

describe("expandTags — system tags", () => {
  it("expands {system.cpu}", async () => {
    const result = await expandTags("CPU: {system.cpu}", { sysFacts: facts, gh: mockGh(), repo: "o/r" });
    expect(result).toBe("CPU: CPU cores: 4");
  });

  it("expands {system.ram}", async () => {
    const result = await expandTags("RAM: {system.ram}", { sysFacts: facts, gh: mockGh(), repo: "o/r" });
    expect(result).toContain("8192 MB total");
    expect(result).toContain("4096 MB free");
  });

  it("expands {system.ram} with cgroup limit", async () => {
    const f = { ...facts, memoryLimitMb: 2048 };
    const result = await expandTags("RAM: {system.ram}", { sysFacts: f, gh: mockGh(), repo: "o/r" });
    expect(result).toContain("limit: 2048 MB");
  });

  it("expands {system.os}", async () => {
    const result = await expandTags("OS: {system.os}", { sysFacts: facts, gh: mockGh(), repo: "o/r" });
    expect(result).toBe("OS: linux x64");
  });

  it("expands {system.tier}", async () => {
    const result = await expandTags("Tier: {system.tier}", { sysFacts: facts, gh: mockGh(), repo: "o/r" });
    expect(result).toBe("Tier: capable");
  });

  it("expands {system} to the full guidance block", async () => {
    const result = await expandTags("{system}", { sysFacts: facts, gh: mockGh(), repo: "o/r" });
    expect(result).toContain("System info");
    expect(result).toContain("CPU cores visible: 4");
  });

  it("leaves unknown {system.xxx} as-is", async () => {
    const result = await expandTags("{system.disk}", { sysFacts: facts, gh: mockGh(), repo: "o/r" });
    expect(result).toBe("{system.disk}");
  });
});

describe("expandTags — issue tags", () => {
  const issues: IssueData[] = [
    { number: 10, title: "Bug in login", body: "", labels: ["bug"], html_url: "https://github.com/o/r/issues/10" },
    { number: 9, title: "Feature request", body: "", labels: [], html_url: "https://github.com/o/r/issues/9" },
  ];

  it("expands {issue} to all issues", async () => {
    const result = await expandTags("{issue}", { sysFacts: facts, gh: mockGh(issues), repo: "o/r" });
    expect(result).toContain("#10 Bug in login");
    expect(result).toContain("[bug]");
    expect(result).toContain("#9 Feature request");
  });

  it("expands {issue.0} to the first issue", async () => {
    const result = await expandTags("{issue.0}", { sysFacts: facts, gh: mockGh(issues), repo: "o/r" });
    expect(result).toContain("#10 Bug in login");
    expect(result).not.toContain("#9");
  });

  it("expands {issue.1} to the second issue", async () => {
    const result = await expandTags("{issue.1}", { sysFacts: facts, gh: mockGh(issues), repo: "o/r" });
    expect(result).toContain("#9 Feature request");
  });

  it("expands out-of-range {issue.5} to empty string", async () => {
    const result = await expandTags("X{issue.5}Y", { sysFacts: facts, gh: mockGh(issues), repo: "o/r" });
    expect(result).toBe("XY");
  });

  it("shows _(none)_ when no issues", async () => {
    const result = await expandTags("{issue}", { sysFacts: facts, gh: mockGh([]), repo: "o/r" });
    expect(result).toBe("_(none)_");
  });
});

describe("expandTags — PR tags", () => {
  const prs: PullRequestData[] = [
    { number: 20, title: "Fix auth", body: "", head_branch: "fix/auth", head_repo: "o/r", base_branch: "main", is_fork: false, html_url: "https://github.com/o/r/pull/20", state: "open" },
    { number: 18, title: "Add tests", body: "", head_branch: "feat/tests", head_repo: "o/r", base_branch: "main", is_fork: false, html_url: "https://github.com/o/r/pull/18", state: "open" },
  ];

  it("expands {pr} to all PRs", async () => {
    const result = await expandTags("{pr}", { sysFacts: facts, gh: mockGh([], prs), repo: "o/r" });
    expect(result).toContain("#20 Fix auth");
    expect(result).toContain("fix/auth → main");
    expect(result).toContain("#18 Add tests");
  });

  it("expands {pr.0} to the first PR", async () => {
    const result = await expandTags("{pr.0}", { sysFacts: facts, gh: mockGh([], prs), repo: "o/r" });
    expect(result).toContain("#20 Fix auth");
    expect(result).not.toContain("#18");
  });

  it("expands out-of-range {pr.9} to empty string", async () => {
    const result = await expandTags("X{pr.9}Y", { sysFacts: facts, gh: mockGh([], prs), repo: "o/r" });
    expect(result).toBe("XY");
  });
});

describe("expandTags — mixed and edge cases", () => {
  it("expands multiple tags in one string", async () => {
    const issues: IssueData[] = [
      { number: 1, title: "Test", body: "", labels: [], html_url: "url" },
    ];
    const text = "CPU: {system.cpu}\nIssues:\n{issue}";
    const result = await expandTags(text, { sysFacts: facts, gh: mockGh(issues), repo: "o/r" });
    expect(result).toContain("CPU cores: 4");
    expect(result).toContain("#1 Test");
  });

  it("leaves unknown tags as-is", async () => {
    const result = await expandTags("Hello {unknown} world", { sysFacts: facts, gh: mockGh(), repo: "o/r" });
    expect(result).toBe("Hello {unknown} world");
  });

  it("handles empty string", async () => {
    const result = await expandTags("", { sysFacts: facts, gh: mockGh(), repo: "o/r" });
    expect(result).toBe("");
  });

  it("caches PR list — {pr} and {pr.0} fetch once", async () => {
    let fetchCount = 0;
    const gh = {
      listOpenIssues: async () => [],
      listOpenPRs: async () => {
        fetchCount++;
        return [
          { number: 1, title: "A", body: "", head_branch: "b", head_repo: "o/r", base_branch: "main", is_fork: false, html_url: "u", state: "open" },
        ];
      },
    } as unknown as GitHubClient;

    const result = await expandTags("{pr}\n---\n{pr.0}", { sysFacts: facts, gh, repo: "o/r" });
    expect(fetchCount).toBe(1);
    expect(result).toContain("#1 A");
  });

  it("gracefully degrades on API failure", async () => {
    const gh = {
      listOpenIssues: async () => { throw new Error("API down"); },
      listOpenPRs: async () => { throw new Error("API down"); },
    } as unknown as GitHubClient;

    const result = await expandTags("Issues: {issue}\nPRs: {pr}", { sysFacts: facts, gh, repo: "o/r" });
    expect(result).toContain("_(none)_");
    expect(result).not.toThrow;
  });
});

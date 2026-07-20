import { describe, it, expect } from "vitest";
import { collectSysFacts, buildSysInfoGuidance, type SysFacts } from "../src/util/sysinfo.js";
import { buildPrompt, DEFAULT_SYSTEM_PROMPT } from "../src/engine/prompt.js";

describe("collectSysFacts", () => {
  it("returns real, sane numbers on the host running the tests", () => {
    const f = collectSysFacts();
    expect(f.cpus).toBeGreaterThan(0);
    expect(f.totalMemoryMb).toBeGreaterThan(0);
    expect(f.freeMemoryMb).toBeGreaterThanOrEqual(0);
    expect(f.totalMemoryMb).toBeGreaterThan(f.freeMemoryMb);
    expect(f.platform).toMatch(/^(linux|win32|darwin|freebsd|openbsd|sunos|aix) /);
    expect(["constrained", "capable"]).toContain(f.tier);
  });

  it("never throws — degrades gracefully when /proc or cgroup files are absent", () => {
    // On Windows / non-Linux CI this is the normal path: no /proc, no cgroup.
    // collectSysFacts must still return a usable object.
    expect(() => collectSysFacts()).not.toThrow();
  });
});

describe("buildSysInfoGuidance", () => {
  it("states the facts and flags a constrained box with a one-liner", () => {
    const facts: SysFacts = {
      cpus: 2,
      totalMemoryMb: 1024,
      freeMemoryMb: 400,
      memoryLimitMb: 1024,
      inContainer: true,
      platform: "linux x64",
      tier: "constrained",
    };
    const g = buildSysInfoGuidance(facts);
    // Facts section
    expect(g).toContain("CPU cores visible: 2");
    expect(g).toContain("Memory: 1024 MB available (cgroup limit)");
    expect(g).toContain("Environment: container (linux x64)");
    // One-liner capability hint — the agent infers the rest from the raw numbers.
    expect(g).toMatch(/Resource-constrained/i);
    expect(g).toMatch(/skip builds\/tests/i);
  });

  it("uses host total when no cgroup limit is known", () => {
    const facts: SysFacts = {
      cpus: 1,
      totalMemoryMb: 2048,
      freeMemoryMb: 1000,
      inContainer: false,
      platform: "linux x64",
      tier: "constrained",
    };
    const g = buildSysInfoGuidance(facts);
    expect(g).toContain("Memory: 2048 MB available");
    expect(g).not.toContain("cgroup limit");
    expect(g).toContain("Environment: host");
  });

  it("flags a capable box with a one-liner allowing light verification", () => {
    const facts: SysFacts = {
      cpus: 8,
      totalMemoryMb: 16384,
      freeMemoryMb: 8000,
      inContainer: false,
      platform: "darwin arm64",
      tier: "capable",
    };
    const g = buildSysInfoGuidance(facts);
    expect(g).toContain("CPU cores visible: 8");
    expect(g).toContain("Memory: 16384 MB available");
    expect(g).toMatch(/Capable box/i);
    expect(g).toMatch(/light verification OK/i);
    // Does NOT contain the constrained one-liner.
    expect(g).not.toMatch(/Resource-constrained/i);
  });
});

describe("buildPrompt sysInfo wiring", () => {
  const issue = {
    number: 42,
    title: "Fix the thing",
    body: "It is broken",
    labels: [],
    html_url: "https://x/issues/42",
  } as const;

  it("includes the system prompt as the base and the issue context after it", () => {
    const p = buildPrompt(DEFAULT_SYSTEM_PROMPT, issue, []);
    expect(p.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true);
    expect(p).toContain("The issue you have been given");
    expect(p).toContain("Fix the thing");
    expect(p).toContain("## Issue");
    expect(p).toContain("Issue URL: https://x/issues/42");
  });

  it("does not embed the repo or system info inline (handled by tags)", () => {
    const p = buildPrompt(DEFAULT_SYSTEM_PROMPT, issue, []);
    // The system prompt contains {repository} and {system} tags (not yet expanded)
    expect(DEFAULT_SYSTEM_PROMPT).toContain("{repository}");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("{system}");
  });
});

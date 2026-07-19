import { describe, it, expect } from "vitest";
import { collectSysFacts, buildSysInfoGuidance, type SysFacts } from "../src/util/sysinfo.js";
import { buildPrompt } from "../src/engine/prompt.js";

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

  it("prepends the sysInfo block when supplied", () => {
    const sysInfo =
      "## System info (this machine, probed at run time)\n\n- CPU cores visible: 1\n- Memory: 512 MB";
    const p = buildPrompt(issue, [], "o/r", "Noodle", sysInfo);
    // sysInfo block is at the top, followed by a separator, then the rest.
    expect(p.indexOf("System info")).toBeLessThan(p.indexOf("working on an issue"));
    expect(p).toContain("---");
    expect(p).toContain(sysInfo);
    // Existing prompt content is still present.
    expect(p).toContain("You are working on an issue in the GitHub repository `o/r`");
    expect(p).toContain("Fix the thing");
  });

  it("is unchanged when no sysInfo is supplied (back-compat)", () => {
    const p = buildPrompt(issue, [], "o/r", "Noodle");
    expect(p.startsWith("You are working on an issue")).toBe(true);
    expect(p).not.toContain("System info");
  });
});

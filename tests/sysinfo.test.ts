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
  it("states the facts and forbids builds on a constrained box", () => {
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
    // The load-bearing guidance
    expect(g).toMatch(/resource-constrained/i);
    expect(g).toMatch(/do ?\*\*not\*\* ?run build/i);
    expect(g).toContain("npm run build");
    expect(g).toContain("pytest");
    expect(g).toMatch(/verify by .{0,40}reason/i);
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

  it("keeps the capable branch short and allows light verification", () => {
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
    expect(g).toMatch(/looks capable/i);
    expect(g).toMatch(/light/i);
    // Does NOT contain the hard forbid from the constrained branch.
    expect(g).not.toMatch(/do ?\*\*not\*\* ?run build/i);
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

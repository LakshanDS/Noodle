/**
 * Read the host's hardware facts and shape them into guidance the agent can act
 * on. The deployment box is often a small VPS / container that can't survive a
 * real build or test-suite run, so the agent must NOT fall back to "let me run
 * the build to verify" the way it would on a dev laptop. Instead we probe the
 * environment at run time and tell the agent exactly how constrained it is, then
 * let it decide how to verify its change (static reasoning, type-checks that
 * don't compile, reading, etc.).
 *
 * All collection is best-effort: any failure (platform oddity, cgroup v1 vs v2,
 * missing file) degrades gracefully — we just report what we could read and let
 * the guidance default to the safe "constrained" stance.
 */

import { cpus, totalmem, freemem } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface SysFacts {
  /** Logical CPU cores visible to the process. */
  cpus: number;
  /** Total system RAM in MB. */
  totalMemoryMb: number;
  /** Free system RAM in MB at collection time. */
  freeMemoryMb: number;
  /** Process memory cap (cgroup / container limit) in MB, if discoverable. */
  memoryLimitMb?: number;
  /** True when running inside a container (cgroup mount looks containerized). */
  inContainer: boolean;
  /** OS/platform string (e.g. "linux x64"). */
  platform: string;
  /**
   * Coarse capacity tier derived from the facts above. Drives the wording of
   * the guidance so the prompt stays short.
   *   - "constrained": likely can't build/test (small VPS / container).
   *   - "capable":     looks like a real box; build/test is allowed but still
   *                    should be light.
   */
  tier: "constrained" | "capable";
}

/**
 * Thresholds for the `tier` decision. Conservative: anything below these is
 * treated as constrained. Tunable in one place.
 */
const CONSTRAINED_CPUS = 3;
const CONSTRAINED_MEMORY_MB = 2048;

/**
 * Probe the host and return the facts. Never throws — collection failures are
 * swallowed (the field is just left undefined / the flag stays false) so a run
 * is never blocked by a missing /proc file or an unfamiliar cgroup layout.
 */
export function collectSysFacts(): SysFacts {
  const cpuCount = cpus()?.length ?? 0;
  const totalMb = Math.round((totalmem() / 1024 / 1024));
  const freeMb = Math.round((freemem() / 1024 / 1024));
  const memoryLimitMb = readCgroupMemoryLimitMb();
  const inContainer = detectContainer();

  // Use the tightest memory bound we know: a cgroup cap beats the host total
  // when present (the process can't use more than the limit even on a big host).
  const effectiveMemoryMb = memoryLimitMb ?? totalMb;
  const tier: SysFacts["tier"] =
    cpuCount > 0 && cpuCount < CONSTRAINED_CPUS && effectiveMemoryMb < CONSTRAINED_MEMORY_MB
      ? "constrained"
      : "capable";

  return {
    cpus: cpuCount,
    totalMemoryMb: totalMb,
    freeMemoryMb: freeMb,
    memoryLimitMb,
    inContainer,
    platform: `${process.platform} ${process.arch}`,
    tier,
  };
}

/**
 * Read the cgroup memory max (v2) or v1 hierarchy limit, in MB. Returns
 * undefined when there's no limit or it can't be read — callers treat that as
 * "no container cap, fall back to host totalmem".
 */
function readCgroupMemoryLimitMb(): number | undefined {
  // cgroup v2 — single file at /sys/fs/cgroup/memory.max
  const v2 = readUintMb("/sys/fs/cgroup/memory.max");
  if (v2 !== undefined) return v2;

  // cgroup v1 — the limit for the memory controller. Path varies by distro;
  // try the canonical mount first.
  const v1 = readUintMb(join("/sys/fs/cgroup/memory", "memory.limit_in_bytes"));
  if (v1 !== undefined) return v1;

  return undefined;
}

/**
 * Read a file expected to hold a positive integer (bytes), return it in MB.
 * Returns undefined on missing file, read error, or a non-numeric / "max"
 * sentinel. cgroup v2 writes "max" when there's no limit; v1 writes a very large
 * number (treated as no limit when it exceeds the host RAM we'd believe).
 */
function readUintMb(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
  if (!raw || raw === "max") return undefined;
  const bytes = Number(raw);
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  // cgroup v1 uses ~2^63 as "no limit"; anything absurd is meaningless.
  if (bytes > Number.MAX_SAFE_INTEGER / 2) return undefined;
  return Math.round(bytes / 1024 / 1024);
}

/**
 * Detect a containerized environment. Checks the strongest signals only — this
 * is a hint, not a guarantee, and only affects how cautious the wording is.
 */
function detectContainer(): boolean {
  // /proc/1/cgroup in a container usually references docker/lxc/kubepods.
  if (existsSync("/proc/1/cgroup")) {
    try {
      const c = readFileSync("/proc/1/cgroup", "utf8");
      if (/docker|lxc|kubepods|containerd/i.test(c)) return true;
    } catch {
      /* ignore */
    }
  }
  // /run/.containerenv (podman) or /.dockerenv (docker) are reliable markers.
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

/**
 * Render the facts into a short, agent-facing system-info block plus the
 * behavioral guidance that follows from them. This is what gets prepended to the
 * user prompt.
 *
 * The "constrained" branch is the load-bearing one: it explicitly forbids
 * running builds / test suites / heavy commands and steers the agent toward
 * verification by reasoning, reading, and static checks. The "capable" branch is
 * shorter — build/test is allowed but the agent should keep it light.
 */
export function buildSysInfoGuidance(facts: SysFacts): string {
  const mem = facts.memoryLimitMb ?? facts.totalMemoryMb;
  const lines: string[] = [
    "## System info (this machine, probed at run time)",
    "",
    `- CPU cores visible: ${facts.cpus || "unknown"}`,
    `- Memory: ${mem} MB available${facts.memoryLimitMb ? " (cgroup limit)" : ""}`,
    `- Environment: ${facts.inContainer ? "container" : "host"} (${facts.platform})`,
    "",
  ];

  if (facts.tier === "constrained") {
    lines.push(
      "**This box is resource-constrained.** It does NOT have enough CPU or RAM to",
      "run builds, compile, or execute test suites — attempting to will hang or",
      "crash the run. So:",
      "- Do **NOT** run build/test commands (`npm run build`, `tsc`, `cargo build`,",
      "  `pytest`, `go test`, full suites, etc.) to verify your change.",
      "- Verify by **reasoning** about the code, reading the relevant files,",
      "  tracing types/callers, and checking diffs — not by executing.",
      "- Light, fast checks (a single `--version`, `ls`, `cat` of a config) are",
      "  fine. Anything that compiles, links, or spawns a runtime is not.",
    );
  } else {
    lines.push(
      "This box looks capable enough for **light** verification. If you run a",
      "build or test, keep it minimal (one targeted command, not the whole",
      "suite). Skip it if you can verify by reading and reasoning.",
    );
  }

  return lines.join("\n");
}

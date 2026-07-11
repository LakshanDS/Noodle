import { describe, it, expect } from "vitest";
import { templateTitle } from "../src/engine/title.js";

describe("templateTitle (fallback)", () => {
  it("uses the first non-empty line of the task, capped to 80 chars", () => {
    expect(templateTitle("Find bugs and open issues.")).toBe("Find bugs and open issues.");
  });

  it("skips leading blank lines", () => {
    expect(templateTitle("\n\n  \nFind bugs.")).toBe("Find bugs.");
  });

  it("truncates a long first line with an ellipsis on a word boundary", () => {
    const long = "Check if the logs still use cron=true when logging to the console during scheduled runs are running";
    const title = templateTitle(long);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back to a generic title when the task is blank", () => {
    expect(templateTitle("   ")).toBe("scheduled sweep");
    expect(templateTitle("")).toBe("scheduled sweep");
  });
});

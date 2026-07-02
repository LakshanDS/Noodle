import { describe, it, expect } from "vitest";
import { NoodleConfigSchema, crossValidate } from "../src/config/schema.js";

const validBase = {
  default_profile: "cheap",
  profiles: {
    cheap: { provider: "openrouter", model: "haiku" },
    claude: { provider: "anthropic", model: "sonnet" },
  },
  routing: [{ kind: "slash", match: "/claude", profile: "claude" }],
};

describe("config schema", () => {
  it("parses a valid config and applies defaults", () => {
    const c = NoodleConfigSchema.parse(validBase);
    expect(c.profiles.cheap.thinking_level).toBe("off"); // default
    expect(c.profiles.cheap.tools).toContain("read"); // default tool set
    expect(c.routing).toHaveLength(1);
  });

  it("rejects an unknown thinking_level", () => {
    const r = NoodleConfigSchema.safeParse({
      ...validBase,
      profiles: { cheap: { provider: "x", model: "y", thinking_level: "nope" } },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a slash rule whose match lacks leading slash", () => {
    const c = NoodleConfigSchema.parse({
      ...validBase,
      routing: [{ kind: "slash", match: "claude", profile: "claude" }],
    });
    const errs = crossValidate(c);
    expect(errs.join("\n")).toMatch(/must start with "\/"/);
  });
});

describe("crossValidate", () => {
  it("flags a routing rule pointing at an undefined profile", () => {
    const c = NoodleConfigSchema.parse({
      ...validBase,
      routing: [{ kind: "label", match: "x", profile: "ghost" }],
    });
    expect(crossValidate(c).join("\n")).toMatch(/not defined/);
  });

  it("flags default_profile pointing at an undefined profile", () => {
    const c = NoodleConfigSchema.parse({ ...validBase, default_profile: "ghost" });
    expect(crossValidate(c).join("\n")).toMatch(/default_profile "ghost"/);
  });

  it("passes on a fully valid config", () => {
    expect(crossValidate(NoodleConfigSchema.parse(validBase))).toHaveLength(0);
  });
});

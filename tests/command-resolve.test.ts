import { describe, it, expect } from "vitest";
import { resolveCommand } from "../src/commands/resolve.js";
import type { CommandRow } from "../src/server/command-store.js";
import type { IssueInput } from "../src/profiles/types.js";

function cmd(over: Partial<CommandRow> & Pick<CommandRow, "id" | "trigger">): CommandRow {
  return {
    description: "",
    system_prompt: "",
    profile: null,
    enabled: 1,
    is_builtin: 0,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    ...over,
  } as CommandRow;
}

function issue(over: Partial<IssueInput>): IssueInput {
  return { title: "t", body: "", labels: [], comments: [], ...over };
}

describe("resolveCommand", () => {
  it("returns null when no commands match", () => {
    const c = resolveCommand([cmd({ id: 1, trigger: "question" })], issue({ body: "hello" }));
    expect(c).toBeNull();
  });

  it("returns null for an empty command list", () => {
    expect(resolveCommand([], issue({ body: "/anything" }))).toBeNull();
  });

  it("matches a /trigger in the issue body", () => {
    const out = resolveCommand(
      [cmd({ id: 1, trigger: "question" })],
      issue({ body: "/question what is this" }),
    );
    expect(out?.trigger).toBe("question");
  });

  it("matches a /trigger in a comment", () => {
    const out = resolveCommand(
      [cmd({ id: 1, trigger: "review" })],
      issue({ body: "no match here", comments: ["/review please"] }),
    );
    expect(out?.trigger).toBe("review");
  });

  it("body wins over comments (scanned first)", () => {
    const body = cmd({ id: 1, trigger: "a" });
    const comment = cmd({ id: 2, trigger: "b" });
    const out = resolveCommand(
      [comment, body],
      issue({ body: "/a body", comments: ["/b comment"] }),
    );
    expect(out?.trigger).toBe("a");
  });

  it("lower-id command wins when both appear in the same text (built-in yields to specific)", () => {
    const builtin = cmd({ id: 1, trigger: "noodle", is_builtin: 1 });
    const specific = cmd({ id: 5, trigger: "review" });
    const out = resolveCommand(
      [specific, builtin],
      issue({ body: "/noodle /review please" }),
    );
    expect(out?.trigger).toBe("noodle");
  });

  it("a more specific command wins when the built-in is absent from text", () => {
    const builtin = cmd({ id: 1, trigger: "noodle", is_builtin: 1 });
    const specific = cmd({ id: 5, trigger: "review" });
    const out = resolveCommand([builtin, specific], issue({ body: "/review only" }));
    expect(out?.trigger).toBe("review");
  });

  it("does not match a trigger as a substring of a larger word", () => {
    expect(
      resolveCommand(
        [cmd({ id: 1, trigger: "q" })],
        issue({ body: "/queue this up" }),
      ),
    ).toBeNull();
  });

  it("ignores disabled commands", () => {
    const out = resolveCommand(
      [cmd({ id: 1, trigger: "off", enabled: 0 })],
      issue({ body: "/off now" }),
    );
    expect(out).toBeNull();
  });

  it("is case-insensitive on the trigger", () => {
    const out = resolveCommand(
      [cmd({ id: 1, trigger: "question" })],
      issue({ body: "/QUESTION please" }),
    );
    expect(out?.trigger).toBe("question");
  });
});

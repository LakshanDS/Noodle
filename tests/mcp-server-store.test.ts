import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { McpServerStore } from "../src/server/mcp-server-store.js";

/**
 * Tests for the McpServerStore — the DB-backed CRUD for MCP server definitions.
 * Uses an in-memory SQLite database (no disk, no cleanup needed).
 */

function makeStore(): McpServerStore {
  const db = new Database(":memory:");
  return McpServerStore.fromDb(db);
}

describe("McpServerStore — CRUD", () => {
  let store: McpServerStore;

  beforeEach(() => {
    store = makeStore();
  });

  it("creates and retrieves a stdio server", () => {
    store.create({
      name: "filesystem",
      server: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], description: "File system access" },
    });
    const s = store.get("filesystem");
    expect(s).toBeDefined();
    expect(s!.name).toBe("filesystem");
    expect(s!.server.type).toBe("stdio");
    expect(s!.server.command).toBe("npx");
    expect(s!.server.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem"]);
    expect(s!.server.description).toBe("File system access");
  });

  it("creates and retrieves an sse server", () => {
    store.create({
      name: "remote",
      server: { type: "sse", url: "https://mcp.example.com/sse", args: [] },
    });
    const s = store.get("remote");
    expect(s).toBeDefined();
    expect(s!.server.type).toBe("sse");
    expect(s!.server.url).toBe("https://mcp.example.com/sse");
  });

  it("returns undefined for missing servers", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("lists all servers sorted by name", () => {
    store.create({ name: "z-server", server: { type: "stdio", command: "node", args: [] } });
    store.create({ name: "a-server", server: { type: "stdio", command: "node", args: [] } });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("a-server");
    expect(list[1].name).toBe("z-server");
  });

  it("updates a server's definition", () => {
    store.create({ name: "fs", server: { type: "stdio", command: "npx", args: ["old"] } });
    store.update("fs", { command: "node", args: ["new"] });
    const s = store.get("fs");
    expect(s!.server.command).toBe("node");
    expect(s!.server.args).toEqual(["new"]);
  });

  it("throws on duplicate create", () => {
    store.create({ name: "fs", server: { type: "stdio", command: "npx", args: [] } });
    expect(() => store.create({ name: "fs", server: { type: "stdio", command: "node", args: [] } }))
      .toThrow(/already exists/);
  });

  it("throws on update of nonexistent server", () => {
    expect(() => store.update("ghost", { command: "node" })).toThrow(/not found/);
  });

  it("deletes a server", () => {
    store.create({ name: "fs", server: { type: "stdio", command: "npx", args: [] } });
    store.delete("fs");
    expect(store.get("fs")).toBeUndefined();
  });

  it("delete is idempotent (missing row is a no-op)", () => {
    store.delete("nonexistent"); // should not throw
  });
});

describe("McpServerStore — getByNames", () => {
  let store: McpServerStore;

  beforeEach(() => {
    store = makeStore();
    store.create({ name: "fs", server: { type: "stdio", command: "npx", args: ["-y", "fs-mcp"], env: { ROOT: "/tmp" } } });
    store.create({ name: "db", server: { type: "stdio", command: "node", args: ["db-mcp.js"] } });
  });

  it("resolves existing names to their definitions", () => {
    const result = store.getByNames(["fs", "db"]);
    expect(Object.keys(result)).toEqual(["fs", "db"]);
    expect(result.fs.type).toBe("stdio");
    expect(result.fs.command).toBe("npx");
    expect(result.db.type).toBe("stdio");
  });

  it("skips unknown names", () => {
    const result = store.getByNames(["fs", "ghost", "db"]);
    expect(Object.keys(result)).toEqual(["fs", "db"]);
  });

  it("returns empty record for empty input", () => {
    expect(store.getByNames([])).toEqual({});
  });

  it("returns empty record when all names are unknown", () => {
    expect(store.getByNames(["a", "b"])).toEqual({});
  });
});

describe("McpServerStore — validation", () => {
  let store: McpServerStore;

  beforeEach(() => {
    store = makeStore();
  });

  it("rejects an update that would produce an invalid definition", () => {
    store.create({ name: "fs", server: { type: "stdio", command: "npx", args: [] } });
    // Setting type to an invalid value should fail validation.
    expect(() => store.update("fs", { type: "invalid" as never })).toThrow();
  });
});

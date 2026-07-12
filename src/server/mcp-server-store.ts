import type { Database as Db } from "better-sqlite3";
import {
  McpServerDefinitionSchema,
  type McpServerDefinition,
} from "../config/schema.js";
import { log } from "../util/log.js";

/**
 * DB-backed store for MCP (Model Context Protocol) server definitions — the
 * shared library the dashboard's "MCP Servers" nav item manages.
 *
 * Each row is a named server definition (type, command/url, args, env). Profiles
 * reference servers by name via `ProfileSchema.mcp_servers: string[]`; the
 * serve-mode worker resolves those names to full definitions (via `getByNames`)
 * before passing the profile to the runtime. Only the OpenCode runtime loads
 * them; pi runs ignore the selection.
 *
 * Mirrors ProfileStore's pattern: a class over a shared better-sqlite3 handle,
 * with `fromDb` for in-memory tests. Every read/write validates the JSON blob
 * against `McpServerDefinitionSchema` so malformed data can't land in the table
 * or leak into the engine.
 */

export interface McpServerRow {
  /** Server name — the unique key profiles reference in their mcp_servers list. */
  name: string;
  /** JSON-serialized `McpServerDefinition` (validated against the schema). */
  data: string;
  created_at: string;
  updated_at: string;
}

/** A server row with its data parsed back into a typed definition. */
export interface StoredMcpServer {
  name: string;
  server: McpServerDefinition;
  created_at: string;
  updated_at: string;
}

/** A lightweight view for list endpoints — name + identity fields. */
export interface McpServerSummary {
  name: string;
  type: McpServerDefinition["type"];
  description: string;
  created_at: string;
  updated_at: string;
}

/** Input for creating a new server. Callers must validate the name first. */
export interface NewMcpServer {
  name: string;
  server: McpServerDefinition;
}

/** Partial update for a server. The name is immutable post-create. */
export type McpServerUpdate = Partial<McpServerDefinition>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_servers (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/** Parse + validate a row's data blob into a typed definition. Throws on malformed JSON/schema. */
function parseServer(row: McpServerRow | undefined): StoredMcpServer | undefined {
  if (!row) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    throw new Error(`mcp_servers.${row.name}: data is not valid JSON`);
  }
  const result = McpServerDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `mcp_servers.${row.name}: invalid definition — ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return {
    name: row.name,
    server: result.data,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class McpServerStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  /** For tests that want to inject an in-memory DB. */
  static fromDb(db: Db): McpServerStore {
    return new McpServerStore(db);
  }

  /** Create a server. Throws if the name already exists. */
  create(input: NewMcpServer): StoredMcpServer {
    if (this.get(input.name)) {
      throw new Error(`mcp_servers.${input.name}: already exists`);
    }
    this.db
      .prepare(
        `INSERT INTO mcp_servers (name, data) VALUES (@name, @data)`,
      )
      .run({ name: input.name, data: JSON.stringify(input.server) });
    return this.get(input.name)!;
  }

  /** Apply a partial update (name is immutable). */
  update(name: string, update: McpServerUpdate): StoredMcpServer {
    const current = this.get(name);
    if (!current) throw new Error(`mcp_servers.${name}: not found`);
    const merged: McpServerDefinition = { ...current.server, ...update };
    // Re-validate the merged definition.
    const result = McpServerDefinitionSchema.safeParse(merged);
    if (!result.success) {
      throw new Error(
        `mcp_servers.${name}: invalid definition — ${result.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    this.db
      .prepare(
        `UPDATE mcp_servers SET data = @data, updated_at = datetime('now') WHERE name = @name`,
      )
      .run({ name, data: JSON.stringify(result.data) });
    return this.get(name)!;
  }

  /** Delete a server by name. Idempotent — missing rows are a no-op. */
  delete(name: string): void {
    this.db.prepare("DELETE FROM mcp_servers WHERE name = ?").run(name);
  }

  /** Fetch one server by name. Throws on malformed data; returns undefined if missing. */
  get(name: string): StoredMcpServer | undefined {
    const row = this.db.prepare("SELECT * FROM mcp_servers WHERE name = ?").get(name) as
      | McpServerRow
      | undefined;
    return parseServer(row);
  }

  /** All servers, newest-first by name. */
  list(): StoredMcpServer[] {
    const rows = this.db
      .prepare("SELECT * FROM mcp_servers ORDER BY name ASC")
      .all() as McpServerRow[];
    return rows.map((r) => parseServer(r)!).filter(Boolean);
  }

  /**
   * Resolve a list of server names to their full definitions. Unknown names are
   * silently skipped (a profile referencing a deleted server just doesn't get
   * it). Returns a record keyed by name — the shape the OpenCode adapter reads.
   */
  getByNames(names: string[]): Record<string, McpServerDefinition> {
    if (!names.length) return {};
    const out: Record<string, McpServerDefinition> = {};
    for (const name of names) {
      const stored = this.get(name);
      if (stored) out[name] = stored.server;
      else log.warn({ name }, "mcp server referenced by profile not found in store — skipping");
    }
    return out;
  }
}

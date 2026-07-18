/**
 * GitHub issue status labels applied across an agent run's lifecycle.
 *
 * Three stages:
 *   cooking — applied when a run STARTS (the agent is working)
 *   cooked  — applied when a run finishes successfully (cooking is removed)
 *   failed  — applied when a run errors out (cooking is removed)
 *
 * Label NAMES incorporate the agent name (hardcoded "Noodle" now — the
 * agent_name setting was removed). Colors are 6-char hex WITHOUT a leading '#'
 * (GitHub API convention).
 *
 * Both the global defaults (Settings → GitHub labels) and per-command overrides
 * use the same `LabelSet` shape, stored as a JSON string. `null`/unset means
 * "use the hardcoded defaults below".
 */

/** One status label: a GitHub label name + a 6-char hex color (no '#'). */
export interface LabelDef {
  name: string;
  color: string;
}

/** A full 3-stage label set (cooking/cooked/failed). */
export interface LabelSet {
  cooking: LabelDef;
  cooked: LabelDef;
  failed: LabelDef;
}

/** The 3 stages, in order, for iteration. */
export const LABEL_STAGES = ["cooking", "cooked", "failed"] as const;
export type LabelStage = (typeof LABEL_STAGES)[number];

/**
 * The hardcoded default label set. The base over which DB-configured overrides
 * (global or per-command) are merged. `description` is derived from the name and
 * is NOT user-configurable — it's metadata GitHub stores on the label.
 */
export function defaultLabelSet(): LabelSet {
  const agent = "Noodle";
  return {
    cooking: { name: `${agent} is cooking`, color: "d4a942" },
    cooked: { name: `${agent} cooked here`, color: "6fae6f" },
    failed: { name: `${agent} got Cooked`, color: "c76b6b" },
  };
}

/** Human-readable descriptions for each label (used when creating them on GitHub). */
export function labelDescription(stage: LabelStage): string {
  switch (stage) {
    case "cooking":
      return "Noodle agent is working on this";
    case "cooked":
      return "Noodle agent run finished";
    case "failed":
      return "Noodle agent run errored out";
  }
}

/** True when `c` is a 6-char hex color (no '#'). Case-insensitive. */
export function isValidHexColor(c: unknown): c is string {
  return typeof c === "string" && /^[0-9a-fA-F]{6}$/.test(c);
}

/**
 * Parse + validate a stored label-set JSON string (from a settings key or a
 * command row) into a `LabelSet`. Returns null when:
 *   - the input is null/empty/unparseable (means "use defaults"), or
 *   - the shape is invalid (caller should treat as "use defaults" too — a bad
 *     stored value shouldn't crash a run).
 *
 * Partial overrides are NOT supported at this layer — a stored set must define
 * all 3 stages. The UI pre-fills defaults when enabling custom labels, so a
 * saved set is always complete. This keeps the engine logic simple: null ⇒
 * defaults, non-null ⇒ a complete replacement.
 */
export function parseLabelSet(raw: string | null | undefined): LabelSet | null {
  if (!raw || !raw.trim()) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const out: Partial<LabelSet> = {};
  for (const stage of LABEL_STAGES) {
    const s = o[stage];
    if (typeof s !== "object" || s === null) return null;
    const name = (s as Record<string, unknown>).name;
    const color = (s as Record<string, unknown>).color;
    if (typeof name !== "string" || !name.trim()) return null;
    if (!isValidHexColor(color)) return null;
    out[stage] = { name: name.trim(), color: (color as string).toLowerCase() };
  }
  return out as LabelSet;
}

/**
 * Serialize a 3-stage label set to the JSON string form for storage. Inverse of
 * `parseLabelSet`. The UI calls this when saving.
 */
export function serializeLabelSet(set: LabelSet): string {
  return JSON.stringify({
    cooking: { name: set.cooking.name, color: set.cooking.color },
    cooked: { name: set.cooked.name, color: set.cooked.color },
    failed: { name: set.failed.name, color: set.failed.color },
  });
}

import type { Profile } from "../config/schema.js";

/** A profile plus its name, ready to hand to the engine. */
export interface ResolvedProfile extends Profile {
  name: string;
}

/** Minimal issue shape the router needs. Engine builds this from GitHub data. */
export interface IssueInput {
  title: string;
  body: string;
  labels: string[];
  /** Newest-last comments; the router scans body first, then comments. */
  comments: string[];
}

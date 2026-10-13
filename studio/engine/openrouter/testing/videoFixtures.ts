import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Test-only. The bodies under ../fixtures/video are real OpenRouter responses (spikes B2, P0 and P-V), scrubbed: ids, workspace and
// endpoint ids are fixed fakes, and no key, account or personal data is in them.

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "video");

export type VideoFixture =
  | "submit-accepted"
  | "poll-pending"
  | "poll-completed"
  | "poll-failed-moderation"
  | "poll-failed-risk-control"
  | "generation-found-kling"
  | "generation-found-content-filter"
  | "generation-not-found";

export function fixture(name: VideoFixture): Record<string, unknown> {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8"));
}

/** The fake job id every fixture carries. */
export const FIXTURE_ID = "gen-vid-0000000000-FIXTURE0000000000001";

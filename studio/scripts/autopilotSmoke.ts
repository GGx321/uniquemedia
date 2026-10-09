import type { LaunchView } from "../shared/engine";

// The pure half of the packaged autopilot scenario (S4.E2E, smoke-engine.ts `runAutopilotScenario`): what it reads off the ledger and the disk, and what it requires of the launch's view.
// Each function answers with the problems it found (an empty list is a pass), so the scenario prints what was wrong and not just that something was.

// ---------- the ledger ----------

export interface LedgerFacts {
  /** Every `reserve` line's attempt id, in file order and with repeats: a reused id shows up twice. */
  reserved: string[];
  released: Set<string>;
  settled: Set<string>;
}

function lineFacts(parsed: unknown): { type: string; attemptId: string } | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const type: unknown = Reflect.get(parsed, "type");
  const attemptId: unknown = Reflect.get(parsed, "attemptId");
  return typeof type === "string" && typeof attemptId === "string" ? { type, attemptId } : null;
}

/**
 * `userData/ledger.jsonl` as plain bytes (the live engine's own Budget owns the file; this only reads it). Tolerates a torn LAST line, a crash in the middle of an append, as the
 * ledger's own reader does; a torn line anywhere else is corruption and throws, since a check whose point is that nothing was missed must not hide it.
 */
export function readLedger(text: string): LedgerFacts {
  const facts: LedgerFacts = { reserved: [], released: new Set(), settled: new Set() };
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (index === lines.length - 1) break;
      throw new Error(`ledger line ${index + 1} is not valid JSON, a corrupt middle line and not a torn tail: ${String(error)}`);
    }
    const found = lineFacts(parsed);
    if (found === null) continue;
    if (found.type === "reserve") facts.reserved.push(found.attemptId);
    else if (found.type === "release") facts.released.add(found.attemptId);
    else if (found.type === "settle") facts.settled.add(found.attemptId);
  }
  return facts;
}

/**
 * Invariants 2 and 5 from the wire's side. An attempt id never leaves the engine (the provider's request carries none), so the mock cannot log them; what it can do is count. Every
 * paid request the mock received has exactly one reserve that was not released (a release is a request that never left), and no id is reserved twice (a second reserve of an id is what
 * `ATTEMPT_ID_REUSED` refuses, so seeing one here would mean the refusal was bypassed). A restart that re-sent an attempt under its old id would break the first or the second.
 */
export function ledgerProblems(facts: LedgerFacts, receivedPaidRequests: number): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of facts.reserved) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  if (repeated.size > 0) problems.push(`attempt ids reserved more than once: ${[...repeated].join(", ")}`);
  const sent = [...seen].filter((id) => !facts.released.has(id)).length;
  if (sent !== receivedPaidRequests) problems.push(`the mock received ${receivedPaidRequests} paid requests, the ledger holds ${sent} reserves that were not released`);
  return problems;
}

// ---------- the view ----------

/** A launch that works, or is finishing its work: quitting the app now asks the owner (S4.7), so the scenario must not end in one of these. */
export function launchIsActive(status: string): boolean {
  return status === "running" || status === "pausing" || status === "stopping";
}

/**
 * What the window shows after the engine was killed under a running launch: paused by the restart, and either free to continue or blocked only by a reconcile (a request that lost its
 * answer leaves its reserve open). Any other block would refuse the click for a reason the scenario does not answer.
 */
export function restartPauseProblems(view: Pick<LaunchView, "status" | "paused" | "resumeBlockedBy">): string[] {
  const problems: string[] = [];
  if (view.status !== "paused") problems.push(`status is ${view.status}, not paused`);
  else if (view.paused?.cause !== "engine-restart") problems.push(`the pause cause is ${view.paused?.cause ?? "missing"}, not engine-restart`);
  if (view.resumeBlockedBy !== null && view.resumeBlockedBy !== "reconcile-required") problems.push(`«Продолжить» is blocked by ${view.resumeBlockedBy}`);
  return problems;
}

/** The set a row waits to have approved: what `autopilot.continueAfterReview` is sent. Null while no row waits, or one waits without its set. */
export function reviewRowOf(view: { avatars: readonly { avatarId: string; phase: string; sceneSetId: string | null; setRevision: number | null }[] }): { avatarId: string; sceneSetId: string; revision: number } | null {
  for (const row of view.avatars) {
    if (row.phase === "awaiting-review" && row.sceneSetId !== null && row.setRevision !== null) return { avatarId: row.avatarId, sceneSetId: row.sceneSetId, revision: row.setRevision };
  }
  return null;
}

// ---------- the disk ----------

/**
 * A1/A4: one scene set and one run for each launch an avatar was in, and nothing else in its folder. `named` is what the launch files say (the ids issued before the first paid call);
 * `disk` is what is actually there. A set or a run the launch did not name is a second compose or a second slice; one it named and the disk lacks is a loss.
 */
export function oneSetOneRunProblems(named: readonly { sceneSetId: string; setRunId: string }[], disk: { setIds: readonly string[]; runIds: readonly string[] }): string[] {
  const problems: string[] = [];
  const compare = (what: string, expected: readonly string[], found: readonly string[]): void => {
    for (const id of found) if (!expected.includes(id)) problems.push(`${what} ${id} is on disk and no launch named it (a second one)`);
    for (const id of expected) if (!found.includes(id)) problems.push(`${what} ${id} was named by a launch and is not on disk`);
    if (new Set(found).size !== found.length) problems.push(`${what} ids repeat on disk`);
  };
  compare("scene set", named.map((n) => n.sceneSetId), disk.setIds);
  compare("run", named.map((n) => n.setRunId), disk.runIds);
  return problems;
}

/** The plan's videos less the dropped ones are the files in the export folder, no more and no fewer. */
export function videosOnDiskProblems(facts: { planned: number; dropped: number; files: number }): string[] {
  const expected = facts.planned - facts.dropped;
  return facts.files === expected ? [] : [`${facts.files} videos on disk, expected ${expected} (planned ${facts.planned}, dropped ${facts.dropped})`];
}

// ---------- the money ----------

/** A4: «Продолжить · до $R» accepts exactly R = W′ − what was spent when the button was pressed (never below zero), and the launch ends having spent no more than W′. */
export function acceptedRemainingProblems(facts: { plannedWorstMicros: number; spentBeforeMicros: number; acceptedMicros: number; spentAfterMicros: number }): string[] {
  const problems: string[] = [];
  const expected = Math.max(0, facts.plannedWorstMicros - facts.spentBeforeMicros);
  if (facts.acceptedMicros !== expected) problems.push(`R accepted was ${facts.acceptedMicros}, W′ less the spent is ${expected}`);
  if (facts.spentAfterMicros > facts.plannedWorstMicros) problems.push(`spent ${facts.spentAfterMicros} passed W′ ${facts.plannedWorstMicros}`);
  return problems;
}

import type { LaunchView } from "../shared/engine";

// The pure half of the packaged autopilot scenario (S4.E2E, smoke-engine.ts `runAutopilotScenario`): what it reads off the ledger and the disk, and what it requires of the launch's view.
// Each function answers with the problems it found (an empty list is a pass), so the scenario prints what was wrong and not just that something was.

// ---------- the ledger ----------

export interface LedgerFacts {
  /** Every `reserve` line's attempt id, in file order and with repeats: a reused id shows up twice. */
  reserved: string[];
  released: Set<string>;
  settled: Set<string>;
  /** The model each attempt reserved for: the request's own `model`, so a count can be made per kind of request. */
  models: Map<string, string>;
}

interface LineFacts {
  type: string;
  attemptId: string;
  model: string | null;
}

function lineFacts(parsed: unknown): LineFacts | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const type: unknown = Reflect.get(parsed, "type");
  const attemptId: unknown = Reflect.get(parsed, "attemptId");
  const model: unknown = Reflect.get(parsed, "model");
  return typeof type === "string" && typeof attemptId === "string" ? { type, attemptId, model: typeof model === "string" ? model : null } : null;
}

/**
 * `userData/ledger.jsonl` as plain bytes (the live engine's own Budget owns the file; this only reads it). Tolerates a torn LAST line, a crash in the middle of an append, as the
 * ledger's own reader does; a torn line anywhere else is corruption and throws, since a check whose point is that nothing was missed must not hide it.
 */
export function readLedger(text: string): LedgerFacts {
  const facts: LedgerFacts = { reserved: [], released: new Set(), settled: new Set(), models: new Map() };
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
    if (found.type === "reserve") {
      facts.reserved.push(found.attemptId);
      if (found.model !== null) facts.models.set(found.attemptId, found.model);
    } else if (found.type === "release") facts.released.add(found.attemptId);
    else if (found.type === "settle") facts.settled.add(found.attemptId);
  }
  return facts;
}

/** The mock's paid requests (its POSTs; the reads are free) counted by the `model` in their body, which is the `model` the attempt reserved for. A body with no model is counted apart. */
export function postsByModel(requests: readonly { method: string; body: unknown }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const request of requests) {
    if (request.method !== "POST") continue;
    const model: unknown = typeof request.body === "object" && request.body !== null ? Reflect.get(request.body, "model") : undefined;
    const key = typeof model === "string" ? model : "(no model)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Invariants 2 and 5 from the wire's side. An attempt id never leaves the engine (the provider's request carries none), so the mock cannot log them; what it can do is count, and it
 * counts by kind of request, so a surplus of one kind cannot hide behind a deficit of another. Every paid request the mock received has exactly one reserve that was not released (a
 * release is a request that never left), and no id is reserved twice (a second reserve of an id is what `ATTEMPT_ID_REUSED` refuses, so seeing one here would mean the refusal was
 * bypassed). A restart that re-sent an attempt under its old id would break the first or the second.
 */
export function ledgerProblems(facts: LedgerFacts, receivedByModel: ReadonlyMap<string, number>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of facts.reserved) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  if (repeated.size > 0) problems.push(`attempt ids reserved more than once: ${[...repeated].join(", ")}`);
  const sentByModel = new Map<string, number>();
  for (const id of seen) {
    if (facts.released.has(id)) continue;
    const model = facts.models.get(id) ?? "(no model)";
    sentByModel.set(model, (sentByModel.get(model) ?? 0) + 1);
  }
  for (const model of new Set([...sentByModel.keys(), ...receivedByModel.keys()])) {
    const sent = sentByModel.get(model) ?? 0;
    const received = receivedByModel.get(model) ?? 0;
    if (sent !== received) problems.push(`${model}: the mock received ${received} paid requests, the ledger holds ${sent} reserves that were not released`);
  }
  return problems;
}

/** The photos a launch saved came each from an attempt of its own, and each attempt's reserve was settled: a photo is never bought twice nor kept from a request that was released. */
export function photoAttemptProblems(photoAttemptIds: readonly string[], facts: LedgerFacts): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of photoAttemptIds) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  if (repeated.size > 0) problems.push(`attempt ids behind more than one photo: ${[...repeated].join(", ")}`);
  const reserved = new Set(facts.reserved);
  for (const id of seen) {
    if (!reserved.has(id)) problems.push(`a photo came from an attempt with no reserve: ${id}`);
    else if (!facts.settled.has(id)) problems.push(`a photo came from an attempt whose reserve was not settled: ${id}`);
  }
  return problems;
}

// ---------- the view ----------

/** A launch that works, or is finishing its work: quitting the app now asks the owner (S4.7), so the scenario must not end in one of these. */
export function launchIsActive(status: string): boolean {
  return status === "running" || status === "pausing" || status === "stopping";
}

/**
 * What the window shows after the engine was killed under a running launch: paused by the restart, and either free to continue or blocked only by a reconcile (a request that lost its
 * answer leaves its reserve open). The restarted engine has no request out of its own (`inFlight` 0), and exactly the `lostRequests` that were in flight at the kill are unsettled: fewer
 * is a reserve that vanished, more is a reserve for a request nobody sent. Any other block would refuse the click for a reason the scenario does not answer.
 */
export function restartPauseProblems(view: Pick<LaunchView, "status" | "paused" | "resumeBlockedBy" | "inFlight" | "unsettled">, lostRequests: number): string[] {
  const problems: string[] = [];
  if (view.status !== "paused") problems.push(`status is ${view.status}, not paused`);
  else if (view.paused?.cause !== "engine-restart") problems.push(`the pause cause is ${view.paused?.cause ?? "missing"}, not engine-restart`);
  if (view.resumeBlockedBy !== null && view.resumeBlockedBy !== "reconcile-required") problems.push(`«Продолжить» is blocked by ${view.resumeBlockedBy}`);
  if (view.inFlight.requests !== 0) problems.push(`inFlight is ${view.inFlight.requests} in an engine that was just restarted`);
  const unsettled = view.unsettled?.requests ?? 0;
  if (unsettled !== lostRequests) problems.push(`unsettled is ${unsettled}, expected ${lostRequests}`);
  return problems;
}

/** A5, invariant 4: after the restart nothing is paid for and nothing renders until the click. `postsAtKill` is read right before the kill, `postsBeforeClick` right before «Продолжить». */
export function quietRestartProblems(facts: { postsAtKill: number; postsBeforeClick: number; renderProgressAfterRestart: number }): string[] {
  const problems: string[] = [];
  if (facts.postsBeforeClick !== facts.postsAtKill) problems.push(`${facts.postsBeforeClick} paid requests at the click, ${facts.postsAtKill} at the kill`);
  if (facts.renderProgressAfterRestart !== 0) problems.push(`${facts.renderProgressAfterRestart} render progress events between the restart and the click`);
  return problems;
}

/** "Mid-render" proved at the other end: when the launch was read after the kill, a video was still to finish, and the render job the kill met had not ended before it. */
export function midRenderProblems(facts: { videosDone: number; planned: number; endedBeforeKill: boolean }): string[] {
  const problems: string[] = [];
  if (facts.videosDone >= facts.planned) problems.push(`${facts.videosDone} of ${facts.planned} videos were finished when the launch was read after the kill`);
  if (facts.endedBeforeKill) problems.push("the render the kill met had ended before the kill");
  return problems;
}

/** The kill is the only crash: no notice before it, exactly one after (the engine host restarts a crashed engine once). */
export function restartNoticeProblems(noticesBefore: number, noticesAfter: number): string[] {
  const problems: string[] = [];
  if (noticesBefore !== 0) problems.push(`${noticesBefore} engine-restarted notices before the kill`);
  if (noticesAfter !== 1) problems.push(`${noticesAfter} engine-restarted notices after the kill, expected 1`);
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

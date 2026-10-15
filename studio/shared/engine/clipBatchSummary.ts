import { MAX_LISTED_BATCHES, clipBatchCostOf, type ClipBatchMemberSummary, type ClipBatchStop, type ClipBatchSummary, type ClipCancelDetail, type ClipCost, type ClipFailReason } from "./clips";

// 5b.2 (S5.WB2c, plan s5b2 I5.62, I5.63): the rules of a batch's own summary as pure functions, so the engine (which writes the summary to disk, engine/clips/batchSummary.ts) and the mock read ONE set of rules.
// A record says what one clip is now; a batch member is what the engine did with one photo of the batch, and that stays true when the owner deletes the clip. Nothing here imports the engine: the ledger's
// money comes in as the clips' costs (`clipCostsOf` in the engine, the mock's own lines in the mock), by clip id.

/** How many batch summaries an avatar keeps (any older one whose money is still open, or whose queue has not ended, is kept too). */
export const KEEP_BATCHES = MAX_LISTED_BATCHES;

/** A batch's summary without its total: what the engine keeps on disk (with a schema version) and the mock in memory. */
export interface ClipBatchState {
  readonly batchId: string;
  readonly avatarId: string;
  readonly size: number;
  readonly createdAt: string;
  readonly members: readonly ClipBatchMemberSummary[];
  readonly endedAt?: string | undefined;
  readonly stop?: ClipBatchStop | undefined;
}

/** A batch as it is created: every member queued under its first clip, free. */
export function startBatchState(start: { batchId: string; avatarId: string; createdAt: string; clipIds: readonly string[] }): ClipBatchState {
  return {
    batchId: start.batchId,
    avatarId: start.avatarId,
    size: start.clipIds.length,
    createdAt: start.createdAt,
    members: start.clipIds.map((clipId, i) => ({ batchIndex: i + 1, outcome: "queued", costMicros: 0, costKind: "free", clipIds: [clipId] })),
  };
}

/** What happened to a batch, as the engine tells its summary. A member's change names the clip it is about: only the member's NEWEST clip moves it (a 429's first clip ends after its member was requeued). */
export type BatchChange =
  /** Its turn came. */
  | { readonly kind: "running"; readonly index: number; readonly clipId: string }
  /** A 429 at its submit: it waits again, as a new clip. */
  | { readonly kind: "requeued"; readonly index: number; readonly clipId: string }
  /** Its clip job ended: made, refused, or failed (`clipBatchOutcomeOf`; a job that ended with no record failed). A failed member whose clip is made after all (a download fetched again) becomes ready. */
  | { readonly kind: "ended"; readonly index: number; readonly clipId: string; readonly outcome: "ready" | "refused" | "failed" }
  /** It never ran, for this reason. */
  | { readonly kind: "cancelled"; readonly index: number; readonly clipId: string; readonly detail: ClipCancelDetail }
  /** It never ran: the engine stopped. */
  | { readonly kind: "dropped"; readonly index: number; readonly clipId: string }
  /** A stop cancelled every member still queued (told after their cancels, and only when it cancelled one). */
  | { readonly kind: "stop"; readonly detail: ClipBatchStop }
  /** The queue ended: nothing is queued and the last member's money closed. */
  | { readonly kind: "over"; readonly at: string };

type Outcome = ClipBatchMemberSummary["outcome"];

/**
 * Where each change may move a member from. A member made, refused or cancelled never moves again (a word that comes late about it is ignored). A clip's own end (`ended`, from its job or its record) is the truth
 * about it, so it also lifts a member the restart had to call `dropped` or `failed` without its record.
 */
const FROM: Readonly<Record<"running" | "requeued" | "ended" | "cancelled" | "dropped", readonly Outcome[]>> = {
  running: ["queued"],
  requeued: ["queued", "running"],
  ended: ["queued", "running", "failed", "dropped"],
  cancelled: ["queued", "running"],
  dropped: ["queued", "running"],
};

function moveMember(member: ClipBatchMemberSummary, change: Extract<BatchChange, { index: number }>): ClipBatchMemberSummary {
  if (!FROM[change.kind].includes(member.outcome)) return member;
  const { detail: _detail, ...rest } = member;
  if (change.kind === "requeued") return member.clipIds.includes(change.clipId) ? member : { ...rest, outcome: "queued", clipIds: [...member.clipIds, change.clipId] };
  if (member.clipIds.at(-1) !== change.clipId) return member;
  switch (change.kind) {
    case "running":
      return { ...rest, outcome: "running" };
    case "ended":
      // Only a clip that was made lifts a failed member (a download fetched again, a recovery's record): a failed member never turns refused or failed again. A dropped one takes its clip's end, whatever it is.
      if (member.outcome === "failed" && change.outcome !== "ready") return member;
      return { ...rest, outcome: change.outcome };
    case "cancelled":
      return { ...rest, outcome: "cancelled", detail: change.detail };
    case "dropped":
      return { ...rest, outcome: "dropped" };
  }
}

/** The summary after one change. Pure; a change that does not apply (another place, an older clip, a member that cannot move from where it stands) leaves it as it was. */
export function applyBatchChange<T extends ClipBatchState>(state: T, change: BatchChange): T {
  switch (change.kind) {
    case "stop":
      return state.stop === undefined ? { ...state, stop: change.detail } : state;
    case "over":
      if (state.endedAt !== undefined) return state;
      // A member still queued when the queue ended will never run (the engine stopped it without a word): dropped.
      return { ...state, endedAt: change.at, members: state.members.map((m) => (m.outcome === "queued" ? { ...m, outcome: "dropped" } : m)) };
    default:
      return { ...state, members: state.members.map((m) => (m.batchIndex === change.index ? moveMember(m, change) : m)) };
  }
}

const FREE: ClipCost = { micros: 0, kind: "free" };

/** A member's money: the ledger's cost of each of its clips, added up by the one rule (`clipBatchCostOf`). A clip that reserved nothing is free. */
export function memberCostOf(costs: ReadonlyMap<string, ClipCost>, clipIds: readonly string[]): Pick<ClipBatchMemberSummary, "costMicros" | "costKind"> {
  const total = clipBatchCostOf(clipIds.map((clipId) => costs.get(clipId) ?? FREE).map((cost) => ({ costMicros: cost.micros, costKind: cost.kind })));
  return { costMicros: total.micros, costKind: total.kind };
}

/** The summary with each member's money as the ledger has it now. */
export function withCosts<T extends ClipBatchState>(state: T, costs: ReadonlyMap<string, ClipCost>): T {
  return { ...state, members: state.members.map((m) => ({ ...m, ...memberCostOf(costs, m.clipIds) })) };
}

/** The summary `clips.list` answers: the members with the ledger's money NOW, and the batch's one total. */
export function batchSummaryOf(state: ClipBatchState, costs: ReadonlyMap<string, ClipCost>): ClipBatchSummary {
  const priced = withCosts(state, costs);
  return {
    batchId: priced.batchId,
    avatarId: priced.avatarId,
    size: priced.size,
    createdAt: priced.createdAt,
    members: [...priced.members],
    ...(priced.endedAt === undefined ? {} : { endedAt: priced.endedAt }),
    ...(priced.stop === undefined ? {} : { stop: priced.stop }),
    cost: clipBatchCostOf(priced.members),
  };
}

/** Whether any member's money is still open as the ledger has it now (not as the summary kept it): a batch the reconcile has not closed yet is never forgotten. */
export function moneyOpen(state: ClipBatchState, costs: ReadonlyMap<string, ClipCost>): boolean {
  return state.members.some((m) => memberCostOf(costs, m.clipIds).costKind === "open");
}

/** The content refusals of a clip (Kling's, and Grok's behind it, and Grok with no room behind a free one). */
const REFUSED: ReadonlySet<ClipFailReason> = new Set<ClipFailReason>(["refused-free", "refused-both", "refused-paid", "refused-unknown", "grok-no-room"]);

/** How a member ended, by its clip's record outcome: made, refused for its content, or failed for any other reason. */
export function clipBatchOutcomeOf(outcome: { readonly status: "ready" } | { readonly status: "failed"; readonly reason: ClipFailReason }): "ready" | "refused" | "failed" {
  if (outcome.status === "ready") return "ready";
  return REFUSED.has(outcome.reason) ? "refused" : "failed";
}

/**
 * What a restart finds of a member's newest clip, read in this order: its journal (a recovery owns it and will tell its end), its record, a reserve of it in the ledger (money moved and nothing says how it
 * ended), or nothing (it was only in memory).
 */
export type MemberLook = { readonly kind: "journal" } | { readonly kind: "record"; readonly outcome: "ready" | "refused" | "failed" } | { readonly kind: "reserved" } | { readonly kind: "nothing" };

/**
 * The newest clip of each member still queued or at work: what a restart looks up. A queued member is looked at too: its turn's write can be lost to a crash after its POST left (round 2), and only its clip's
 * journal, record and reserve can tell.
 */
export function clipIdsToLook(state: ClipBatchState): string[] {
  return state.members.flatMap((m) => (m.outcome === "queued" || m.outcome === "running" ? m.clipIds.slice(-1) : []));
}

/**
 * The summary of a batch the process was running when it stopped (I5.63): no batch resumes after a restart, so its queue is over now. A member still queued or at work is told by its newest clip: at work while
 * its journal waits for the recovery (which tells its end); as its record says; failed when only the ledger says it moved money; dropped when nothing of it is anywhere (memory-only, never ran). Its money is
 * never decided here: it is the ledger's (`costMicros`/`costKind`). A batch that ended is left as it is.
 */
export function afterRestart<T extends ClipBatchState>(state: T, looks: ReadonlyMap<string, MemberLook>, at: string): T {
  const members = state.members.map((m): ClipBatchMemberSummary => {
    if (m.outcome !== "queued" && m.outcome !== "running") return m;
    const look = looks.get(m.clipIds.at(-1) ?? "") ?? { kind: "nothing" };
    switch (look.kind) {
      case "journal":
        return { ...m, outcome: "running" };
      case "record":
        return { ...m, outcome: look.outcome };
      case "reserved":
        return { ...m, outcome: "failed" };
      case "nothing":
        return { ...m, outcome: "dropped" };
    }
  });
  return { ...state, members, endedAt: state.endedAt ?? at };
}

/** Newest first: by when the batch was made, then by its id. */
export function newestFirst<T extends ClipBatchState>(states: readonly T[]): T[] {
  return [...states].sort((a, b) => (a.createdAt === b.createdAt ? (a.batchId < b.batchId ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
}

/** The batches of one avatar to forget: past the newest `keep` (by when they were made), those whose queue ended and whose money is closed. */
export function toForget<T extends ClipBatchState>(states: readonly T[], open: (state: T) => boolean, keep: number = KEEP_BATCHES): string[] {
  return newestFirst(states)
    .slice(keep)
    .flatMap((state) => (state.endedAt === undefined || open(state) ? [] : [state.batchId]));
}

import { JobState } from "../shared/engine";

/** The longest `EngineError.detail` the contract allows (`SafeText`). */
const MAX_DETAIL = 500;

/** The state with what a repair can mend mended: an error's detail clipped to the contract's length, `done` clamped to `total`; null when neither applies. */
function mended(state: JobState): JobState | null {
  let next: JobState = state;
  let changed = false;
  const detail = state.error?.detail;
  if (state.error !== undefined && detail !== undefined && detail.length > MAX_DETAIL) {
    next = { ...next, error: { ...state.error, detail: detail.slice(0, MAX_DETAIL) } };
    changed = true;
  }
  if (next.done > next.total) {
    next = { ...next, done: next.total };
    changed = true;
  }
  return changed ? next : null;
}

/**
 * The job states a snapshot may carry. The registry keeps a state as the engine wrote it, without validating it, and main answers a response that breaks
 * the contract with an INTERNAL error that sends every window offline: so one bad state must never reach the snapshot. A state whose fault is only a detail
 * longer than the contract allows or a `done` past its `total` is repaired (clipped, clamped), so the job, a running paid one too, stays visible; any other
 * bad state is left out. The log names the job (its id, kind and status) and the fields that failed (paths only), never what they held. With `reported`,
 * a job is logged once for as long as the set lives (a snapshot is asked for again and again); without it, every call logs.
 */
export function validJobStates(states: readonly JobState[], log: (line: string) => void, reported: Set<string> = new Set()): JobState[] {
  const kept: JobState[] = [];
  for (const state of states) {
    const parsed = JobState.safeParse(state);
    if (parsed.success) {
      kept.push(state);
      continue;
    }
    const repaired = mended(state);
    const fits = repaired !== null && JobState.safeParse(repaired).success;
    const key = `${state.jobId}:${state.status}:${fits ? "repaired" : "dropped"}`;
    if (!reported.has(key)) {
      reported.add(key);
      const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(whole)"))].join(", ");
      log(`job ${state.jobId} (${state.kind}, ${state.status}) breaks the contract at ${paths}: ${fits ? "repaired for the snapshot" : "dropped from the snapshot"}`);
    }
    if (fits) kept.push(repaired);
  }
  return kept;
}

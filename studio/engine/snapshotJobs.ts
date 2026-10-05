import { JobState } from "../shared/engine";

/** The longest `EngineError.detail` the contract allows (`SafeText`). */
const MAX_DETAIL = 500;

/** The state with its error's detail clipped to what the contract allows, or null when it has none to clip. */
function clipped(state: JobState): JobState | null {
  const detail = state.error?.detail;
  if (state.error === undefined || detail === undefined || detail.length <= MAX_DETAIL) return null;
  return { ...state, error: { ...state.error, detail: detail.slice(0, MAX_DETAIL) } };
}

/**
 * The job states a snapshot may carry. The registry keeps a state as the engine wrote it, without validating it, and main answers a response that breaks
 * the contract with an INTERNAL error that sends every window offline: so one bad state must never reach the snapshot. A state whose fault is only a detail
 * longer than the contract allows (the one way found to get here) is repaired by clipping it, so the job stays visible; any other bad state is left out.
 * The log names the job (its id, kind and status) and the fields that failed (paths only), never what they held.
 */
export function validJobStates(states: readonly JobState[], log: (line: string) => void): JobState[] {
  const kept: JobState[] = [];
  for (const state of states) {
    const parsed = JobState.safeParse(state);
    if (parsed.success) {
      kept.push(state);
      continue;
    }
    const where = `job ${state.jobId} (${state.kind}, ${state.status}) breaks the contract at ${[...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(whole)"))].join(", ")}`;
    const repaired = clipped(state);
    if (repaired !== null && JobState.safeParse(repaired).success) {
      log(`${where}: repaired for the snapshot by clipping the detail`);
      kept.push(repaired);
    } else log(`${where}: dropped from the snapshot`);
  }
  return kept;
}

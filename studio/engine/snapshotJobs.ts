import { JobState } from "../shared/engine";

/**
 * The job states a snapshot may carry. The registry keeps a state as the engine wrote it, without validating it, and main answers a response that breaks
 * the contract with an INTERNAL error that sends every window offline: so one bad state (a detail longer than the contract allows, say) must never reach
 * the snapshot. A state that does not fit is left out and the log says how many were, never what they held.
 */
export function validJobStates(states: readonly JobState[], log: (line: string) => void): JobState[] {
  const kept = states.filter((state) => JobState.safeParse(state).success);
  const dropped = states.length - kept.length;
  if (dropped > 0) log(`${dropped} job state(s) break the contract and are left out of the snapshot`);
  return kept;
}

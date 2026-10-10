// The auto-refresh rule (Stage 4, S4.5d; plan §7 and invariant A11) lives in `shared/autopilot/autoRefresh.ts` since S4.10 fix B: the plan card's dry run (the engine) and the mock
// answer from the very same rule. Re-exported here so the send path (`service.ts`, `autoSends.ts`) and its tests keep their import.
export * from "../../shared/autopilot/autoRefresh";

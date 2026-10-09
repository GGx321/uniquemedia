import type { LaunchStatus } from "../../shared/engine/autopilot";

// Stage 4 (plan §3.5, §3.7, §18): the launch's state machine as one table. The orchestrator asks it before it changes anything, so a wrong click is refused in one place.
// `pausing` is a view state (the requests in flight are finishing): it is never written to the launch file, where it reads as `running` (`persistedStatus`).

export type LaunchEvent =
  /** «Пауза» was clicked. */
  | "pause"
  /** The soft stop of a pause ended: nothing of the launch is in flight. */
  | "drained"
  /** «Продолжить · до $R» was accepted. */
  | "resume"
  /** «Стоп» was clicked. */
  | "stop"
  /** The soft stop of a stop ended and the launch released what it held. */
  | "stopped"
  /** Every video is done or dropped. */
  | "finish"
  /** The engine started again (an app relaunch, or its one automatic restart). */
  | "restart";

export const LAUNCH_EVENTS: readonly LaunchEvent[] = ["pause", "drained", "resume", "stop", "stopped", "finish", "restart"];

export type Transition = { ok: true; to: LaunchStatus } | { ok: false; reason: "wrong-state" };

const WRONG: Transition = { ok: false, reason: "wrong-state" };
const to = (status: LaunchStatus): Transition => ({ ok: true, to: status });

/** Where `event` takes a launch that is `from`, or `wrong-state`. Written as one `switch` per status so that no pair is implied by another. */
export function transition(from: LaunchStatus, event: LaunchEvent): Transition {
  switch (from) {
    case "running":
      return event === "pause" ? to("pausing") : event === "stop" ? to("stopping") : event === "finish" ? to("done") : event === "restart" ? to("paused") : WRONG;
    case "pausing":
      return event === "drained" ? to("paused") : event === "stop" ? to("stopping") : event === "finish" ? to("done") : event === "restart" ? to("paused") : WRONG;
    case "paused":
      return event === "resume" ? to("running") : event === "stop" ? to("stopping") : event === "restart" ? to("paused") : WRONG;
    case "stopping":
      return event === "stopped" ? to("stopped") : event === "restart" ? to("stopping") : WRONG;
    case "done":
    case "stopped":
      return event === "restart" ? to(from) : WRONG;
  }
}

/** What the launch file says for a status: `pausing` is the same as `running` on disk. */
export function persistedStatus(status: LaunchStatus): Exclude<LaunchStatus, "pausing"> {
  return status === "pausing" ? "running" : status;
}

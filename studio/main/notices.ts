import type { EngineError, ResponseMessage } from "../shared/engine";
import type { HostControl } from "../engine/control";

/**
 * What main has to tell the windows: the engine restarted after a crash,
 * settings.json was corrupt. Main never emits events itself — an event with
 * a bootId other than the engine's means "the engine restarted" to the
 * renderer, which then refetches the snapshot. Each notice goes to the engine
 * as a `notice` control message instead and comes back as an ordinary
 * `engine.error` in the engine's own seq/bootId stream.
 *
 * Timing: the renderer ignores events before its first snapshot, and a
 * snapshot clears its last error, so a notice is held and sent right after
 * the next successful snapshot, once. After an engine restart a copy also goes
 * out at once: that event carries the new bootId, so open windows resync, and
 * the held copy lands after their snapshot. A window opened after a notice
 * was delivered does not see it until T0's Snapshot can carry notices (T6a).
 */
export class HostNotices {
  readonly #send: (control: HostControl) => void;
  #held: EngineError[] = [];

  constructor(send: (control: HostControl) => void) {
    this.#send = send;
  }

  /** Holds `error` until a window has taken a snapshot. */
  hold(error: EngineError): void {
    this.#held.push(error);
  }

  /** The engine was restarted: tell it now (windows resync) and again after the next snapshot (so it sticks). */
  restarted(error: EngineError): void {
    this.#held.push(error);
    this.#send({ kind: "control", type: "notice", error });
  }

  /** Main's hook after every response to a window: a successful snapshot releases the held notices. */
  seen(response: ResponseMessage): void {
    if (!response.ok || response.type !== "engine.snapshot") return;
    for (const error of this.#held.splice(0)) this.#send({ kind: "control", type: "notice", error });
  }
}

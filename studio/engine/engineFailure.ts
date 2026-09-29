import type { EngineError } from "../shared/engine";

/** Carries a ready-made EngineError out of a handler, so `Engine.handle` answers with it unchanged. */
export class EngineFailure extends Error {
  readonly error: EngineError;

  constructor(error: EngineError) {
    super(error.detail ?? error.code);
    this.error = error;
  }
}

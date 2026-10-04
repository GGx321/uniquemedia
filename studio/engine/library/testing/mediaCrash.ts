// Test-only: a crash in the middle of a media commit. `MediaRecords` takes it as `hooks.treatAsCrash`: a commit does not clean up after a
// crash, because a crash cannot, so the disk is left as the crash left it and the next open has to settle it.

export class SimulatedCrash extends Error {
  constructor() {
    super("simulated crash");
    this.name = "SimulatedCrash";
  }
}

export const treatSimulatedCrash = (error: unknown): boolean => error instanceof SimulatedCrash;

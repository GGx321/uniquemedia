import type { ExportUnavailableReason } from "../../shared/engine";

// Stage 4, S4.6c2 (plan §4.6, §8.1): the free steps' one question before a render, «can the export folder take a video of this size?». It is the engine's own export check
// (`checkExportRoot` with `requiredBytes`: the folder is there, writable, outside the library, and the volume has at least 2 x the estimate free), told in the shape of
// `freeHold { export }`. A full disk is the same hold with `exportReason: "not-enough-space"` and the two figures, because the contract has no hold of its own for it.

export type ExportGateAnswer = { ok: true } | { ok: false; exportReason: ExportUnavailableReason; neededBytes: number | null; freeBytes: number | null };
export type ExportGate = (input: { requiredBytes: number }) => Promise<ExportGateAnswer>;

export interface ExportGateDeps {
  /** The engine's export check for a render that needs `requiredBytes`. */
  check(requiredBytes: number): Promise<{ ok: true } | { ok: false; reason: ExportUnavailableReason }>;
  /** Free bytes of the export volume, null when it does not say. Asked only to word `not-enough-space`. */
  freeBytes(): Promise<number | null>;
  /** How long the check and the probe may take each; the engine bounds the same check the same way (`EXPORT_CHECK_TIMEOUT_MS`). A folder that does not answer reads as not writable. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** `null` when the promise did not settle in `ms` (the timer is cleared as soon as it does, and is not unref'd: a drain waits on this). */
async function bounded<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ value })), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The floor the check applies (`exportRoot.ts`): twice the render's upper estimate must be free. */
const FLOOR_FACTOR = 2;

export function exportGateOf(deps: ExportGateDeps): ExportGate {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async ({ requiredBytes }) => {
    let check: Awaited<ReturnType<ExportGateDeps["check"]>>;
    try {
      const answered = await bounded(deps.check(requiredBytes), timeoutMs);
      if (answered === null) return { ok: false, exportReason: "not-writable", neededBytes: null, freeBytes: null };
      check = answered.value;
    } catch {
      // No answer is not a refusal (it needs evidence): the render goes to the engine, which checks again and refuses by itself.
      return { ok: true };
    }
    if (check.ok) return { ok: true };
    if (check.reason !== "not-enough-space") return { ok: false, exportReason: check.reason, neededBytes: null, freeBytes: null };
    const freeBytes = (await bounded(deps.freeBytes().catch(() => null), timeoutMs))?.value ?? null;
    return { ok: false, exportReason: "not-enough-space", neededBytes: requiredBytes * FLOOR_FACTOR, freeBytes };
  };
}

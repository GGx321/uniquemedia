import type { EngineError, Montage, MontageDraft } from "../../../shared/engine";
import type { EngineReply } from "../../engine/client";
import type { DraftContent, SendSave } from "./autosave";

// Test support for the editor's logic (3d.2): valid drafts and a hand-driven `montages.save`. Test-only.

export const AVATAR_ID = "avatar-mia-0001";
export const MONTAGE_ID = "montage-0000001";

/** A photo clip of `photoId` lasting `durationMs`, at `index` (for its id). */
export function photoClip(index: number, photoId: string, durationMs = 2_000): MontageDraft["clips"][number] {
  return {
    clipId: `clip-${String(index + 1).padStart(3, "0")}`,
    durationMs,
    transitionIn: "cut",
    kind: "photo",
    cell: { photo: { source: "scene", photoId }, focus: null },
    motion: "kenburns",
  };
}

/** A valid draft of `clips` for MIA; `n` photo clips of 2 s when a number is given. */
export function draftSpec(clips: MontageDraft["clips"] | number = 1, patch: Partial<MontageDraft> = {}): MontageDraft {
  const list = typeof clips === "number" ? Array.from({ length: clips }, (_, i) => photoClip(i, `photo-mia-${String(i + 1).padStart(4, "0")}`)) : clips;
  return { schemaVersion: 1, avatarId: AVATAR_ID, clips: list, layers: [], music: null, seed: 1, ...patch };
}

/** A spec told apart by its first clip's length: `version(3)` lasts 3 × 100 ms longer than `version(0)`. */
export function version(n: number): MontageDraft {
  return draftSpec([photoClip(0, "photo-mia-0001", 1_000 + n * 100)]);
}

export function montageOf(spec: MontageDraft, name: string | null = null, updatedAt = "2026-09-30T10:00:00.000Z"): Montage {
  return { montageId: MONTAGE_ID, name, spec, updatedAt };
}

export interface SaveCall {
  readonly montageId: string;
  readonly content: DraftContent;
  answered: boolean;
}

/**
 * `montages.save` answered by hand: every call waits until the test answers it, in order, as the engine applies
 * saves of one draft in arrival order. Each answer stamps a later `updatedAt`.
 */
export function manualSaves() {
  const calls: SaveCall[] = [];
  const resolvers: ((reply: EngineReply<"montages.save">) => void)[] = [];
  let clock = 0;
  const send: SendSave = (montageId, content) =>
    new Promise((resolve) => {
      calls.push({ montageId, content, answered: false });
      resolvers.push(resolve);
    });

  function nextOpen(): number {
    const i = calls.findIndex((c) => !c.answered);
    if (i === -1) throw new Error("no save is waiting for an answer");
    return i;
  }

  return {
    send,
    calls,
    /** The contents sent so far, in order. */
    sent: (): DraftContent[] => calls.map((c) => c.content),
    /** Answers the oldest open save as stored; returns the stored montage. */
    ok(): Montage {
      const i = nextOpen();
      const call = calls[i];
      const resolve = resolvers[i];
      if (call === undefined || resolve === undefined) throw new Error("no save to answer");
      clock += 1;
      const montage: Montage = { montageId: call.montageId, name: call.content.name, spec: call.content.spec, updatedAt: new Date(Date.UTC(2026, 8, 30, 10, 0, clock)).toISOString() };
      call.answered = true;
      resolve({ ok: true, result: { montage } });
      return montage;
    },
    /** Refuses the oldest open save with `error`. */
    fail(error: EngineError): void {
      const i = nextOpen();
      const call = calls[i];
      const resolve = resolvers[i];
      if (call === undefined || resolve === undefined) throw new Error("no save to answer");
      call.answered = true;
      resolve({ ok: false, error });
    },
    open: (): number => calls.filter((c) => !c.answered).length,
  };
}

/** Lets promise chains settle (an answer, the send after it). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

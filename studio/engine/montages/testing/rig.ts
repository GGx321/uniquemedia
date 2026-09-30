import { EventMessage, type UnsequencedEvent } from "../../../shared/engine";
import type { Focus } from "../../../shared/engine/montage";
import { EngineFailure } from "../../engineFailure";
import type { FocusResolver, FocusResult } from "../../focus/focusResolver";
import type { Library } from "../../library";
import { PNG_1X1, SAMPLE_SOURCE, samplePhotoMeta } from "../../library/testing/helpers";
import type { World } from "../../videos/testing/kit";
import { MontageService, type MontageServiceDeps } from "../service";
import { DraftStore, type DraftStoreDeps } from "../store";

// Test support for the montage service (3d.1a): a service over a real library in a temp folder, with the focus resolver
// replaced by a scripted one. Test-only.

/** What a scripted focus resolver does for one photo. */
export type FocusScript = { resolved: Focus } | "unresolved" | "throws" | "never" | "not-found";

export interface FocusRecorder {
  /** `focusFor` calls started, in order: [photoId]. */
  readonly started: string[];
  /** The most `focusFor` calls in flight at once. */
  maxInFlight: number;
  /** The abort signals the calls were handed. */
  readonly signals: AbortSignal[];
  resolver: Pick<FocusResolver, "focusFor">;
}

/** A resolver that answers by `script(photoId)`: the default is a point that depends on the photo's position in `order`. */
export function scriptedFocus(script: (photoId: string) => FocusScript = () => "unresolved", delayMs = 0): FocusRecorder {
  let inFlight = 0;
  const recorder: FocusRecorder = {
    started: [],
    maxInFlight: 0,
    signals: [],
    resolver: {
      focusFor: async (_avatarId, photoId, signal): Promise<FocusResult> => {
        recorder.started.push(photoId);
        if (signal !== undefined) recorder.signals.push(signal);
        inFlight++;
        recorder.maxInFlight = Math.max(recorder.maxInFlight, inFlight);
        try {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          const answer = script(photoId);
          if (answer === "never") return await new Promise<FocusResult>(() => undefined); // ignores its signal, as a stuck resolver would
          if (answer === "throws") throw new Error("the face worker broke");
          if (answer === "not-found") throw Object.assign(new Error("no such photo"), { name: "LibraryError", code: "photo-not-found" });
          if (answer === "unresolved") return { focus: { x: 0.5, y: 0.38 }, resolved: false };
          return { focus: answer.resolved, resolved: true };
        } finally {
          inFlight--;
        }
      },
    },
  };
  return recorder;
}

export interface MontageRig {
  readonly w: World;
  readonly service: MontageService;
  readonly store: DraftStore;
  readonly focus: FocusRecorder;
  readonly events: UnsequencedEvent[];
  readonly logs: string[];
  /** Every event, stamped the way the engine's log stamps it, so the contract's schema can judge it. */
  stamped(): EventMessage[];
  deps: MontageServiceDeps;
}

export interface MontageRigOptions {
  /** The library the service works on (default: the world's); null plays "no library is open". */
  library?: Library | null;
  focus?: FocusRecorder;
  deps?: Partial<MontageServiceDeps>;
  store?: Partial<DraftStoreDeps>;
  /** The clock: each call one second later than the last, from 2026-09-30T10:00:00Z. */
  now?: () => Date;
}

let ids = 0;

export function montageRig(w: World, options: MontageRigOptions = {}): MontageRig {
  const library = options.library === undefined ? w.library : options.library;
  const events: UnsequencedEvent[] = [];
  const logs: string[] = [];
  const focus = options.focus ?? scriptedFocus();
  const store = new DraftStore({ log: (line) => void logs.push(line), ...options.store });
  let t = Date.parse("2026-09-30T10:00:00.000Z");
  const deps: MontageServiceDeps = {
    store,
    withLibrary: async (work) => {
      if (library === null) throw new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open" });
      return work(library);
    },
    openLibrary: () => library,
    focus: () => focus.resolver,
    newId: () => `montage-${String(++ids).padStart(8, "0")}`,
    now: options.now ?? (() => new Date((t += 1000))),
    randomSeed: () => 4242,
    emit: (event) => void events.push(event),
    log: (line) => void logs.push(line),
    ...options.deps,
  };
  const service = new MontageService(deps);
  return {
    w,
    service,
    store,
    focus,
    events,
    logs,
    deps,
    stamped: () => events.map((event, i) => EventMessage.parse({ ...event, seq: i + 1, bootId: "boot-0000-aaaa" })),
  };
}

/** `n` more eligible scene photos for the world's avatar (on top of its three), oldest first. */
export async function addScenePhotos(w: World, n: number, avatarId: string = w.avatar.id): Promise<string[]> {
  const added: string[] = [];
  for (let i = 0; i < n; i++) {
    const photo = await w.library.addPhoto(avatarId, PNG_1X1, samplePhotoMeta({ source: { ...SAMPLE_SOURCE, category: "home" } }));
    added.push(photo.id);
  }
  return added;
}

/** The world's own three scene photos' ids. */
export const worldPhotoIds = (w: World): string[] => w.photos.map((p) => p.id);

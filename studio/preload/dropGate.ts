// 3f.6 round 2 (the drag-and-drop security review, MEDIUM-2): `importDropped` takes only the files of the LAST TRUSTED drop, once, within
// `DROP_TTL_MS`. Without it, any `File` that has a path would do: a page with script could keep a dropped `File` and import it again later
// with no gesture, use a copy (the path survives `structuredClone`, a `MessageChannel` and `history.replaceState`, which outlives a reload),
// or walk a dropped folder (`webkitGetAsEntry`) and import what is inside. This gate lives in the ISOLATED preload: it records the files of a
// drop the browser itself made (`event.isTrusted`), on the window in the capture phase, before any page handler runs. `File` identity holds
// across the two worlds (checked in Electron 43 by the review), so the page's `importDropped(files)` passes only those very objects.

/** How long after the drop its files may still be imported: a drop is answered at once; a later call is not the owner's drop any more. */
export const DROP_TTL_MS = 10_000;

export interface DropGateOptions {
  /** The clock, in ms (`Date.now` by default). */
  readonly now?: () => number;
  /** Whether the browser made the event (`event.isTrusted` by default): a test can make only untrusted ones. */
  readonly isTrusted?: (event: Event) => boolean;
}

export interface DropGate {
  /**
   * The asked files that are the last trusted drop's own (the same objects), each once and in the order asked; nothing when there was no such drop,
   * it is older than `DROP_TTL_MS`, or it was taken already. One-shot: the drop is forgotten either way.
   */
  take(files: unknown): File[];
}

/** The `files` of an event's `dataTransfer`, as an array; empty when it carries none. */
function filesOf(event: Event): File[] {
  const transfer: unknown = Reflect.get(event, "dataTransfer");
  if (typeof transfer !== "object" || transfer === null) return [];
  const list: unknown = Reflect.get(transfer, "files");
  if (typeof list !== "object" || list === null) return [];
  const length: unknown = Reflect.get(list, "length");
  if (typeof length !== "number") return [];
  const files: File[] = [];
  for (let i = 0; i < length; i++) {
    const file: unknown = Reflect.get(list, i);
    if (file instanceof File) files.push(file);
  }
  return files;
}

/** Starts listening for trusted drops on `target` (the preload's `window`). */
export function trustedDropGate(target: Pick<EventTarget, "addEventListener">, options: DropGateOptions = {}): DropGate {
  const now = options.now ?? Date.now;
  const isTrusted = options.isTrusted ?? ((event: Event) => event.isTrusted);
  let last: { files: readonly File[]; at: number } | null = null;
  target.addEventListener(
    "drop",
    (event) => {
      if (!isTrusted(event)) return;
      last = { files: filesOf(event), at: now() };
    },
    true,
  );
  return {
    take(files) {
      const drop = last;
      last = null;
      if (drop === null || now() - drop.at > DROP_TTL_MS || !Array.isArray(files)) return [];
      const taken: File[] = [];
      for (const file of files) {
        if (file instanceof File && drop.files.includes(file) && !taken.includes(file)) taken.push(file);
      }
      return taken;
    },
  };
}

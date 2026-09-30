import type { EngineError, EventMessage } from "../../../shared/engine";
import { ProgressInvariants } from "./progress";

// The parity harness's record of a scenario (Stage 3, 3d.1b): what was asked, what was answered and every event, in the order
// it happened, written as plain lines. The SAME scenario runs against the mock and against the real engine, each writes its
// transcript, and the two must be equal line for line. So a line says only what both engines are bound to say the same:
//
//  - identifiers are replaced by their role and the order they first appear in (`montage#1`, `job#2`, `photo#3`): the engine
//    draws ids from its own generator and the mock counts;
//  - what may differ on purpose is MASKED, each with its reason in `MASKED` below and the rest in `INTENTIONAL_DIFFERENCES`;
//  - only the events the montage, video and render commands are answerable for are written (`COVERED_EVENTS`): the engine also
//    sends `settings.changed`, `money.changed` and others that no command of this suite is about.

/** A command's answer as both rigs give it: the result, or the engine's error. */
export type Answer = { readonly ok: true; readonly result: Record<string, unknown> } | { readonly ok: false; readonly error: EngineError };

/** The events whose order is under test. */
export const COVERED_EVENTS: ReadonlySet<string> = new Set(["job.progress", "job.done", "job.failed", "job.cancelled", "video.changed", "montage.changed", "avatar.changed", "export.status"]);

/**
 * Values that differ between the mock and the engine by design, with why. A masked field is written as `"<masked>"`; whether the
 * field is present, and every other field, is still compared.
 */
export const MASKED: Readonly<Record<string, string>> = {
  updatedAt: "when a draft was last written: the mock's clock and the engine's are different clocks",
  createdAt: "when a record or an avatar was made: the same",
  bytes: "a video's size: the mock estimates it from the montage, the engine's fake ffmpeg wrote a fixed file",
  seed: "a new draft's variety seed: the engine draws one at random, the mock counts",
};

/**
 * What the mock does differently from the engine ON PURPOSE, and how the harness treats it. Each entry is a rule of `Transcript`
 * or of `Normalizer`, not a gap: anything not listed here must be equal.
 */
export const INTENTIONAL_DIFFERENCES: readonly string[] = [
  "progress: the engine's steps follow ffmpeg's frames over two passes, the mock has a fixed number of steps; a run of `mid` progress events is collapsed to one, and the start (done 0), the saving phase and the total are compared exactly",
  "timing: the engine's render ends when its ffmpeg stops, the mock's after its own clock; scenarios move time only through `advance` and `settle`, and a running render's cancel is followed by a `settle`",
  "identifiers: replaced by role and order of appearance; the timestamps, seeds and byte sizes in `MASKED` are masked",
  "file names: the date in a video's `relPath` is masked (the mock's clock against the engine's), and the mock's folder name is ASCII only (no Cyrillic transliteration)",
  "VALIDATION: the engine and the renderer's client both refuse a payload that breaks the contract, in different words: the code is compared, not the detail",
  "events the suite is not about (settings.changed, money.changed, ...) are not written",
];

const ID_KINDS: Readonly<Record<string, string>> = {
  avatarId: "avatar",
  masterPhotoId: "photo",
  photoId: "photo",
  montageId: "montage",
  videoId: "video",
  jobId: "job",
  clipId: "clip",
  layerId: "layer",
};
const ID_LIST_KINDS: Readonly<Record<string, string>> = { photoIds: "photo", usedIn: "video" };

/** Replaces identifiers by their role and order of appearance, and masks what `MASKED` lists. */
export class Normalizer {
  readonly #aliases = new Map<string, string>();
  readonly #counts = new Map<string, number>();

  /** Names an identifier the harness already knows (the seeded avatars and photos), so their numbers follow the seed order and not the first appearance. */
  register(kind: string, id: string): string {
    const known = this.#aliases.get(id);
    if (known !== undefined) return known;
    const n = (this.#counts.get(kind) ?? 0) + 1;
    this.#counts.set(kind, n);
    const alias = `${kind}#${n}`;
    this.#aliases.set(id, alias);
    return alias;
  }

  /** A free text (an error's detail) with every known identifier in it replaced. */
  text(raw: string): string {
    let out = raw;
    for (const [id, alias] of [...this.#aliases].sort((a, b) => b[0].length - a[0].length)) out = out.split(id).join(alias);
    return out;
  }

  value(value: unknown, key?: string): unknown {
    if (typeof value === "string") {
      const kind = key === undefined ? undefined : ID_KINDS[key];
      if (kind !== undefined) return this.register(kind, value);
      if (key !== undefined && key in MASKED) return "<masked>";
      if (key === "relPath") return value.replace(/\d{4}-\d{2}-\d{2}/, "<date>");
      return this.text(value);
    }
    if (typeof value === "number") return key !== undefined && key in MASKED ? "<masked>" : value;
    if (Array.isArray(value)) {
      const kind = key === undefined ? undefined : ID_LIST_KINDS[key];
      return value.map((item) => (kind !== undefined && typeof item === "string" ? this.register(kind, item) : this.value(item)));
    }
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.value(v, k)]));
    return value;
  }
}

const compact = (value: unknown): string => JSON.stringify(value);

function objectOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object");
  return Object.fromEntries(Object.entries(value));
}

/** The avatar as the grid shows it, less what differs by construction (the descriptor text, the date). */
function avatarLine(avatar: unknown): Record<string, unknown> {
  const a = objectOf(avatar);
  return { avatarId: a.avatarId, name: a.name, status: a.status, photoCount: a.photoCount, videoCount: a.videoCount, eligibleUnusedCount: a.eligibleUnusedCount };
}

/** One event as a line of the transcript, or null for an event the suite is not about. */
export function eventLine(event: EventMessage, norm: Normalizer): string | null {
  if (!COVERED_EVENTS.has(event.type)) return null;
  if (event.type === "job.progress") {
    const p = objectOf(event.payload);
    const done = typeof p.done === "number" ? p.done : -1;
    const phase = p.saving === true ? "saving" : done === 0 ? "start" : "mid";
    const { done: _done, saving: _saving, ...rest } = p;
    return `event job.progress ${compact({ ...objectOf(norm.value(rest)), phase })}`;
  }
  if (event.type === "avatar.changed") return `event avatar.changed ${compact(norm.value(avatarLine(objectOf(event.payload).avatar)))}`;
  return `event ${event.type} ${compact(norm.value(event.payload))}`;
}

/** An answer as a line. */
export function answerLine(type: string, answer: Answer, norm: Normalizer): string {
  if (!answer.ok) {
    const { code, detail, issues, exportReason } = answer.error;
    // The transport's VALIDATION text is the engine's or the client's own words: only its code is compared.
    const text = code === "VALIDATION" ? undefined : detail;
    return `< error ${code} ${compact(norm.value({ ...(text === undefined ? {} : { detail: text }), ...(issues === undefined ? {} : { issues }), ...(exportReason === undefined ? {} : { exportReason }) }))}`;
  }
  if (type === "photos.list") {
    const listed = Array.isArray(answer.result.photos) ? answer.result.photos : [];
    // Only the photos that are not free are written: a free one is `used`, `reserved` and `rejected` false and `eligible` true.
    const held = listed
      .map((photo) => objectOf(photo))
      .filter((p) => p.used === true || p.reserved === true || p.rejected === true || p.eligible === false)
      .map((p) => compact(norm.value({ photoId: p.photoId, used: p.used, usedIn: p.usedIn, reserved: p.reserved, rejected: p.rejected, eligible: p.eligible })))
      .sort();
    return [`< ok photos ${compact({ count: listed.length, free: listed.length - held.length, skippedTotal: answer.result.skippedTotal })}`, ...held.map((s) => `  ${s}`)].join("\n");
  }
  if (type === "photos.setRejected") {
    // The fixtures' own run, date and QA verdicts differ by construction: what is compared is the photo's state.
    const p = objectOf(answer.result.photo);
    return `< ok ${compact(norm.value({ photo: { photoId: p.photoId, used: p.used, usedIn: p.usedIn, reserved: p.reserved, rejected: p.rejected, eligible: p.eligible } }))}`;
  }
  return `< ok ${compact(norm.value(answer.result))}`;
}

/** What a rig gives the transcript: commands, the events so far, and the two moves of time. */
export interface Recorded {
  send(type: string, payload: unknown): Promise<Answer>;
  events(): EventMessage[];
  advance(step: "progress" | "saving"): Promise<void>;
  settle(): Promise<void>;
}

export class Transcript {
  readonly #lines: string[] = [];
  readonly #rig: Recorded;
  readonly norm: Normalizer;
  readonly #progress = new ProgressInvariants();
  #seen: number;

  constructor(rig: Recorded, norm: Normalizer) {
    this.#rig = rig;
    this.norm = norm;
    // What happened while the engine was being set up is not part of any scenario.
    this.#seen = rig.events().length;
  }

  /** The events that came since the last look, in order. */
  #drain(): void {
    const all = this.#rig.events();
    for (const event of all.slice(this.#seen)) {
      // The transcript leaves a render's `done` out; the rules its numbers must satisfy are checked here, on both engines.
      if (event.type === "job.progress" && event.payload.kind === "render") this.#progress.check(event.payload);
      const line = eventLine(event, this.norm);
      if (line !== null) this.#lines.push(line);
    }
    this.#seen = all.length;
  }

  /** Sends a command: the command, the events it caused before it answered, then its answer. */
  async call(type: string, payload: unknown): Promise<Answer> {
    this.#drain();
    this.#lines.push(`> ${type} ${compact(this.norm.value(payload))}`);
    const answer = await this.#rig.send(type, payload);
    this.#drain();
    this.#lines.push(answerLine(type, answer, this.norm));
    return answer;
  }

  async advance(step: "progress" | "saving"): Promise<void> {
    this.#drain();
    await this.#rig.advance(step);
    this.#lines.push(`~ advance ${step}`);
    this.#drain();
  }

  async settle(): Promise<void> {
    this.#drain();
    await this.#rig.settle();
    this.#lines.push("~ settle");
    this.#drain();
  }

  /** After the rig was stopped: whatever the scenario left running ended now, and its events are written under a marker. */
  finish(): void {
    const mark = this.#lines.length;
    this.#drain();
    if (this.#lines.length > mark) this.#lines.splice(mark, 0, "~ end of scenario");
  }

  /** A line the scenario writes for its reader. */
  note(text: string): void {
    this.#lines.push(`# ${text}`);
  }

  /** Runs setup that is not part of what is compared (twenty renders to fill a queue): its lines are dropped. */
  async quiet(work: () => Promise<void>): Promise<void> {
    this.#drain();
    const mark = this.#lines.length;
    await work();
    this.#drain();
    this.#lines.length = mark;
  }

  /** The lines, with a run of `mid` progress events collapsed to one (the engine and the mock step differently). */
  lines(): string[] {
    const out: string[] = [];
    for (const line of this.#lines.flatMap((l) => l.split("\n"))) {
      const isMid = line.startsWith("event job.progress ") && line.endsWith(`"phase":"mid"}`);
      if (isMid && out.at(-1) === line) continue;
      out.push(line);
    }
    return out;
  }
}

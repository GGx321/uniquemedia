import type { EngineError, Montage, MontageDraft } from "../../../shared/engine";
import type { EngineReply } from "../../engine/client";
import type { Scheduler } from "../../engine/scheduler";
import { sameJson } from "./json";

// The editor's autosave (3d.2). Saves are serialised HERE, in the renderer: at most one `montages.save` of the
// draft is in flight, and whatever was edited meanwhile waits for its answer; only the newest content is sent
// then, never the versions in between (the engine applies saves in arrival order, so "latest wins" holds end to
// end). An edit is sent after a quiet spell, or after the longest wait while edits keep coming. «Рендер» and
// leaving the editor flush first.
//
// The engine announces every save as `montage.changed` BEFORE its own answer, and how those echoes interleave
// with other answers differs between the engine and the mock. So an echo is recognised by its CONTENT (the spec
// and the name this window sent), never by its place in the event stream.

export interface DraftContent {
  readonly spec: MontageDraft;
  readonly name: string | null;
}

/**
 * - `saved`: the engine holds what the window shows;
 * - `pending`: an edit is waiting for its quiet spell (or for the save in flight);
 * - `saving`: a save is in flight;
 * - `failed`: the last save was refused; the edit is kept and a retry (or the next edit) sends it again;
 * - `gone`: the draft was deleted (NOT_FOUND, or `montage.changed` removed): nothing is sent any more.
 */
export type SaveState =
  | { readonly kind: "saved" }
  | { readonly kind: "pending" }
  | { readonly kind: "saving" }
  | { readonly kind: "failed"; readonly error: EngineError }
  | { readonly kind: "gone" };

export type FlushResult = { readonly ok: true; readonly montage: Montage } | { readonly ok: false; readonly error: EngineError };

export type SendSave = (montageId: string, content: DraftContent) => Promise<EngineReply<"montages.save">>;

/** An edit is sent once the draft has been left alone this long. */
export const AUTOSAVE_DEBOUNCE_MS = 600;
/** ...or once this long has passed since the first unsent edit, however busy the owner is (a long drag). */
export const AUTOSAVE_MAX_WAIT_MS = 3_000;
/** How many sent contents are remembered for telling echoes apart: far more than can be in flight or late at once. */
const ECHO_MEMORY = 16;

const GONE: EngineError = { code: "NOT_FOUND", detail: "the montage draft was deleted" };

const contentOf = (montage: Montage): DraftContent => ({ spec: montage.spec, name: montage.name });
const sameContent = (a: DraftContent, b: DraftContent): boolean => a.name === b.name && sameJson(a.spec, b.spec);

export interface AutosaveOptions {
  /** The draft as the engine holds it now (as `montages.get` or `montages.create` answered). */
  readonly montage: Montage;
  readonly send: SendSave;
  readonly scheduler: Scheduler;
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
}

export class DraftAutosave {
  readonly #montageId: string;
  readonly #send: SendSave;
  readonly #scheduler: Scheduler;
  readonly #debounceMs: number;
  readonly #maxWaitMs: number;
  /** What the engine answered last (or held when the editor opened). */
  #acked: Montage;
  /** The newest content in the window. */
  #latest: DraftContent;
  #inflight: DraftContent | null = null;
  #error: EngineError | null = null;
  #gone: EngineError | null = null;
  #closed = false;
  #cancelDebounce: (() => void) | null = null;
  #cancelMaxWait: (() => void) | null = null;
  #sent: DraftContent[] = [];
  #waiters: ((result: FlushResult) => void)[] = [];
  readonly #listeners = new Set<() => void>();

  constructor(options: AutosaveOptions) {
    this.#montageId = options.montage.montageId;
    this.#send = options.send;
    this.#scheduler = options.scheduler;
    this.#debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
    this.#maxWaitMs = options.maxWaitMs ?? AUTOSAVE_MAX_WAIT_MS;
    this.#acked = options.montage;
    this.#latest = contentOf(options.montage);
  }

  get state(): SaveState {
    if (this.#gone !== null) return { kind: "gone" };
    if (this.#inflight !== null) return { kind: "saving" };
    if (!this.#dirty()) return { kind: "saved" };
    if (this.#error !== null) return { kind: "failed", error: this.#error };
    return { kind: "pending" };
  }

  /** The draft as the engine last answered it: its `updatedAt` is the «сохранён HH:MM». */
  get saved(): Montage {
    return this.#acked;
  }

  /** The newest content in the window, saved or not. */
  get content(): DraftContent {
    return this.#latest;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The window's content changed. Sent after the quiet spell; `now` skips it (a rename the owner confirmed). */
  set(content: DraftContent, { now = false }: { now?: boolean } = {}): void {
    if (this.#gone !== null || this.#closed) return;
    this.#latest = content;
    if (!this.#dirty()) {
      this.#cancelTimers();
      this.#error = null;
      this.#emit();
      if (this.#inflight === null) this.#settle({ ok: true, montage: this.#acked });
      return;
    }
    if (now) {
      this.#cancelTimers();
      void this.#pump();
    } else this.#arm();
    this.#emit();
  }

  /** Sends whatever is unsaved now and answers once the engine holds the newest content (or refused it). */
  flush(): Promise<FlushResult> {
    if (this.#gone !== null) return Promise.resolve({ ok: false, error: this.#gone });
    this.#cancelTimers();
    if (this.#inflight === null && !this.#dirty()) return Promise.resolve({ ok: true, montage: this.#acked });
    const result = new Promise<FlushResult>((resolve) => this.#waiters.push(resolve));
    void this.#pump();
    return result;
  }

  /** Flushes, then takes no more edits: the editor is closing. The save already under way still finishes. */
  close(): Promise<FlushResult> {
    const flushed = this.flush();
    this.#closed = true;
    this.#cancelTimers();
    return flushed;
  }

  /** Sends the kept edit again after a failure. */
  retry(): void {
    if (this.#gone !== null || this.#closed) return;
    this.#cancelTimers();
    void this.#pump();
  }

  /** The draft was deleted elsewhere (`montage.changed` removed): stop, and answer any waiting flush. */
  markGone(error: EngineError = GONE): void {
    if (this.#gone !== null) return;
    this.#gone = error;
    this.#cancelTimers();
    this.#emit();
    this.#settle({ ok: false, error });
  }

  /** Whether `montage` is the echo of a save this window sent: the same draft with content this window sent. */
  isOwnEcho(montage: Montage): boolean {
    if (montage.montageId !== this.#montageId) return false;
    const content = contentOf(montage);
    return sameContent(content, contentOf(this.#acked)) || this.#sent.some((sent) => sameContent(sent, content));
  }

  /**
   * Takes a save made elsewhere as the stored draft, but only while nothing here is unsaved or in flight: otherwise
   * this window's own save follows and wins (the engine applies saves in order). True when adopted.
   */
  adoptRemote(montage: Montage): boolean {
    if (montage.montageId !== this.#montageId || this.#gone !== null || this.#closed) return false;
    if (this.#inflight !== null || this.#dirty()) return false;
    this.#acked = montage;
    this.#latest = contentOf(montage);
    this.#error = null;
    this.#emit();
    return true;
  }

  /** Unsaved: the newest content differs from what the engine will hold once the save in flight lands. */
  #dirty(): boolean {
    return !sameContent(this.#latest, this.#inflight ?? contentOf(this.#acked));
  }

  #arm(): void {
    this.#cancelDebounce?.();
    this.#cancelDebounce = this.#scheduler.schedule(this.#debounceMs, () => {
      this.#cancelDebounce = null;
      this.#fire();
    });
    if (this.#cancelMaxWait === null) {
      this.#cancelMaxWait = this.#scheduler.schedule(this.#maxWaitMs, () => {
        this.#cancelMaxWait = null;
        this.#fire();
      });
    }
  }

  #fire(): void {
    this.#cancelTimers();
    void this.#pump();
  }

  #cancelTimers(): void {
    this.#cancelDebounce?.();
    this.#cancelDebounce = null;
    this.#cancelMaxWait?.();
    this.#cancelMaxWait = null;
  }

  async #pump(): Promise<void> {
    if (this.#inflight !== null || this.#gone !== null) return;
    if (!this.#dirty()) {
      this.#settle({ ok: true, montage: this.#acked });
      return;
    }
    const content = this.#latest;
    this.#inflight = content;
    this.#error = null;
    this.#sent = [...this.#sent, content].slice(-ECHO_MEMORY);
    this.#cancelTimers();
    this.#emit();

    const reply = await this.#send(this.#montageId, content);
    this.#inflight = null;
    if (this.#gone !== null) {
      this.#emit();
      return;
    }
    if (!reply.ok) {
      if (reply.error.code === "NOT_FOUND") {
        this.markGone(reply.error);
        return;
      }
      this.#error = reply.error;
      this.#emit();
      this.#settle({ ok: false, error: reply.error });
      return;
    }
    this.#acked = reply.result.montage;
    this.#emit();
    if (!this.#dirty()) {
      this.#settle({ ok: true, montage: this.#acked });
      return;
    }
    // Edited while this save was out: a waiting flush, or a quiet spell already over, sends the newest now; an
    // edit still inside its quiet spell waits for its own timer.
    const timerRunning = this.#cancelDebounce !== null || this.#cancelMaxWait !== null;
    if (this.#waiters.length > 0 || !timerRunning) void this.#pump();
  }

  #settle(result: FlushResult): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve(result);
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

import type { EngineError, TextLayer } from "../../shared/engine";
import type { TextPreviewOutcome } from "./textPreview";

// 3d.4: the window's ONE queue of `montages.textPreview` asks, per text layer, shared by every consumer of a caption's picture: the
// preview (each text layer's PNG and its box) and the properties panel (the caption's verdict, 3d.5).
//
// Why one. The engine keeps a queue per layer as well, and answers an ask still waiting there TEXT_PREVIEW_SUPERSEDED when a newer
// ask of the same layer arrives. When the panel and the preview asked on their own, one's ask could supersede the other's, and the
// other would wait for ever for the answer to an ask nobody draws (the 3d.5 note). Here:
// - a consumer never waits for ITS ask: it reads the layer's state, which the newest answer decides;
// - a request for the look the layer's newest ask is for is not sent again: the preview and the panel share it;
// - at most ONE ask per layer is out at a time, and only the newest look waits behind it (review round 1): typing sends one ask
//   while the engine draws, then the last text, never an ask per key, and the window's own asks never supersede each other;
// - an answer whose look is the one waiting answers that one too (going back to the text that is out sends nothing more);
// - the ask out superseded means something outside this window asked for the layer (another window with the draft open): the newer
//   look waiting is sent if there is one, else the same look is asked again, `OUTSIDE_RETRIES` times, then settled as failed. So
//   nothing is ever left pending.

/** Every answer but `superseded`, which is no answer at all. */
export type PreviewAnswer = Exclude<TextPreviewOutcome, { kind: "superseded" }>;
export type PictureAnswer = Extract<PreviewAnswer, { kind: "picture" }>;

export interface LayerPreview {
  /** How many asks the layer's looks were given (the newest one's number); 0 = never asked. */
  readonly asked: number;
  /** The newest look asked for: what the layer's picture is being drawn for. */
  readonly look: string | null;
  /** The newest answer, with its ask's number and look. Pending while `asked` is above its `ask`. */
  readonly shown: { readonly ask: number; readonly look: string; readonly answer: PreviewAnswer } | null;
  /** The newest picture drawn, kept through a later refusal: what the preview shows (marked when it is not of the newest look). */
  readonly picture: { readonly ask: number; readonly look: string; readonly answer: PictureAnswer } | null;
}

export const NO_PREVIEW: LayerPreview = { asked: 0, look: null, shown: null, picture: null };

/** How many times an ask superseded from outside this window is asked again before it is settled as failed. */
export const OUTSIDE_RETRIES = 3;

const GAVE_UP: EngineError = { code: "INTERNAL", detail: "the text preview kept being replaced by asks from elsewhere" };
const NOT_ASKED: EngineError = { code: "INTERNAL", detail: "the text preview could not be asked for" };

/**
 * Whether an answer is the ENGINE refusing the caption (the preview marks the picture «refused»): a caption rule (TEXT_INVALID) or a
 * drawing that failed (RENDER_FAILED). A transport failure or giving up after outside supersedes is not the caption's fault.
 */
export function isEngineRefusal(answer: PreviewAnswer): boolean {
  return answer.kind === "invalid" || (answer.kind === "failed" && answer.error.code === "RENDER_FAILED");
}

/** Whether the engine refused the caption as it is NOW (`look`): the newest answer is of that look and is a refusal. */
export function refusedNow(preview: LayerPreview, look: string): boolean {
  const { shown } = preview;
  return shown !== null && shown.look === look && isEngineRefusal(shown.answer);
}

/** What decides a caption's picture: the text, the font, the style, the colour and the size (never the place or the time). */
export function previewLook(layer: TextLayer): string {
  return JSON.stringify([layer.value, layer.font, layer.style, layer.color, layer.scale]);
}

/** The caption text a look (`previewLook`) was made for, or null for a string that is not a look. */
export function lookValue(look: string): string | null {
  try {
    const parsed: unknown = JSON.parse(look);
    const value = Array.isArray(parsed) ? parsed[0] : undefined;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

interface Ask {
  readonly ask: number;
  readonly look: string;
  readonly layer: TextLayer;
}

interface Entry {
  state: LayerPreview;
  /** The one ask out, if any. */
  out: Ask | null;
  /** The newest look waiting behind it, if any. */
  waiting: Ask | null;
  /** The newest ask's layer, sent again on a reload. */
  latest: TextLayer | null;
  /** Asks of the newest look sent again after an outside supersede. */
  retries: number;
}

export class TextPreviewQueue {
  readonly #ask: (layer: TextLayer) => Promise<TextPreviewOutcome>;
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Map<string, Set<() => void>>();

  constructor(ask: (layer: TextLayer) => Promise<TextPreviewOutcome>) {
    this.#ask = ask;
  }

  /** Asks for `layer`'s picture, unless the layer's newest ask is for this very look (then that ask serves this consumer too). */
  request(layer: TextLayer): void {
    const look = previewLook(layer);
    const entry = this.#entry(layer.layerId);
    if (entry.state.look === look) return;
    this.#enqueue(layer.layerId, entry, layer, look);
  }

  /** Asks again for the layer's newest look, answered or not: its picture is no longer served (the engine keeps 64). */
  reload(layerId: string): void {
    const entry = this.#entries.get(layerId);
    if (entry === undefined || entry.latest === null || entry.state.look === null) return;
    this.#enqueue(layerId, entry, entry.latest, entry.state.look);
  }

  /** The layer's state now: the same object until it changes. */
  get(layerId: string): LayerPreview {
    return this.#entries.get(layerId)?.state ?? NO_PREVIEW;
  }

  subscribe(layerId: string, listener: () => void): () => void {
    let set = this.#listeners.get(layerId);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(layerId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  #entry(layerId: string): Entry {
    let entry = this.#entries.get(layerId);
    if (entry === undefined) {
      entry = { state: NO_PREVIEW, out: null, waiting: null, latest: null, retries: 0 };
      this.#entries.set(layerId, entry);
    }
    return entry;
  }

  /** A new ask of `look`: sent at once when none is out, else it waits (replacing an older one waiting). */
  #enqueue(layerId: string, entry: Entry, layer: TextLayer, look: string): void {
    const ask: Ask = { ask: entry.state.asked + 1, look, layer };
    entry.latest = layer;
    entry.retries = 0;
    this.#set(layerId, entry, { ...entry.state, asked: ask.ask, look });
    if (entry.out === null) this.#send(layerId, entry, ask);
    else entry.waiting = ask;
  }

  #send(layerId: string, entry: Entry, ask: Ask): void {
    entry.out = ask;
    this.#ask(ask.layer).then(
      (outcome) => this.#answer(layerId, entry, ask, outcome),
      () => this.#answer(layerId, entry, ask, { kind: "failed", error: NOT_ASKED }),
    );
  }

  #answer(layerId: string, entry: Entry, ask: Ask, outcome: TextPreviewOutcome): void {
    entry.out = null;
    const waiting = entry.waiting;
    if (outcome.kind === "superseded") {
      // Superseded from outside this window: the newer look waiting goes instead, else this one is asked again a few times.
      if (waiting !== null) {
        entry.waiting = null;
        this.#send(layerId, entry, waiting);
      } else if (entry.retries < OUTSIDE_RETRIES) {
        entry.retries += 1;
        this.#send(layerId, entry, ask);
      } else this.#show(layerId, entry, ask, { kind: "failed", error: GAVE_UP });
      return;
    }
    if (waiting !== null && waiting.look === ask.look) {
      // The look waiting is the one just answered (the text went back to it): this answer is its answer too.
      entry.waiting = null;
      this.#show(layerId, entry, waiting, outcome);
      return;
    }
    this.#show(layerId, entry, ask, outcome);
    if (waiting !== null) {
      entry.waiting = null;
      this.#send(layerId, entry, waiting);
    }
  }

  #show(layerId: string, entry: Entry, ask: Ask, answer: PreviewAnswer): void {
    const picture = answer.kind === "picture" ? { ask: ask.ask, look: ask.look, answer } : entry.state.picture;
    this.#set(layerId, entry, { ...entry.state, shown: { ask: ask.ask, look: ask.look, answer }, picture });
  }

  #set(layerId: string, entry: Entry, state: LayerPreview): void {
    entry.state = state;
    for (const listener of [...(this.#listeners.get(layerId) ?? [])]) listener();
  }
}

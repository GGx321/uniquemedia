import type { EngineError, TextLayer } from "../../shared/engine";
import type { TextPreviewOutcome } from "./textPreview";

// 3d.4: the window's ONE queue of `montages.textPreview` asks, per text layer, shared by every consumer of a caption's picture: the
// preview (each text layer's PNG and its box) and the properties panel (the caption's verdict, 3d.5).
//
// Why one. The engine keeps a queue per layer as well, and answers an ask still waiting there TEXT_PREVIEW_SUPERSEDED when a newer
// ask of the same layer arrives. When the panel and the preview asked on their own, one's ask could supersede the other's, and the
// other would wait for ever for the answer to an ask nobody draws (the 3d.5 note). Here:
// - a consumer never waits for ITS ask: it reads the layer's state, which the newest answer decides;
// - an ask for the look the newest ask already asked for is not sent again: the preview and the panel share it;
// - an answer to an older ask that was superseded is dropped silently (the newer ask is out, and its answer is what counts), and an
//   answer older than the one shown is dropped;
// - the NEWEST ask superseded means something outside this window asked for the layer (another window with the draft open): it is
//   asked again, a few times, and then settled as failed, so nothing is ever left pending.

/** Every answer but `superseded`, which is no answer at all. */
export type PreviewAnswer = Exclude<TextPreviewOutcome, { kind: "superseded" }>;
export type PictureAnswer = Extract<PreviewAnswer, { kind: "picture" }>;

export interface LayerPreview {
  /** How many asks were sent for the layer (the newest ask's number); 0 = never asked. */
  readonly asked: number;
  /** The look of the newest ask: what the layer's picture is being drawn for. */
  readonly look: string | null;
  /** The newest answer, with its ask's number and look. Pending while `asked` is above its `ask`. */
  readonly shown: { readonly ask: number; readonly look: string; readonly answer: PreviewAnswer } | null;
  /** The newest picture drawn, kept through a later refusal: what the preview shows (marked when it is not of the newest look). */
  readonly picture: { readonly ask: number; readonly look: string; readonly answer: PictureAnswer } | null;
}

export const NO_PREVIEW: LayerPreview = { asked: 0, look: null, shown: null, picture: null };

/** How many times the newest ask is asked again after something outside this window superseded it. */
const OUTSIDE_RETRIES = 3;

const GAVE_UP: EngineError = { code: "INTERNAL", detail: "the text preview kept being replaced by asks from elsewhere" };
const NOT_ASKED: EngineError = { code: "INTERNAL", detail: "the text preview could not be asked for" };

/** What decides a caption's picture: the text, the font, the style, the colour and the size (never the place or the time). */
export function previewLook(layer: TextLayer): string {
  return JSON.stringify([layer.value, layer.font, layer.style, layer.color, layer.scale]);
}

interface Entry {
  state: LayerPreview;
  /** The newest ask's layer, sent again on a reload or after an outside supersede. */
  layer: TextLayer | null;
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
    entry.retries = 0;
    this.#send(entry, layer, look);
  }

  /** Asks again for the layer's newest look, answered or not: its picture is no longer served (the engine keeps 64). */
  reload(layerId: string): void {
    const entry = this.#entries.get(layerId);
    if (entry === undefined || entry.layer === null || entry.state.look === null) return;
    entry.retries = 0;
    this.#send(entry, entry.layer, entry.state.look);
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
      entry = { state: NO_PREVIEW, layer: null, retries: 0 };
      this.#entries.set(layerId, entry);
    }
    return entry;
  }

  #send(entry: Entry, layer: TextLayer, look: string): void {
    const ask = entry.state.asked + 1;
    entry.layer = layer;
    this.#set(layer.layerId, entry, { ...entry.state, asked: ask, look });
    this.#ask(layer).then(
      (outcome) => this.#answer(layer.layerId, ask, look, outcome),
      () => this.#answer(layer.layerId, ask, look, { kind: "failed", error: NOT_ASKED }),
    );
  }

  #answer(layerId: string, ask: number, look: string, outcome: TextPreviewOutcome): void {
    const entry = this.#entries.get(layerId);
    if (entry === undefined) return;
    const { state } = entry;
    if (outcome.kind === "superseded") {
      // An older ask: the newer one is out. The newest: something outside this window asked for the layer; ask again, a few times.
      if (ask !== state.asked || entry.layer === null) return;
      if (entry.retries < OUTSIDE_RETRIES) {
        entry.retries += 1;
        this.#send(entry, entry.layer, look);
      } else this.#show(layerId, entry, ask, look, { kind: "failed", error: GAVE_UP });
      return;
    }
    if (state.shown !== null && ask <= state.shown.ask) return;
    this.#show(layerId, entry, ask, look, outcome);
  }

  #show(layerId: string, entry: Entry, ask: number, look: string, answer: PreviewAnswer): void {
    const picture = answer.kind === "picture" && (entry.state.picture === null || ask > entry.state.picture.ask) ? { ask, look, answer } : entry.state.picture;
    this.#set(layerId, entry, { ...entry.state, shown: { ask, look, answer }, picture });
  }

  #set(layerId: string, entry: Entry, state: LayerPreview): void {
    entry.state = state;
    for (const listener of [...(this.#listeners.get(layerId) ?? [])]) listener();
  }
}

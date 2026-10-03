import type { EngineError, TextLayer } from "../../shared/engine";
import { FRAME_H, FRAME_W } from "../../shared/montage";
import { crc32 } from "../../shared/stickers/crc32";
import { captionIssue } from "../../shared/text/captionRules";
import { CaptionLayoutError, layoutCaption, type CaptionLayout } from "../../shared/text/layout";
import type { Scheduler } from "./scheduler";

// The dev mock's text previews (3d.1b): `montages.textPreview` as the engine answers it (studio/engine/text/preview.ts), over a
// stand-in for the text worker. What is the engine's own, and shared with it: the technical caption rules, the layout's
// refusals, the lane (one drawing at a time, in the order asked), TEXT_PREVIEW_SUPERSEDED for a QUEUED preview that a newer one of the
// same layer replaced (a drawing already running is never cancelled), and the per-layer eviction of the pictures kept.
// What is not: the box is the layout over an arithmetic width (0.55 em a character, no font), and the picture is a placeholder
// PNG of exactly that box (the plaque or the text colour and a bar per line), not the caption's pixels.

/** `previewId` and the box in pixels: what the engine answers. */
export interface MockPreviewResult {
  previewId: string;
  width: number;
  height: number;
}

export type MockPreviewOutcome = { ok: true; result: MockPreviewResult } | { ok: false; error: EngineError };

export interface MockTextDeps {
  scheduler: Scheduler;
  /** How long one drawing takes on the mock's clock; 0 draws in the next microtask. */
  drawMs: number;
  /** A fresh preview id. */
  newId: () => string;
}

/** The engine's bound on the pictures it keeps (`TextPreviewDeps.maxFiles`): past it the oldest that is not a layer's newest goes. */
const KEPT_PICTURES = 64;

/** The advance of a character at 100 px: 0.55 em, the width of an average Latin letter. */
const ADVANCE_PER_CHAR = 55;
/** The plaque's padding in ems (template.ts): across, above, below. Every style gets the plaque's, so the mock's box is never smaller than the engine's. */
const PAD_ACROSS_EM = 0.5;
const PAD_ABOVE_EM = 0.13;
const PAD_BELOW_EM = 0.21;

interface Call {
  readonly layer: TextLayer;
  started: boolean;
  readonly settle: (outcome: MockPreviewOutcome) => void;
}

interface Box {
  width: number;
  height: number;
  layout: CaptionLayout;
}

/** The layout of a caption over arithmetic widths, and the box it would be drawn in. Throws what the engine's layout throws. */
function boxOf(layer: TextLayer): Box {
  const layout = layoutCaption({
    text: layer.value,
    scale: layer.scale,
    measure: (run) => [...run].length * ADVANCE_PER_CHAR,
    emojiAspect: () => 1,
  });
  const width = Math.min(FRAME_W, Math.ceil(layout.textWidth + 2 * PAD_ACROSS_EM * layout.fontSize));
  const height = Math.min(FRAME_H, Math.ceil(layout.lines.length * layout.lineHeight + (PAD_ABOVE_EM + PAD_BELOW_EM) * layout.fontSize));
  return { width, height, layout };
}

export class MockTextPreviews {
  readonly #deps: MockTextDeps;
  /** Waiting for the lane, in the order asked. */
  #queue: Call[] = [];
  /** Each layer's newest call that has not ended: what a newer one of the layer replaces. */
  readonly #latest = new Map<string, Call>();
  #running: Call | null = null;
  #held = false;
  #letGo: (() => void) | null = null;
  /** The pictures kept, oldest first, with the layer each is of; and each layer's newest. */
  readonly #written: { id: string; layerId: string }[] = [];
  readonly #newest = new Map<string, string>();
  readonly #pictures = new Map<string, Uint8Array>();

  constructor(deps: MockTextDeps) {
    this.#deps = deps;
  }

  /** The engine's `preview`: answered when the lane has drawn it, or at once when a newer preview of the layer replaced it in the queue. */
  preview(layer: TextLayer): Promise<MockPreviewOutcome> {
    return new Promise((settle) => {
      const call: Call = { layer, started: false, settle };
      const older = this.#latest.get(layer.layerId);
      if (older !== undefined && !older.started) {
        this.#queue = this.#queue.filter((queued) => queued !== older);
        older.settle({ ok: false, error: { code: "TEXT_PREVIEW_SUPERSEDED" } });
      }
      this.#latest.set(layer.layerId, call);
      this.#queue.push(call);
      this.#pump();
    });
  }

  /** The PNG a `previewId` is served as, or null for an id that was never given or has been evicted. */
  picture(previewId: string): Uint8Array | null {
    return this.#pictures.get(previewId) ?? null;
  }

  /** Test control: while held, a drawing that has started waits for `release`. Letting go (false) also ends the drawing that waits. */
  hold(held: boolean): void {
    this.#held = held;
    if (!held) this.release();
  }

  /** Test control: the drawing that waits ends now (and the next one starts, and waits again while held). Nothing running: nothing happens. */
  release(): void {
    const letGo = this.#letGo;
    this.#letGo = null;
    letGo?.();
  }

  #pump(): void {
    if (this.#running !== null) return;
    const call = this.#queue.shift();
    if (call === undefined) return;
    this.#running = call;
    call.started = true;
    const finish = (): void => {
      const outcome = this.#draw(call.layer);
      this.#running = null;
      if (this.#latest.get(call.layer.layerId) === call) this.#latest.delete(call.layer.layerId);
      call.settle(outcome);
      this.#pump();
    };
    if (this.#held) this.#letGo = finish;
    else if (this.#deps.drawMs > 0) this.#deps.scheduler.schedule(this.#deps.drawMs, finish);
    else void Promise.resolve().then(finish);
  }

  /** The worker's answer for a layer: a caption rule, the layout's refusal, or a picture that is kept. */
  #draw(layer: TextLayer): MockPreviewOutcome {
    // The mock has no font: every well-formed emoji is drawable. A cluster the real font lacks is still `emoji-missing` there.
    const issue = captionIssue(layer.value, { hasEmoji: () => true });
    if (issue !== null) return { ok: false, error: { code: "TEXT_INVALID", captionIssue: issue, detail: `the caption breaks the rule "${issue}"` } };
    let box: Box;
    try {
      box = boxOf(layer);
    } catch (error) {
      if (error instanceof CaptionLayoutError) return { ok: false, error: { code: "RENDER_FAILED", detail: `text rendering failed (RENDER_FAILED): ${error.message}` } };
      throw error;
    }
    const previewId = this.#deps.newId();
    this.#keep(layer.layerId, previewId, placeholderPng(layer, box));
    return { ok: true, result: { previewId, width: box.width, height: box.height } };
  }

  #keep(layerId: string, previewId: string, png: Uint8Array): void {
    this.#pictures.set(previewId, png);
    this.#written.push({ id: previewId, layerId });
    this.#newest.set(layerId, previewId);
    this.#evict();
  }

  /**
   * Over the bound, the oldest picture that is not a layer's newest goes first: dragging one layer's size makes a picture per
   * frame, and must not take the pictures of the other layers away. When only newest ones are left the folder stays over the
   * bound, up to four times it; past that a caller is inventing layers, and the oldest go (the engine's own rule).
   */
  #evict(): void {
    const remove = (at: number): void => {
      const [gone] = this.#written.splice(at, 1);
      if (gone === undefined) return;
      if (this.#newest.get(gone.layerId) === gone.id) this.#newest.delete(gone.layerId);
      this.#pictures.delete(gone.id);
    };
    while (this.#written.length > KEPT_PICTURES) {
      const at = this.#written.findIndex((entry) => this.#newest.get(entry.layerId) !== entry.id);
      if (at < 0) break;
      remove(at);
    }
    while (this.#written.length > 4 * KEPT_PICTURES) remove(0);
  }
}

// ---------- the placeholder picture ----------

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A zlib stream of stored (uncompressed) blocks: no deflate in the renderer, and the picture is a few KB of flat colour. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let b = 0; b < blocks; b++) {
    const part = raw.subarray(b * 65535, (b + 1) * 65535);
    out[at++] = b === blocks - 1 ? 1 : 0;
    out[at++] = part.length & 255;
    out[at++] = part.length >>> 8;
    out[at++] = ~part.length & 255;
    out[at++] = (~part.length >>> 8) & 255;
    out.set(part, at);
    at += part.length;
  }
  new DataView(out.buffer).setUint32(at, adler32(raw));
  return out;
}

function rgb(color: string): [number, number, number] {
  return [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
}

/** Dark ink on a light plaque and the reverse (the engine's #111111 or #ffffff by contrast, here by luma). */
function inkFor(color: string): [number, number, number] {
  const [r, g, b] = rgb(color);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? [0x11, 0x11, 0x11] : [0xff, 0xff, 0xff];
}

/**
 * A 2-bit palette PNG of exactly the box: the plaque (the layer's colour) with a bar of ink per line for «Плашка», else a
 * transparent box with a bar of the layer's colour per line. Index 0 is transparent, 1 the plaque or the colour, 2 the ink.
 */
function placeholderPng(layer: TextLayer, box: Box): Uint8Array {
  const { width, height, layout } = box;
  const plaque = layer.style === "plaque";
  const stride = 1 + Math.ceil(width / 4);
  const raw = new Uint8Array(stride * height);
  const set = (x: number, y: number, index: number): void => {
    const at = y * stride + 1 + (x >> 2);
    const shift = 6 - 2 * (x & 3);
    raw[at] = ((raw[at] ?? 0) & ~(3 << shift)) | (index << shift);
  };
  const barIndex = plaque ? 2 : 1;
  if (plaque) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, 1);
  const top = PAD_ABOVE_EM * layout.fontSize;
  layout.lines.forEach((line, row) => {
    const left = Math.round((width - line.width) / 2);
    const y0 = Math.round(top + row * layout.lineHeight + layout.fontSize * 0.3);
    const y1 = Math.min(height, y0 + Math.max(2, Math.round(layout.fontSize * 0.45)));
    for (let y = Math.max(0, y0); y < y1; y++) for (let x = Math.max(0, left); x < Math.min(width, left + Math.round(line.width)); x++) set(x, y, barIndex);
  });

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 2; // bit depth
  header[9] = 3; // colour type: palette
  const [pr, pg, pb] = rgb(layer.color);
  const palette = Uint8Array.from([0, 0, 0, pr, pg, pb, ...(plaque ? inkFor(layer.color) : [pr, pg, pb]), 0, 0, 0]);
  const parts = [Uint8Array.from(SIGNATURE), chunk("IHDR", header), chunk("PLTE", palette), chunk("tRNS", Uint8Array.from([0, 255, 255, 255])), chunk("IDAT", zlibStored(raw)), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

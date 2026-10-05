import { describe, expect, test } from "bun:test";
import type { MontageDraft, MontageIssue, TextLayer } from "../engine/montage";
import { captionIssue } from "./captionRules";
import { draftCaptionIssues } from "./draftCaptionIssues";

// The caption half of a draft's issues: one `caption-invalid` per text layer whose caption breaks the SHARED caption rules, at the
// layer's `value`. One function for `videos.render`, `montages.get` and the mock, so a render is refused before it is queued.

/** "Privet" in Cyrillic: outside the charset, written as escapes so the file stays English. */
const CYRILLIC = "Привет";
const BAD_AT = (index: number): MontageIssue => ({ code: "caption-invalid", path: ["layers", index, "value"] });

const textLayer = (layerId: string, value: string): TextLayer => ({
  layerId,
  kind: "text",
  startMs: 0,
  endMs: 1_000,
  value,
  font: "manrope",
  style: "plaque",
  color: "#ffffff",
  x: 0.5,
  y: 0.5,
  scale: 1,
});
const stickerLayer = (layerId: string): MontageDraft["layers"][number] => ({ layerId, kind: "sticker", startMs: 0, endMs: 1_000, sticker: { source: "builtin", stickerId: "any" }, x: 0.5, y: 0.5, size: 0.2 });
const spec = (...layers: MontageDraft["layers"]): Pick<MontageDraft, "layers"> => ({ layers });

describe("draftCaptionIssues", () => {
  test("says nothing for a valid caption", () => {
    expect(draftCaptionIssues(spec(textLayer("layer-1", "Hello, world")))).toEqual([]);
  });

  test("says nothing for a draft with no layers", () => {
    expect(draftCaptionIssues(spec())).toEqual([]);
  });

  test("says nothing for an empty caption: the contract's Caption keeps it out, the rules do not", () => {
    expect(draftCaptionIssues(spec(textLayer("layer-1", "")))).toEqual([]);
  });

  test("accepts a caption of exactly 60 graphemes", () => {
    expect(draftCaptionIssues(spec(textLayer("layer-1", "a".repeat(60))))).toEqual([]);
  });

  test("reports a caption of 61 graphemes at the layer's value", () => {
    expect(draftCaptionIssues(spec(textLayer("layer-1", "a".repeat(61))))).toEqual([BAD_AT(0)]);
  });

  test("reports a character outside the charset", () => {
    expect(draftCaptionIssues(spec(textLayer("layer-1", CYRILLIC)))).toEqual([BAD_AT(0)]);
  });

  test("reports a copyright sign, which is refused in every form", () => {
    expect(draftCaptionIssues(spec(textLayer("layer-1", "Acme ©")))).toEqual([BAD_AT(0)]);
  });

  test("reports a third line", () => {
    expect(draftCaptionIssues(spec(textLayer("layer-1", "a\nb\nc")))).toEqual([BAD_AT(0)]);
  });

  test("reports one issue per bad layer however many rules it breaks", () => {
    expect(draftCaptionIssues(spec(textLayer("layer-1", `${CYRILLIC}\n\n${"a".repeat(70)}`)))).toEqual([BAD_AT(0)]);
  });

  test("reports only the bad one of several text layers, at its own index among all layers", () => {
    const issues = draftCaptionIssues(spec(textLayer("layer-1", "Good"), stickerLayer("layer-2"), textLayer("layer-3", CYRILLIC), textLayer("layer-4", "Also good")));
    expect(issues).toEqual([BAD_AT(2)]);
  });

  test("reports every bad layer, in layer order", () => {
    const issues = draftCaptionIssues(spec(textLayer("layer-1", CYRILLIC), textLayer("layer-2", "Good"), textLayer("layer-3", "a\nb\nc")));
    expect(issues).toEqual([BAD_AT(0), BAD_AT(2)]);
  });

  test("does not read a sticker layer as a caption", () => {
    expect(draftCaptionIssues(spec(stickerLayer("layer-1")))).toEqual([]);
  });

  test("judges a caption by the same rules the panel's check uses", () => {
    const value = "a\nb\nc";
    expect(captionIssue(value, { hasEmoji: () => true })).not.toBeNull();
    expect(draftCaptionIssues(spec(textLayer("layer-1", value)))).toEqual([BAD_AT(0)]);
  });
});

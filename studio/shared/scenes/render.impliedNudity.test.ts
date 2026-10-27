import { describe, expect, test } from "bun:test";
import { BANKS } from "./banks";
import { shotOf } from "./captures";
import type { TemplateContext, TemplateSlot } from "./template";
import { coverageOf, templateSentence } from "./template";

// 5a.4 (S5.BA1, plan s5a4 I5.74, M7): `TemplateContext.impliedNudity` is the render's origin input. It is OPTIONAL on the context and an absent value reads false (imported,
// fail-closed); the engine passes `studioCreated(avatarId)` from BA5 on.
// 5a.4 (S5.BA3, 2026-10-26): the template reads it now, and only for the coverage sentence a Seedream frame ends with (template.boldAny.test.ts holds the rows). It changes nothing else.

const place = BANKS.nightwear.places[0];
const moment = place?.moments.find((m) => m.legs === undefined && m.level === undefined && m.outfits === undefined && m.captures[0] === "above");
const outfit = BANKS.nightwear.outfits.find((o) => o.route === "seedream");
if (place === undefined || moment === undefined || outfit === undefined) throw new Error("the nightwear bank has no plain above moment or no Seedream outfit");
const SLOT: TemplateSlot = { category: "nightwear", route: undefined, location: place.name, activity: moment.text, outfit: outfit.text, shot: shotOf("above"), capture: "above", pose: "front", level: "bold" };

describe("TemplateContext.impliedNudity", () => {
  test("the field is optional and boolean", () => {
    const absent: TemplateContext = { key: "slot-1" };
    const off: TemplateContext = { key: "slot-1", impliedNudity: false };
    const on: TemplateContext = { key: "slot-1", impliedNudity: true };
    // @ts-expect-error a flag is a boolean, never a string
    const bad: TemplateContext = { key: "slot-1", impliedNudity: "studio" };
    expect([absent.impliedNudity, off.impliedNudity, on.impliedNudity, typeof bad.impliedNudity]).toEqual([undefined, false, true, "string"]);
  });

  test("a sentence is the same with the flag false or absent, and with it true only the trailing coverage sentence can differ", () => {
    const results = (["absent", false, true] as const).map((flag) => {
      const ctx: TemplateContext = flag === "absent" ? { key: "slot-1" } : { key: "slot-1", impliedNudity: flag };
      return templateSentence(SLOT, ctx);
    });
    expect(results[0]).not.toBeNull();
    expect(results[1]).toBe(results[0]);
    const kept = coverageOf(moment, outfit, false);
    const open = coverageOf(moment, outfit, true);
    const body = kept === undefined ? results[0] : results[0]?.slice(0, results[0].length - kept.length - 1);
    expect(results[2]).toBe(open === undefined ? (body ?? null) : `${body} ${open}`);
  });
});

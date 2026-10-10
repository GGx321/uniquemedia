import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AvatarDescriptor } from "../../shared/engine";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { assembleRun } from "./assembler";
import { imperfectionOf, roomStateOf } from "./phoneLook";
import { plan, type PlanInput } from "./planner";
import { roomPlaceOf } from "./roomPlace";
import type { ScenePlan } from "./schema";
import { CATEGORIES } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.1c (I5.4): the look draws (the imperfection, the room state) run on streams of their own, keyed by `${runId}:${attemptIdBase}`. They never consume the
// planner's rng, never touch a plan, and a plan never depends on them. Pinned against the post-T11 planner hashes (planner-main-3a9cd498.json, re-pinned
// with the pool rewrite): assembling every plan of the golden, with the room lookup on, leaves each plan's hash exactly as pinned.

const fixture: { excludePairsFrom: { seed: number; count: number; take: number }; hashes: Record<string, string> } = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "planner-main-3a9cd498.json"), "utf8"));
const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build." };
const MASTER = asLibraryReference(JPEG);

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Assembles every slot of the plan, the way a run does (the room lookup wired in). */
function assemble(scenes: ScenePlan, runId: string): string[] {
  const sentences = new Map(scenes.slots.map((s) => [s.slotIndex, "She stands there for a moment."]));
  return assembleRun(DESCRIPTOR, scenes, sentences, MASTER, { runId, roomPlaceOf, cameraRealism: true }).map((a) => a.prompt);
}

describe("the look draws do not move the planner", () => {
  const seeds = [1, 7, 42, 2026, 123456789, 4294967295];
  const counts = [1, 7, 20, 33, 100];
  const { seed, count, take } = fixture.excludePairsFrom;
  const excludePairs = plan({ seed, count, categories: [...CATEGORIES] })
    .slots.slice(0, take)
    .map((s) => ({ location: s.location, outfit: s.outfit }));
  const ALL = [...CATEGORIES].join(",");

  test("assembling every plan of the golden (frozen, with the room lookup and «Реализм камеры» on) changes none, and the hash is still the pinned one", () => {
    const all: ScenePlan[] = [];
    for (const s of seeds) {
      for (const c of counts) {
        const base: PlanInput = { seed: s, count: c, categories: [...CATEGORIES] };
        all.push(deepFreeze(plan(base)));
        all.push(deepFreeze(plan({ ...base, poses: { profile: true, back: true }, excludePairs })));
      }
    }
    for (const scenes of all) assemble(scenes, "run-00000001");
    expect(sha(all)).toBe(fixture.hashes[ALL]);
  });

  test("drawing many imperfections and room states first leaves the next plan as pinned", () => {
    for (let i = 0; i < 2000; i++) {
      const key = `run-${i}:slot-${i % 30}`;
      imperfectionOf("friend", key);
      roomStateOf(key, { room: true, details: ["a kettle on the counter", "a fruit bowl"], activity: { messyOk: true } });
    }
    expect(sha(plan({ seed: 9, count: 20, categories: [...CATEGORIES].reverse() }))).toBe(fixture.hashes["rev-order"]);
  });

  test("a plan carries no run id: the same plan assembled under two runs differs only where a look draw differs", () => {
    const scenes = plan({ seed: 2026, count: 40, categories: [...CATEGORIES] });
    const a = assemble(scenes, "run-aaaaaaaa");
    const b = assemble(scenes, "run-bbbbbbbb");
    expect(a).not.toEqual(b);
    expect(assemble(scenes, "run-aaaaaaaa")).toEqual(a);
    expect(sha(scenes)).toBe(sha(plan({ seed: 2026, count: 40, categories: [...CATEGORIES] })));
  });
});

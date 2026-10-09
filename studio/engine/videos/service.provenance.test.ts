import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { JobState, type EngineError } from "../../shared/engine";
import type { MontageDraft } from "../../shared/engine/montage";
import { EngineFailure } from "../engineFailure";
import { readVideoRecordFiles } from "./listing";
import type { VideoProvenance } from "./record";
import { specOf, useWorld, type World } from "./testing/kit";
import { serviceRig } from "./testing/serviceKit";
useNativeGlobals();

// S4.5c (plan §8.1, §8.3): the video service's internal render input `{ montageId: null, spec, provenance }`. The command `videos.render` is unchanged and never carries provenance.
// The autopilot's renders keep their provenance through the queue, the commit and the listing; the engine refuses an autopilot spec above 10 000 ms or with a text layer (A8, A9).

const world = useWorld();
const provenance: VideoProvenance = { origin: "autopilot", launchId: "launch-0a1b2c3d4e5f", launchVideoKey: "1-3" };

const specFor = (w: World, durationMs = 4_000): MontageDraft => specOf(w.avatar.id, [w.photos[0]?.id ?? ""], durationMs);
const textLayer = { layerId: "layer-00000001", kind: "text" as const, startMs: 0, endMs: 1000, value: "hello", font: "manrope" as const, style: "none" as const, color: "#ffffff", x: 0.5, y: 0.5, scale: 1 };

async function failureOf(work: Promise<unknown>): Promise<EngineError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof EngineFailure) return error.error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("an autopilot render", () => {
  test("ends with a record that carries the provenance", async () => {
    const w = world();
    const r = serviceRig(w);

    const { videoId } = await r.service.renderInternal({ montageId: null, spec: specFor(w), provenance });
    await r.queue.idle();

    const read = await readVideoRecordFiles(w.libraryRoot, w.avatar.id);
    expect(read.records.map((record) => record.id)).toEqual([videoId]);
    expect(read.records[0]).toMatchObject(provenance);
  });

  test("lists with origin and launch id, and the commit announces the same", async () => {
    const w = world();
    const r = serviceRig(w);

    const { videoId } = await r.service.renderInternal({ montageId: null, spec: specFor(w), provenance });
    await r.queue.idle();

    const [listed] = await r.service.list(w.avatar.id);
    expect(listed).toMatchObject({ videoId, origin: "autopilot", launchId: provenance.launchId });
    const changed = r.stamped().find((event) => event.type === "video.changed");
    expect(changed?.type === "video.changed" && changed.payload.change === "upserted" ? changed.payload.video : null).toMatchObject({ videoId, origin: "autopilot", launchId: provenance.launchId });
  });

  test("a manual render of the same spec has no origin and no launch", async () => {
    const w = world();
    const r = serviceRig(w);

    const { videoId } = await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    const [listed] = await r.service.list(w.avatar.id);
    expect(listed?.videoId).toBe(videoId);
    expect(listed !== undefined && "origin" in listed).toBe(false);
    expect(listed !== undefined && "launchId" in listed).toBe(false);
    const read = await readVideoRecordFiles(w.libraryRoot, w.avatar.id);
    expect(read.records[0] !== undefined && "origin" in read.records[0]).toBe(false);
  });

  test("a spec of exactly 10 000 ms is rendered", async () => {
    const w = world();
    const r = serviceRig(w);

    await r.service.renderInternal({ montageId: null, spec: specFor(w, 10_000), provenance });
    await r.queue.idle();

    expect(r.queue.states()[0]?.status).toBe("done");
  });
});

describe("the render job's state names its launch (JobState.launchId, S4.6c1)", () => {
  test("a render with provenance is a job of that launch, queued and done", async () => {
    const w = world();
    const r = serviceRig(w);

    await r.service.renderInternal({ montageId: null, spec: specFor(w), provenance });
    expect(r.queue.states().map((state) => (state.kind === "render" ? state.launchId : undefined))).toEqual([provenance.launchId]);
    await r.queue.idle();

    const [state] = r.queue.states();
    expect(state).toMatchObject({ kind: "render", status: "done", launchId: provenance.launchId });
  });

  test("the state with its launch still fits the contract's JobState", async () => {
    const w = world();
    const r = serviceRig(w);

    await r.service.renderInternal({ montageId: null, spec: specFor(w), provenance });
    await r.queue.idle();

    expect(JobState.safeParse(r.queue.states()[0]).success).toBe(true);
  });

  test("a manual render's job has no launch", async () => {
    const w = world();
    const r = serviceRig(w);

    await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    const [state] = r.queue.states();
    expect(state !== undefined && "launchId" in state).toBe(false);
  });
});

describe("what the engine refuses an autopilot render", () => {
  /** A refusal touches nothing: no job, no export folder, no record. */
  async function expectNothingTouched(r: ReturnType<typeof serviceRig>): Promise<void> {
    expect(r.queue.states()).toEqual([]);
    expect(existsSync(join(r.w.exportRoot, "Mia"))).toBe(false);
    expect(await readdir(r.w.renderTmp)).toEqual([]);
    expect(r.w.library.videoCount(r.w.avatar.id)).toBe(0);
  }

  test("a spec one 100 ms step above 10 000 ms is refused, never clamped (A8)", async () => {
    const w = world();
    const r = serviceRig(w);

    const error = await failureOf(r.service.renderInternal({ montageId: null, spec: specFor(w, 10_100), provenance }));

    expect(error.code).toBe("MONTAGE_INVALID");
    expect(error.issues).toEqual([{ code: "duration-too-long", path: ["clips"] }]);
    await expectNothingTouched(r);
  });

  test("the same spec is fine for a manual render (the manual limit is 15 s)", async () => {
    const w = world();
    const r = serviceRig(w);

    await r.service.render({ spec: specFor(w, 10_100) });
    await r.queue.idle();

    expect(r.queue.states()[0]?.status).toBe("done");
  });

  test.each([
    ["a launch id that is a path", { launchId: "../launch" }],
    ["a launch id of another kind", { launchId: "run-0a1b2c3d4e5f" }],
    ["a video key out of range", { launchVideoKey: "3-51" }],
    ["an empty video key", { launchVideoKey: "" }],
  ])("%s is refused with INTERNAL before anything is queued or named", async (_name, patch) => {
    const w = world();
    const r = serviceRig(w);

    const error = await failureOf(r.service.renderInternal({ montageId: null, spec: specFor(w), provenance: { ...provenance, ...patch } }));

    expect(error.code).toBe("INTERNAL");
    expect(r.checks).toHaveLength(0);
    await expectNothingTouched(r);
  });

  test("a spec with a text layer is refused at the layer (A9)", async () => {
    const w = world();
    const r = serviceRig(w);

    const error = await failureOf(r.service.renderInternal({ montageId: null, spec: { ...specFor(w), layers: [textLayer] }, provenance }));

    expect(error.code).toBe("MONTAGE_INVALID");
    expect(error.issues).toEqual([{ code: "too-many-text-layers", path: ["layers", 0] }]);
    await expectNothingTouched(r);
  });
});

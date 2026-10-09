import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IDLE_STEPS } from "./autopilot/steps";
import { MAX_AUTOPILOT_RENDERS } from "./autopilot/freeSteps";
import { MAX_UNFINISHED_RENDERS } from "./renderQueue/queue";
import { failed, jobEnd, ledgerLines, ok, useEngineDir } from "./testing/engineHarness";
import { crashKit, fakeRender, ledgerSpentOf } from "./testing/crashKit";
import { draftOf, network } from "./testing/wiringKit";
import { readVideoRecordFiles } from "./videos/listing";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6d (plan §10): the invariants of the batch autopilot that no other test pinned at the level of the real engine. The engine-level pins that already exist are listed in plan §28 (A1, A2,
// A5, A6, A7, A8, A9, A11, A12, A13, A16, A18, A19, A20, A21 and the rest of A3, A4, A14, A15). What is added here, each over a real engine, a real ledger and a fake OpenRouter:
//   A3   a restart and «Продолжить» re-plan nothing and raise nothing: the allocation, W′ and the group's cap stand as the start wrote them.
//   A10  the owner's renders are never refused because of the autopilot while it holds at most 8 of the queue's 20.
//   A14  the owner's paid review edits are apart from the launch's spent sum and from its limit, and the figure is frozen when the launch ends.
//   A15  an autopilot record carries its provenance and the owner's «Опубликовано» mark never rewrites it.
//   A17  a plan that needs more than 100 new photos for one avatar is refused at the estimate and at the start; exactly 100 is not.

setDefaultTimeout(120_000);

// Registered BEFORE `useEngineDir`: hooks run first in, first out, and the engines must be shut down before their folder is removed.
afterEach(() => kit.shutdownAll());
const dir = useEngineDir("studio-engine-autopilot-invariants-");
const kit = crashKit(dir);
beforeEach(() => kit.reset());

const never = (): Promise<never> => new Promise<never>(() => undefined);

describe("A3: a restart and «Продолжить» re-plan nothing and raise nothing", () => {
  test("the allocation, W′, what was accepted and the group's cap are the start's, before and after the resume", async () => {
    const avatarId = await kit.seedAvatar(0);
    const net1 = network();
    const first = await kit.boot(net1, { launchSteps: IDLE_STEPS, ...fakeRender() });
    const draft = draftOf([avatarId], { videosPerAvatar: 1 });
    const estimate = ok(await kit.call(first, "autopilot.estimate", { draft }));
    if (estimate.type !== "autopilot.estimate") throw new Error("wrong answer");
    // The owner accepts MORE than the worst case: the launch still spends at most W′, and nothing is raised to the click.
    const generous = estimate.result.preview.estimate.worstMicros + 1_000_000;
    const answer = ok(await kit.call(first, "autopilot.start", { draft: { ...draft, planSeed: estimate.result.preview.planSeed }, acceptedWorstMicros: generous }));
    if (answer.type !== "autopilot.start") throw new Error("wrong answer");
    const launch = answer.result.launch;
    const started = kit.fileOf(launch.launchId);
    expect(started.acceptedMicros).toBe(generous);
    expect(started.plannedWorstMicros).toBe(estimate.result.preview.estimate.worstMicros);
    await kit.crash(first, [net1]);

    const second = await kit.boot(network(), fakeRender());
    await second.engine.settled();
    const capOf = (): number | undefined => second.engine.launchGroups.groupOf({ attemptId: `${started.avatars[0]?.generation?.sceneSetId}:writer-1#1`, scope: { avatarJobId: "job-x" } })?.capMicros;
    expect(capOf()).toBe(started.plannedWorstMicros);
    await kit.resumeLaunch(second, launch.launchId);
    expect(capOf()).toBe(started.plannedWorstMicros);
    await kit.driveToDone(second, launch.launchId);

    const ended = kit.fileOf(launch.launchId);
    expect(ended.plannedWorstMicros).toBe(started.plannedWorstMicros);
    expect(ended.acceptedMicros).toBe(started.acceptedMicros);
    expect(ended.avatars[0]?.allocation).toEqual(started.avatars[0]?.allocation);
    expect(ended.avatars[0]?.generation).toEqual(started.avatars[0]?.generation);
    expect(ended.spentMicros).toBeLessThanOrEqual(ended.plannedWorstMicros);
    // A slice's cap is inside the draw allocation, however much the owner accepted.
    const runs = ok(await kit.call(second, "runs.list", {}));
    if (runs.type !== "runs.list") throw new Error("wrong answer");
    expect(runs.result.runs.reduce((sum, r) => sum + r.capMicros, 0)).toBeLessThanOrEqual(started.avatars[0]?.allocation.drawMicros ?? 0);
  });
});

describe("A10: the owner's renders are never refused because of the autopilot while it holds at most 8", () => {
  test("the autopilot never has more than 8 unfinished renders in the queue, and the owner then fits 12 more: the 13th is the queue's own limit", async () => {
    expect(MAX_AUTOPILOT_RENDERS).toBe(8);
    expect(MAX_UNFINISHED_RENDERS).toBe(20);
    const autoAvatar = await kit.seedAvatar(75, "auto", "Mia");
    const ownAvatar = await kit.seedAvatar(26, "own", "Eva");
    const started = await kit.boot(network(), fakeRender({ run: never }));
    // 15 slides over 75 photos; the renders hold (ffmpeg never answers), so the queue stays as full as the launch makes it.
    const launch = await kit.startLaunch(started, draftOf([autoAvatar], { library: true, generate: false, videosPerAvatar: 15, planSeed: 7 }));
    const autopilotRenders = () => started.engine.renders.states().filter((s) => s.kind === "render" && s.launchId === launch.launchId && (s.status === "queued" || s.status === "running"));
    await kit.drive(started, launch.launchId, "eight renders in the queue", () => autopilotRenders().length === MAX_AUTOPILOT_RENDERS, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(autopilotRenders()).toHaveLength(MAX_AUTOPILOT_RENDERS);

    const photos = ok(await kit.call(started, "photos.list", { avatarId: ownAvatar }));
    if (photos.type !== "photos.list") throw new Error("wrong answer");
    const scenePhotos = photos.result.photos.filter((p) => p.category === "home");
    expect(scenePhotos.length).toBeGreaterThanOrEqual(26);
    const renderSpec = (photoIds: readonly string[]) => ({
      schemaVersion: 1,
      avatarId: ownAvatar,
      layers: [],
      music: null,
      seed: 7,
      clips: photoIds.map((photoId, i) => ({ clipId: `clip-0000000${i + 1}`, kind: "photo", cell: { photo: { source: "scene", photoId }, focus: null }, motion: "static", durationMs: 2_000, transitionIn: "cut" })),
    });
    const ownRender = (index: number) => kit.call(started, "videos.render", { spec: renderSpec([scenePhotos[2 * index]?.photoId ?? "", scenePhotos[2 * index + 1]?.photoId ?? ""]) });
    for (let i = 0; i < MAX_UNFINISHED_RENDERS - MAX_AUTOPILOT_RENDERS; i += 1) ok(await ownRender(i));
    expect(autopilotRenders()).toHaveLength(MAX_AUTOPILOT_RENDERS);
    expect(failed(await ownRender(12)).error.code).toBe("RENDER_QUEUE_FULL");
  });
});

describe("A14: the owner's paid review edits are the launch's own figure apart, never part of its spent sum or its limit", () => {
  test("a rewrite during the review is in reviewWritesMicros and not in spentMicros; the figure is frozen at the end and spent is the ledger's sum over the launch's scopes", async () => {
    const avatarId = await kit.seedAvatar(0);
    const net = network();
    const started = await kit.boot(net, fakeRender());
    const launch = await kit.startLaunch(started, draftOf([avatarId], { sceneReview: true, videosPerAvatar: 1 }));
    await kit.waitView(started, launch.launchId, "the review wait", (v) => v.avatars[0]?.phase === "awaiting-review", 60_000);
    const before = (await kit.getLaunch(started, launch.launchId)).launch;
    expect(before.reviewWritesMicros).toBe(0);
    const row = before.avatars[0];
    if (row?.sceneSetId == null || row.setRevision == null) throw new Error("the waiting avatar names no set");

    const written = ok(await kit.call(started, "scenes.write", { sceneSetId: row.sceneSetId, revision: row.setRevision, target: { kind: "rewrite", sceneIds: [1], redraw: false }, acceptedWorstMicros: 1_000_000 }));
    if (written.type !== "scenes.write") throw new Error("wrong answer");
    await jobEnd(started.events, written.result.jobId);
    await started.engine.settled();

    const during = (await kit.getLaunch(started, launch.launchId)).launch;
    expect(during.reviewWritesMicros).toBeGreaterThan(0);
    expect(during.spentMicros).toBe(before.spentMicros);
    const group = `launch:${launch.launchId}`;
    expect(started.engine.budget?.committedOfGroup(group)).toBe(before.spentMicros);

    const after = (await kit.getLaunch(started, launch.launchId)).launch;
    expect(after.reviewWritesMicros).toBe(during.reviewWritesMicros);
    const done = await kit.drive(started, launch.launchId, "the launch to be done", (v) => v.status === "done");
    const file = kit.fileOf(launch.launchId);
    expect(file.reviewWritesMicros).toBe(during.reviewWritesMicros);
    expect(done.reviewWritesMicros).toBe(during.reviewWritesMicros);
    const generation = file.avatars[0]?.generation;
    if (generation === null || generation === undefined) throw new Error("the avatar does not generate");
    const lines = ledgerLines(kit.root());
    expect(done.spentMicros).toBe(ledgerSpentOf(lines, generation.sceneSetId, [generation.setRunId]));
    expect(done.spentMicros).toBeLessThanOrEqual(done.plannedWorstMicros);
    expect(lines.some((l) => l.type === "reserve" && typeof l.attemptId === "string" && l.attemptId.startsWith(`${generation.sceneSetId}:write-`))).toBe(true);
  });
});

describe("A15: provenance on the autopilot's records, and the owner's mark never rewrites one", () => {
  test("every record of a launch names its origin, launch and video key; a mark of «Опубликовано» leaves the record file as it was", async () => {
    const avatarId = await kit.seedAvatar(0);
    const started = await kit.boot(network(), fakeRender());
    const launch = await kit.startLaunch(started, draftOf([avatarId], { videosPerAvatar: 2 }));
    await kit.drive(started, launch.launchId, "the launch to be done", (v) => v.status === "done");
    const records = (await readVideoRecordFiles(kit.libraryDir(), avatarId)).records;
    expect(records).toHaveLength(2);
    for (const record of records) expect(record).toMatchObject({ origin: "autopilot", launchId: launch.launchId });
    expect(new Set(records.map((r) => r.launchVideoKey))).toEqual(new Set(["0-1", "0-2"]));

    const videoId = records[0]?.id ?? "";
    const recordFile = join(kit.libraryDir(), "avatars", avatarId, "videos", `${videoId}.json`);
    const bytesBefore = readFileSync(recordFile, "utf8");
    const marked = ok(await kit.call(started, "videos.setPublished", { videoId, published: true }));
    if (marked.type !== "videos.setPublished") throw new Error("wrong answer");
    expect(marked.result.video.publishedAt).not.toBeNull();
    ok(await kit.call(started, "videos.setPublished", { videoId, published: false }));
    expect(readFileSync(recordFile, "utf8")).toBe(bytesBefore);
  });
});

describe("A17: more than 100 new photos for one avatar are refused at the estimate and at the start; exactly 100 are not", () => {
  const slides = (videos: number) => draftOf(["placeholder"], { videosPerAvatar: videos, mix: { single: 0, collage: 0, slides: 100 } });

  test("20 slides of 5 photos plan and start; 21 are blocked in the preview, refused as too-many-photos at the start, and nothing is written or reserved", async () => {
    const avatarId = await kit.seedAvatar(0);
    const started = await kit.boot(network(), { launchSteps: IDLE_STEPS, ...fakeRender() });
    const fits = { ...slides(20), avatarIds: [avatarId] };
    const over = { ...slides(21), avatarIds: [avatarId] };

    const okEstimate = ok(await kit.call(started, "autopilot.estimate", { draft: fits }));
    if (okEstimate.type !== "autopilot.estimate") throw new Error("wrong answer");
    expect(okEstimate.result.preview.avatars[0]).toMatchObject({ toGenerate: 100, blocked: null });

    const overEstimate = ok(await kit.call(started, "autopilot.estimate", { draft: over }));
    if (overEstimate.type !== "autopilot.estimate") throw new Error("wrong answer");
    expect(overEstimate.result.preview.avatars[0]).toMatchObject({ toGenerate: 105, blocked: "too-many-photos" });

    const refused = failed(await kit.call(started, "autopilot.start", { draft: { ...over, planSeed: 7 }, acceptedWorstMicros: 1_000_000_000 }));
    expect(refused.error).toMatchObject({ code: "VALIDATION", launchReason: "too-many-photos" });

    // Exactly one over: 20 slides and 1 single are 101 new photos.
    const oneOver = { ...draftOf([avatarId], { videosPerAvatar: 21, mix: { single: 5, collage: 0, slides: 95 } }) };
    const oneOverEstimate = ok(await kit.call(started, "autopilot.estimate", { draft: oneOver }));
    if (oneOverEstimate.type !== "autopilot.estimate") throw new Error("wrong answer");
    expect(oneOverEstimate.result.preview.avatars[0]).toMatchObject({ toGenerate: 101, blocked: "too-many-photos" });
    const oneOverStart = failed(await kit.call(started, "autopilot.start", { draft: { ...oneOver, planSeed: 7 }, acceptedWorstMicros: 1_000_000_000 }));
    expect(oneOverStart.error).toMatchObject({ code: "VALIDATION", launchReason: "too-many-photos" });
    expect(ledgerLines(kit.root())).toEqual([]);
    const listed = ok(await kit.call(started, "autopilot.list", {}));
    if (listed.type !== "autopilot.list") throw new Error("wrong answer");
    expect(listed.result.launches).toEqual([]);

    const accepted = ok(await kit.call(started, "autopilot.start", { draft: { ...fits, planSeed: okEstimate.result.preview.planSeed }, acceptedWorstMicros: okEstimate.result.preview.estimate.worstMicros }));
    expect(accepted.type).toBe("autopilot.start");
  });
});

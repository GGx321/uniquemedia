import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import { VideoSummary, type EngineError } from "../../shared/engine";
import { NODE_COMMIT_FS } from "./commitFs";
import { commitIntent, writeIntent } from "./intents";
import { publishedPath } from "./published";
import { fakeVideoBytes, sampleRecord, useWorld, type World } from "./testing/kit";
import { serviceRig } from "./testing/serviceKit";
useNativeGlobals();

// S4.5c (plan §8.4): `videos.setPublished` and the marks in `videos.list`. The owner's mark is a log beside the write-once records, it survives a restart, and a log that cannot
// be read leaves the videos unmarked with `published: "unknown"` (the window's notice) while everything else about them is as it was.

const world = useWorld();
const A = "video-0000000a";
const B = "video-0000000b";

async function failureOf(work: Promise<unknown>): Promise<EngineError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof EngineFailure) return error.error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

/** A committed video: its file in the export folder and its record in the library, then the library re-read. */
async function committed(w: World, videoId: string, n: number): Promise<void> {
  const bytes = fakeVideoBytes(2048);
  const record = sampleRecord(w, { bytes, videoId, jobId: `job-${videoId.slice(6)}`, relPath: `Mia/2026-09-29_photo_00${n}.mp4`, photoIds: [w.photos[n - 1]?.id ?? ""] });
  const path = join(w.exportRoot, ...record.file.relPath.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
  await commitIntent(NODE_COMMIT_FS, w.libraryRoot, w.avatar.id, record.id);
  await w.library.reloadVideoRecords(w.avatar.id);
}

describe("videos.setPublished", () => {
  test("marks a video: the answer is its summary with the time of the mark, and the contract accepts it", async () => {
    const w = world();
    await committed(w, A, 1);
    const r = serviceRig(w);

    const video = await r.service.setPublished(A, true);

    expect(video).toMatchObject({ videoId: A, fileState: "present" });
    expect(typeof video.publishedAt).toBe("string");
    expect(VideoSummary.safeParse(video).success).toBe(true);
  });

  test("announces the change as video.changed with the marked summary", async () => {
    const w = world();
    await committed(w, A, 1);
    const r = serviceRig(w);

    const video = await r.service.setPublished(A, true);

    const changed = r.stamped().filter((event) => event.type === "video.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.type === "video.changed" && changed[0].payload.change === "upserted" ? changed[0].payload.video : null).toEqual(video);
  });

  test("clearing the mark leaves the summary with no publishedAt", async () => {
    const w = world();
    await committed(w, A, 1);
    const r = serviceRig(w);
    await r.service.setPublished(A, true);

    const video = await r.service.setPublished(A, false);

    expect(video.publishedAt ?? null).toBeNull();
    expect("publishedAt" in video).toBe(false);
  });

  test("marking a marked video again keeps its first time and announces nothing new", async () => {
    const w = world();
    await committed(w, A, 1);
    const r = serviceRig(w);
    const first = await r.service.setPublished(A, true);
    const eventsBefore = r.events.length;

    const second = await r.service.setPublished(A, true);

    expect(second.publishedAt).toBe(first.publishedAt);
    expect(r.events).toHaveLength(eventsBefore);
  });

  test("a video that does not exist is NOT_FOUND and nothing is written", async () => {
    const w = world();
    await committed(w, A, 1);
    const r = serviceRig(w);

    const error = await failureOf(r.service.setPublished("video-nobody-0404", true));

    expect(error.code).toBe("NOT_FOUND");
    await expect(readFile(publishedPath(w.libraryRoot, w.avatar.id), "utf8")).rejects.toBeDefined();
  });

  test("a log with a complete bad line refuses with INTERNAL naming no path, and is left as it was", async () => {
    const w = world();
    await committed(w, A, 1);
    const r = serviceRig(w);
    await writeFile(publishedPath(w.libraryRoot, w.avatar.id), "not json\n");

    const error = await failureOf(r.service.setPublished(A, true));

    expect(error.code).toBe("INTERNAL");
    expect(JSON.stringify(error)).not.toContain(w.libraryRoot);
    expect(await readFile(publishedPath(w.libraryRoot, w.avatar.id), "utf8")).toBe("not json\n");
  });
});

describe("videos.list and videos.get with the marks", () => {
  test("before anything is marked the list carries no marks field, as a producer without marks", async () => {
    const w = world();
    await committed(w, A, 1);
    const r = serviceRig(w);

    const listed = await r.service.listWithMarks(w.avatar.id);

    expect(listed.published).toBeUndefined();
    expect(listed.videos.map((video) => video.videoId)).toEqual([A]);
  });

  test("a marked video lists marked, the other not, and the marks are ok", async () => {
    const w = world();
    await committed(w, A, 1);
    await committed(w, B, 2);
    const r = serviceRig(w);
    await r.service.setPublished(A, true);

    const listed = await r.service.listWithMarks(w.avatar.id);

    expect(listed.published).toBe("ok");
    const byId = new Map(listed.videos.map((video) => [video.videoId, video]));
    expect(typeof byId.get(A)?.publishedAt).toBe("string");
    expect(byId.get(B) !== undefined && "publishedAt" in (byId.get(B) ?? {})).toBe(false);
  });

  test("a mark survives a restart: a service on a reopened library reads it from the log", async () => {
    const w = world();
    await committed(w, A, 1);
    const first = await serviceRig(w).service.setPublished(A, true);
    const reopened = await w.reopen();
    const restarted = serviceRig(w, { library: reopened });

    const listed = await restarted.service.listWithMarks(w.avatar.id);

    expect(listed.published).toBe("ok");
    expect(listed.videos[0]?.publishedAt).toBe(first.publishedAt);
  });

  test("videos.get shows the mark too", async () => {
    const w = world();
    await committed(w, A, 1);
    const rig = serviceRig(w);
    const marked = await rig.service.setPublished(A, true);

    expect((await rig.service.get(A)).publishedAt).toBe(marked.publishedAt);
  });

  test("a torn log makes the marks unknown: every video lists unmarked, and nothing else about the list changes", async () => {
    const w = world();
    await committed(w, A, 1);
    await committed(w, B, 2);
    const rig = serviceRig(w);
    await rig.service.setPublished(A, true);
    const marked = (await rig.service.listWithMarks(w.avatar.id)).videos;
    const log = publishedPath(w.libraryRoot, w.avatar.id);
    await writeFile(log, `${await readFile(log, "utf8")}{"videoId":"video-0000`);

    const listed = await rig.service.listWithMarks(w.avatar.id);

    expect(listed.published).toBe("unknown");
    expect(listed.videos.map(({ publishedAt: _publishedAt, ...rest }) => rest)).toEqual(marked.map(({ publishedAt: _publishedAt, ...rest }) => rest));
    for (const video of listed.videos) expect("publishedAt" in video).toBe(false);
    expect(rig.logs.some((line) => line.includes("published marks"))).toBe(true);
  });

  test("marking the same mark again over a torn log heals it, and the answer shows the mark", async () => {
    const w = world();
    await committed(w, A, 1);
    const rig = serviceRig(w);
    const first = await rig.service.setPublished(A, true);
    const log = publishedPath(w.libraryRoot, w.avatar.id);
    await writeFile(log, `${await readFile(log, "utf8")}{"videoId":"video-0000`);
    expect((await rig.service.listWithMarks(w.avatar.id)).published).toBe("unknown");

    const again = await rig.service.setPublished(A, true);

    expect(again.publishedAt).toBe(first.publishedAt);
    const listed = await rig.service.listWithMarks(w.avatar.id);
    expect(listed.published).toBe("ok");
    expect(listed.videos[0]?.publishedAt).toBe(first.publishedAt);
    expect(await readFile(`${log}.torn`, "utf8")).toContain('{"videoId":"video-0000');
  });

  test("a read of the marks that never answers ends at the list's budget as unknown, and the list still comes", async () => {
    const w = world();
    await committed(w, A, 1);
    const rig = serviceRig(w, { deps: { readMarks: () => new Promise<never>(() => undefined), listBudgetMs: 400 } });

    const listed = await rig.service.listWithMarks(w.avatar.id);

    expect(listed.published).toBe("unknown");
    expect(listed.videos.map((video) => video.videoId)).toEqual([A]);
  });

  test("a torn log is not repaired by listing it: the file is as it was", async () => {
    const w = world();
    await committed(w, A, 1);
    const rig = serviceRig(w);
    await rig.service.setPublished(A, true);
    const log = publishedPath(w.libraryRoot, w.avatar.id);
    const torn = `${await readFile(log, "utf8")}{"videoId":"video-0000`;
    await writeFile(log, torn);

    await rig.service.listWithMarks(w.avatar.id);

    expect(await readFile(log, "utf8")).toBe(torn);
  });

  test("the plain list keeps answering the videos only", async () => {
    const w = world();
    await committed(w, A, 1);
    const rig = serviceRig(w);

    const videos = await rig.service.list(w.avatar.id);

    expect(videos.map((video) => video.videoId)).toEqual([A]);
  });
});

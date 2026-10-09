import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { trackKey } from "../../shared/autopilot/track";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { SAMPLE_AVATAR } from "../library/testing/helpers";
import { commitIntent, writeIntent } from "../videos/intents";
import { NODE_COMMIT_FS } from "../videos/commitFs";
import { videoPaths, type VideoRecord } from "../videos/record";
import { sampleRecord, useWorld, type World } from "../videos/testing/kit";
import { trackUsage } from "./trackUsage";
useNativeGlobals();

// `trackUsage(avatarId)` (plan §7, S4.4): per avatar, how often each track was used, from the avatar's video records. The record keeps the
// RESOLVED spec, so `spec.music` names the track: `trackId` for a trending one, `mediaId` for an own one.

const world = useWorld();

type Music = { source: "trending"; trackId: string; startMs: number } | { source: "own"; mediaId: string; startMs: number } | null;

/** The nth record: ids and time by `n`, so that a higher `n` is a newer video. */
function recordWith(w: World, n: number, music: Music): VideoRecord {
  const id = `video-${String(n).padStart(8, "0")}`;
  const base = sampleRecord(w, { videoId: id, jobId: `job-${String(n).padStart(8, "0")}` });
  return { ...base, createdAt: `2026-10-08T10:${String(n).padStart(2, "0")}:00.000Z`, spec: { ...base.spec, music } };
}

async function commit(w: World, record: VideoRecord): Promise<void> {
  await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
  await commitIntent(NODE_COMMIT_FS, w.libraryRoot, record.avatarId, record.id);
}

const trending = (trackId: string): Music => ({ source: "trending", trackId, startMs: 1500 });
const ownTrack = (mediaId: string): Music => ({ source: "own", mediaId, startMs: 0 });

describe("trackUsage", () => {
  test("an avatar with no videos has no usage, and it is complete", async () => {
    const w = world();
    const usage = await trackUsage(w.libraryRoot, w.avatar.id);
    expect(usage.counts.size).toBe(0);
    expect(usage.recent).toEqual([]);
    expect(usage.complete).toBe(true);
  });

  test("counts how many videos used each trending track", async () => {
    const w = world();
    await commit(w, recordWith(w, 1, trending("track-aaaa-0001")));
    await commit(w, recordWith(w, 2, trending("track-aaaa-0001")));
    await commit(w, recordWith(w, 3, trending("track-bbbb-0002")));

    const usage = await trackUsage(w.libraryRoot, w.avatar.id);

    expect(usage.counts.get(trackKey("trending", "track-aaaa-0001"))).toBe(2);
    expect(usage.counts.get(trackKey("trending", "track-bbbb-0002"))).toBe(1);
    expect(usage.counts.size).toBe(2);
  });

  test("counts an own track by its media id, apart from a trending track with the same id", async () => {
    const w = world();
    await commit(w, recordWith(w, 1, ownTrack("same-id-0001")));
    await commit(w, recordWith(w, 2, trending("same-id-0001")));
    await commit(w, recordWith(w, 3, ownTrack("same-id-0001")));

    const usage = await trackUsage(w.libraryRoot, w.avatar.id);

    expect(usage.counts.get(trackKey("own", "same-id-0001"))).toBe(2);
    expect(usage.counts.get(trackKey("trending", "same-id-0001"))).toBe(1);
  });

  test("a silent video uses no track", async () => {
    const w = world();
    await commit(w, recordWith(w, 1, null));

    const usage = await trackUsage(w.libraryRoot, w.avatar.id);

    expect(usage.counts.size).toBe(0);
    expect(usage.complete).toBe(true);
  });

  test("a record from before music was kept in the spec uses no track and does not fail", async () => {
    const w = world();
    const old = recordWith(w, 1, null);
    const { music: _music, ...specWithoutMusic } = old.spec;
    await commit(w, { ...old, spec: specWithoutMusic });

    const usage = await trackUsage(w.libraryRoot, w.avatar.id);

    expect(usage.counts.size).toBe(0);
    expect(usage.complete).toBe(true);
  });

  test("recent lists the tracks of the newest videos first", async () => {
    const w = world();
    await commit(w, recordWith(w, 1, trending("track-aaaa-0001")));
    await commit(w, recordWith(w, 2, ownTrack("media-bbbb-0002")));
    await commit(w, recordWith(w, 3, trending("track-cccc-0003")));

    const usage = await trackUsage(w.libraryRoot, w.avatar.id);

    expect(usage.recent).toEqual([trackKey("trending", "track-cccc-0003"), trackKey("own", "media-bbbb-0002"), trackKey("trending", "track-aaaa-0001")]);
  });

  test("recent covers the last 5 videos only", async () => {
    const w = world();
    for (let n = 1; n <= 7; n++) await commit(w, recordWith(w, n, trending(`track-seq-000${n}`)));

    const usage = await trackUsage(w.libraryRoot, w.avatar.id);

    expect(usage.recent).toEqual([7, 6, 5, 4, 3].map((n) => trackKey("trending", `track-seq-000${n}`)));
    expect(usage.counts.size).toBe(7);
  });

  test("a silent video takes one of the 5 slots of recent without adding a key", async () => {
    const w = world();
    await commit(w, recordWith(w, 1, trending("track-aaaa-0001")));
    for (let n = 2; n <= 5; n++) await commit(w, recordWith(w, n, null));
    await commit(w, recordWith(w, 6, trending("track-bbbb-0002")));

    const usage = await trackUsage(w.libraryRoot, w.avatar.id);

    expect(usage.recent).toEqual([trackKey("trending", "track-bbbb-0002")]);
    expect(usage.counts.get(trackKey("trending", "track-aaaa-0001"))).toBe(1);
  });

  test("counts only this avatar's videos", async () => {
    const w = world();
    const other = await w.library.createAvatar({ ...SAMPLE_AVATAR, name: "Zoe" });
    await commit(w, recordWith(w, 1, trending("track-aaaa-0001")));
    const foreign = recordWith(w, 2, trending("track-aaaa-0001"));
    await commit(w, { ...foreign, avatarId: other.id });

    const usage = await trackUsage(w.libraryRoot, w.avatar.id);

    expect(usage.counts.get(trackKey("trending", "track-aaaa-0001"))).toBe(1);
  });

  test("a record that cannot be read makes the usage incomplete, and the rest is still counted", async () => {
    const w = world();
    await commit(w, recordWith(w, 1, trending("track-aaaa-0001")));
    writeFileSync(`${videoPaths(w.libraryRoot, w.avatar.id).videosDir}/video-0000000b.json`, "{ not json");

    const usage = await trackUsage(w.libraryRoot, w.avatar.id);

    expect(usage.complete).toBe(false);
    expect(usage.counts.get(trackKey("trending", "track-aaaa-0001"))).toBe(1);
  });

  test("a track id the contract would refuse is ignored rather than counted", async () => {
    const w = world();
    await commit(w, recordWith(w, 1, { source: "trending", trackId: "../x", startMs: 0 }));

    const usage = await trackUsage(w.libraryRoot, w.avatar.id);

    expect(usage.counts.size).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClipSummary, MAX_LISTED_CLIPS, type FileState } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { Ledger } from "../money/ledger";
import type { ExportRootRef } from "../videos/recovery";
import { clipAttemptId } from "./journal";
import type { ClipRecordsDeps } from "./records";
import { AVATAR, CLIP, createRecordsRig, exportLine, failedRecord, readyRecord, reserve, settle, type RecordsRig } from "./testing/recordsRig";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4a2 (plan s5b1 §5.2, §5.3, I5.49, I5.53): `clips.list`, `clips.get`, `clips.markSeen` and `clips.delete`. The list reads records only and builds each clip's cost from the ledger.
// A ready record may name a poster that is not on disk (the poster failed to render; V6 repaints, V8 shows a placeholder): that is not corruption.

const OTHER = "clip-0000002";
let rig: RecordsRig;

async function open(deps: Partial<ClipRecordsDeps> = {}): Promise<void> {
  rig = await createRecordsRig({ deps });
  await rig.ledgerWith([]);
}

afterEach(async () => {
  await rig.cleanup();
});

const refusal = (code: string, detail?: object) => ({ error: { code, ...detail } });

describe("clips.list", () => {
  beforeEach(() => open());

  test("answers an empty list for an avatar with no clips, with no notListedTotal", async () => {
    expect(await rig.records.list({ avatarId: AVATAR })).toEqual({ clips: [] });
  });

  test("lists the records newest first", async () => {
    await rig.put(readyRecord({ id: "clip-0000001", createdAt: "2026-10-13T09:00:00.000Z" }));
    await rig.put(readyRecord({ id: "clip-0000003", createdAt: "2026-10-13T11:00:00.000Z" }));
    await rig.put(readyRecord({ id: "clip-0000002", createdAt: "2026-10-13T10:00:00.000Z" }));
    const { clips } = await rig.records.list({ avatarId: AVATAR });
    expect(clips.map((c) => c.clipId)).toEqual(["clip-0000003", "clip-0000002", "clip-0000001"]);
  });

  test("answers summaries the contract accepts", async () => {
    await rig.put(readyRecord());
    await rig.put(failedRecord("download-failed", "2026-10-13T13:00:00.000Z", { id: OTHER }));
    const { clips } = await rig.records.list({ avatarId: AVATAR });
    for (const clip of clips) expect(ClipSummary.safeParse(clip).success).toBe(true);
  });

  test("builds the cost from the ledger: billed, worst-settled (estimated), open and free", async () => {
    const ids = ["clip-0000001", "clip-0000002", "clip-0000003", "clip-0000004"] as const;
    for (const id of ids) await rig.put(readyRecord({ id }));
    await rig.ledgerWith([
      reserve(clipAttemptId(ids[0], 1), ids[0], 504_000),
      settle(clipAttemptId(ids[0], 1), 420_000, false),
      reserve(clipAttemptId(ids[1], 1), ids[1], 504_000),
      settle(clipAttemptId(ids[1], 1), 504_000, true),
      reserve(clipAttemptId(ids[2], 1), ids[2], 504_000),
    ]);
    const { clips } = await rig.records.list({ avatarId: AVATAR });
    const costOf = (id: string) => clips.find((c) => c.clipId === id)?.cost;
    expect(costOf(ids[0])).toEqual({ micros: 420_000, kind: "billed" });
    expect(costOf(ids[1])).toEqual({ micros: 504_000, kind: "estimated" });
    expect(costOf(ids[2])).toEqual({ micros: 504_000, kind: "open" });
    expect(costOf(ids[3])).toEqual({ micros: 0, kind: "free" });
  });

  test("shows an open cost as estimated once the reconcile has closed the reserve", async () => {
    await rig.put(readyRecord());
    const lines = [reserve(clipAttemptId(CLIP, 1), CLIP, 504_000)];
    await rig.ledgerWith(lines);
    expect((await rig.records.list({ avatarId: AVATAR })).clips[0]?.cost.kind).toBe("open");
    await rig.ledgerWith([...lines, settle(clipAttemptId(CLIP, 1), 504_000, true)]);
    expect((await rig.records.list({ avatarId: AVATAR })).clips[0]?.cost).toEqual({ micros: 504_000, kind: "estimated" });
  });

  test("does not read a cost from the record", async () => {
    await rig.put(readyRecord());
    const { clips } = await rig.records.list({ avatarId: AVATAR });
    expect(clips[0]?.cost).toEqual({ micros: 0, kind: "free" });
    expect(clips[0]?.providerCostMicros).toBe(420_000);
  });

  test("refuses with LEDGER_UNREADABLE when the ledger cannot be read, instead of showing costs it does not know", async () => {
    await rig.put(readyRecord());
    rig.state.ledger = null;
    await expect(rig.records.list({ avatarId: AVATAR })).rejects.toMatchObject(refusal("LEDGER_UNREADABLE"));
  });

  test("reads the ledger once for the whole list, however many clips it holds", async () => {
    await rig.cleanup();
    let asked = 0;
    let reads = 0;
    let counting: Pick<Ledger, "lines" | "closeOf"> | null = null;
    await open({
      ledger: () => {
        asked++;
        return counting;
      },
    });
    const ids = ["clip-0000001", "clip-0000002", "clip-0000003"];
    for (const id of ids) await rig.put(readyRecord({ id }));
    await rig.ledgerWith(ids.flatMap((id) => [reserve(clipAttemptId(id, 1), id, 504_000), settle(clipAttemptId(id, 1), 420_000, false)]));
    const real = rig.state.ledger;
    if (real === null) throw new Error("no ledger");
    counting = {
      get lines() {
        reads++;
        return real.lines;
      },
      closeOf: (attemptId) => real.closeOf(attemptId),
    };
    const { clips } = await rig.records.list({ avatarId: AVATAR });
    expect(clips.map((c) => c.cost)).toEqual(ids.map(() => ({ micros: 420_000, kind: "billed" })));
    expect({ asked, reads }).toEqual({ asked: 1, reads: 1 });
  });

  test("puts the Grok offers it is handed on the clips they name, and asks for them with the listed records", async () => {
    await rig.put(failedRecord("refused-free", undefined));
    await rig.put(failedRecord("refused-free", undefined, { id: OTHER }));
    const offer = { expectedMicros: 710_000, worstMicros: 850_000, prices: "live" as const, pricesAsOf: "2026-10-13" };
    const asked: string[][] = [];
    const { clips } = await rig.records.list(
      { avatarId: AVATAR },
      {
        grokOffers: async (records) => {
          asked.push(records.map((r) => r.id).sort());
          return new Map([[CLIP, offer]]);
        },
      },
    );
    expect(asked).toEqual([[CLIP, OTHER]]);
    const failureOf = (id: string) => {
      const clip = clips.find((c) => c.clipId === id);
      return clip?.status === "failed" ? clip.failure : null;
    };
    expect(failureOf(CLIP)).toEqual({ reason: "refused-free", grokOffer: offer });
    expect(failureOf(OTHER)).toEqual({ reason: "refused-free" });
    for (const clip of clips) expect(ClipSummary.safeParse(clip).success).toBe(true);
  });

  test("puts the Grok offer it is handed on the one clip get returns, asking for it with that record alone", async () => {
    await rig.put(failedRecord("refused-free", undefined));
    const offer = { expectedMicros: 710_000, worstMicros: 850_000, prices: "live" as const, pricesAsOf: "2026-10-13" };
    const asked: string[][] = [];
    const { clip } = await rig.records.get(
      { avatarId: AVATAR, clipId: CLIP },
      {
        grokOffers: async (records) => {
          asked.push(records.map((r) => r.id));
          return new Map([[CLIP, offer]]);
        },
      },
    );
    expect(asked).toEqual([[CLIP]]);
    expect(clip.status === "failed" ? clip.failure : null).toEqual({ reason: "refused-free", grokOffer: offer });
  });

  test("lists a ready clip whose poster file is absent as an ordinary ready clip, with nothing logged", async () => {
    await rig.put(readyRecord());
    await writeFile(rig.file(`${CLIP}.mp4`), "x");
    const { clips } = await rig.records.list({ avatarId: AVATAR });
    expect(clips.map((c) => [c.clipId, c.status])).toEqual([[CLIP, "ready"]]);
    expect(rig.logs).toEqual([]);
  });

  test("lists a failed clip that left an mp4 behind (a download-failed record after a flush failure)", async () => {
    await rig.put(failedRecord("download-failed", "2026-10-13T13:00:00.000Z"));
    await writeFile(rig.file(`${CLIP}.mp4`), "x");
    expect((await rig.records.list({ avatarId: AVATAR })).clips.map((c) => c.status)).toEqual(["failed"]);
  });

  test("ignores journals, media files and temp files, which are not records", async () => {
    await rig.put(readyRecord());
    for (const name of [`${OTHER}.journal.jsonl`, `${OTHER}.mp4`, `${OTHER}.poster.jpg`, ".clip-0000002.abcdef123456.tmp", "notes.txt"]) await writeFile(rig.file(name), "x");
    await mkdir(rig.file(".frames-abc.tmp"));
    expect((await rig.records.list({ avatarId: AVATAR })).clips.map((c) => c.clipId)).toEqual([CLIP]);
  });

  test("leaves a record that is not valid out and lists the others, saying so in the log", async () => {
    await rig.put(readyRecord());
    await writeFile(rig.file(`${OTHER}.json`), "{ not json");
    await writeFile(rig.file("clip-0000003.json"), JSON.stringify({ schemaVersion: 1, id: "clip-0000003" }));
    const { clips } = await rig.records.list({ avatarId: AVATAR });
    expect(clips.map((c) => c.clipId)).toEqual([CLIP]);
    expect(rig.logs.length).toBe(2);
  });

  test("leaves a record whose file name and id disagree out of the list", async () => {
    await writeFile(rig.file(`${OTHER}.json`), JSON.stringify(readyRecord({ id: CLIP })));
    expect((await rig.records.list({ avatarId: AVATAR })).clips).toEqual([]);
  });

  test("removes a stale journal that lies beside a record", async () => {
    await rig.put(readyRecord());
    await writeFile(rig.file(`${CLIP}.journal.jsonl`), "");
    await rig.records.list({ avatarId: AVATAR });
    expect(await rig.names()).toEqual([`${CLIP}.json`]);
  });

  test("keeps a journal beside a record while a job works on that clip, and a journal with no record", async () => {
    await rig.put(readyRecord());
    await writeFile(rig.file(`${CLIP}.journal.jsonl`), "");
    await writeFile(rig.file(`${OTHER}.journal.jsonl`), "");
    rig.state.busy.add(CLIP);
    await rig.records.list({ avatarId: AVATAR });
    expect(await rig.names()).toEqual([`${CLIP}.journal.jsonl`, `${CLIP}.json`, `${OTHER}.journal.jsonl`]);
  });

  test("does not look at the exports' files (fileState is for clips.get)", async () => {
    await rig.put(readyRecord({ exports: [exportLine(1)] }));
    const { clips } = await rig.records.list({ avatarId: AVATAR });
    expect(clips[0]?.exports).toEqual([exportLine(1)]);
  });

  test("lists at most MAX_LISTED_CLIPS, the newest, and counts the rest in notListedTotal", async () => {
    const total = MAX_LISTED_CLIPS + 3;
    await Promise.all(
      Array.from({ length: total }, async (_, i) => {
        const id = `clip-${String(i + 1).padStart(7, "0")}`;
        const path = rig.file(`${id}.json`);
        await writeFile(path, JSON.stringify(readyRecord({ id, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() })));
        const at = new Date(Date.UTC(2026, 9, 1, 0, 0, i));
        await utimes(path, at, at);
      }),
    );
    const { clips, notListedTotal } = await rig.records.list({ avatarId: AVATAR });
    expect(clips.length).toBe(MAX_LISTED_CLIPS);
    expect(notListedTotal).toBe(3);
    expect(clips[0]?.clipId).toBe(`clip-${String(total).padStart(7, "0")}`);
    expect(clips.some((c) => c.clipId === "clip-0000001")).toBe(false);
  });

  test("refuses with LIBRARY_UNAVAILABLE when no library is open", async () => {
    rig.state.open = false;
    await expect(rig.records.list({ avatarId: AVATAR })).rejects.toMatchObject(refusal("LIBRARY_UNAVAILABLE"));
  });

  test("refuses with NOT_FOUND for an avatar that is not in the library, or is being deleted", async () => {
    await expect(rig.records.list({ avatarId: "avatar-zzzz-0009" })).rejects.toMatchObject(refusal("NOT_FOUND"));
    rig.state.pendingDelete.add(AVATAR);
    await expect(rig.records.list({ avatarId: AVATAR })).rejects.toMatchObject(refusal("NOT_FOUND"));
  });
});

describe("clips.get", () => {
  const root: ExportRootRef = { root: "/exports", rootId: "root-0000001", caseInsensitive: true };
  const asked: { id: string; rootId: string; relPath: string; bytes: number; sha256: string; root: ExportRootRef | null; verify: string }[] = [];
  let states: Record<string, FileState> = {};
  let thrown: Error | null = null;

  const fileStates: NonNullable<ClipRecordsDeps["fileStates"]> = {
    check: async (record, rootRef, options) => {
      asked.push({ id: record.id, rootId: record.file.rootId, relPath: record.file.relPath, bytes: record.file.bytes, sha256: record.file.sha256, root: rootRef, verify: options.verify });
      if (thrown !== null) throw thrown;
      if (rootRef === null) return "elsewhere";
      return states[record.file.relPath] ?? "present";
    },
  };

  beforeEach(async () => {
    asked.length = 0;
    states = {};
    thrown = null;
    await open({ fileStates });
    rig.state.root = root;
  });

  test("answers the clip as a summary with its cost from the ledger", async () => {
    await rig.put(readyRecord());
    await rig.ledgerWith([reserve(clipAttemptId(CLIP, 1), CLIP, 504_000), settle(clipAttemptId(CLIP, 1), 420_000, false)]);
    const { clip } = await rig.records.get({ avatarId: AVATAR, clipId: CLIP });
    expect(ClipSummary.safeParse(clip).success).toBe(true);
    expect(clip.cost).toEqual({ micros: 420_000, kind: "billed" });
  });

  test("gives each export the state of its file in the current export folder", async () => {
    await rig.put(readyRecord({ exports: [exportLine(1), exportLine(2), exportLine(3)] }));
    states = { [exportLine(2).relPath]: "missing", [exportLine(3).relPath]: "changed" };
    const { clip } = await rig.records.get({ avatarId: AVATAR, clipId: CLIP });
    expect(clip.exports.map((e) => e.fileState)).toEqual(["present", "missing", "changed"]);
  });

  test("asks the shared checker about the record's root, relative path, size and hash, with the cheap verification", async () => {
    await rig.put(readyRecord({ exports: [exportLine(1)] }));
    await rig.records.get({ avatarId: AVATAR, clipId: CLIP });
    expect(asked).toEqual([{ id: `${CLIP}-export-1`, rootId: "root-0000001", relPath: exportLine(1).relPath, bytes: 2_000, sha256: "b".repeat(64), root, verify: "cheap" }]);
  });

  test("says elsewhere for every export when there is no usable export folder", async () => {
    await rig.put(readyRecord({ exports: [exportLine(1)] }));
    rig.state.root = null;
    const { clip } = await rig.records.get({ avatarId: AVATAR, clipId: CLIP });
    expect(clip.exports.map((e) => e.fileState)).toEqual(["elsewhere"]);
    expect(asked.map((a) => a.root)).toEqual([null]);
  });

  test("says unchecked when the export folder did not answer, and when a file cannot be judged", async () => {
    await rig.put(readyRecord({ exports: [exportLine(1)] }));
    rig.state.root = "unanswered";
    expect((await rig.records.get({ avatarId: AVATAR, clipId: CLIP })).clip.exports.map((e) => e.fileState)).toEqual(["unchecked"]);
    rig.state.root = root;
    thrown = Object.assign(new Error("EIO"), { code: "EIO" });
    expect((await rig.records.get({ avatarId: AVATAR, clipId: CLIP })).clip.exports.map((e) => e.fileState)).toEqual(["unchecked"]);
  });

  test("does not ask for the export folder when the clip has no exports", async () => {
    let asks = 0;
    await open({ fileStates, exportRoot: async () => (asks++, root) });
    await rig.put(readyRecord());
    await rig.records.get({ avatarId: AVATAR, clipId: CLIP });
    expect(asks).toBe(0);
  });

  test("answers a ready clip whose poster is absent as ready", async () => {
    await rig.put(readyRecord());
    expect((await rig.records.get({ avatarId: AVATAR, clipId: CLIP })).clip.status).toBe("ready");
  });

  test("refuses with NOT_FOUND for a clip with no record, including one whose job still runs", async () => {
    rig.state.busy.add("clip-0000009");
    await expect(rig.records.get({ avatarId: AVATAR, clipId: CLIP })).rejects.toMatchObject(refusal("NOT_FOUND"));
    await expect(rig.records.get({ avatarId: AVATAR, clipId: "clip-0000009" })).rejects.toMatchObject(refusal("NOT_FOUND"));
  });

  test("refuses with NOT_FOUND for a record that does not read", async () => {
    await writeFile(rig.file(`${CLIP}.json`), "{ not json");
    await expect(rig.records.get({ avatarId: AVATAR, clipId: CLIP })).rejects.toMatchObject(refusal("NOT_FOUND"));
  });

  test("refuses with LIBRARY_UNAVAILABLE and NOT_FOUND like the list", async () => {
    await rig.put(readyRecord());
    await expect(rig.records.get({ avatarId: "avatar-zzzz-0009", clipId: CLIP })).rejects.toMatchObject(refusal("NOT_FOUND"));
    rig.state.open = false;
    await expect(rig.records.get({ avatarId: AVATAR, clipId: CLIP })).rejects.toMatchObject(refusal("LIBRARY_UNAVAILABLE"));
  });
});

describe("clips.markSeen", () => {
  beforeEach(() => open());

  test("sets the seen flag and changes nothing else in the record", async () => {
    const record = readyRecord();
    await rig.put(record);
    expect(await rig.records.markSeen({ avatarId: AVATAR, clipId: CLIP })).toEqual({ clipId: CLIP });
    expect(JSON.parse(await readFile(rig.file(`${CLIP}.json`), "utf8"))).toEqual({ ...record, seen: true });
  });

  test("leaves no temp file behind", async () => {
    await rig.put(readyRecord());
    await rig.records.markSeen({ avatarId: AVATAR, clipId: CLIP });
    expect(await rig.names()).toEqual([`${CLIP}.json`]);
  });

  test("works for a failed clip, and keeps its retry window", async () => {
    const until = "2026-10-13T13:00:00.000Z";
    await rig.put(failedRecord("download-failed", until));
    await rig.records.markSeen({ avatarId: AVATAR, clipId: CLIP });
    const { clip } = await rig.records.get({ avatarId: AVATAR, clipId: CLIP });
    expect(clip).toMatchObject({ seen: true, status: "failed", retryDownloadUntil: until });
  });

  test("does not write again for a clip that is already seen", async () => {
    await rig.put(readyRecord({ seen: true }));
    const old = new Date("2026-01-01T00:00:00.000Z");
    await utimes(rig.file(`${CLIP}.json`), old, old);
    await rig.records.markSeen({ avatarId: AVATAR, clipId: CLIP });
    expect((await stat(rig.file(`${CLIP}.json`))).mtime.getTime()).toBe(old.getTime());
  });

  test("keeps every export when two calls race", async () => {
    await rig.put(readyRecord({ exports: [exportLine(1)] }));
    await Promise.all([rig.records.markSeen({ avatarId: AVATAR, clipId: CLIP }), rig.records.markSeen({ avatarId: AVATAR, clipId: CLIP })]);
    const { clip } = await rig.records.get({ avatarId: AVATAR, clipId: CLIP });
    expect(clip).toMatchObject({ seen: true });
    expect(clip.exports.length).toBe(1);
  });

  test("refuses with NOT_FOUND for a missing clip, and for an avatar that is not there", async () => {
    await expect(rig.records.markSeen({ avatarId: AVATAR, clipId: CLIP })).rejects.toMatchObject(refusal("NOT_FOUND"));
    await expect(rig.records.markSeen({ avatarId: "avatar-zzzz-0009", clipId: CLIP })).rejects.toMatchObject(refusal("NOT_FOUND"));
  });

  test("leaves a record that does not read as it is", async () => {
    await writeFile(rig.file(`${CLIP}.json`), "{ not json");
    await expect(rig.records.markSeen({ avatarId: AVATAR, clipId: CLIP })).rejects.toMatchObject(refusal("NOT_FOUND"));
    expect(await readFile(rig.file(`${CLIP}.json`), "utf8")).toBe("{ not json");
  });
});

describe("clips.delete", () => {
  beforeEach(() => open());

  const files = (id: string): string[] => [`${id}.json`, `${id}.mp4`, `${id}.poster.jpg`];
  async function lay(id: string): Promise<void> {
    await rig.put(readyRecord({ id }));
    await writeFile(rig.file(`${id}.mp4`), "mp4");
    await writeFile(rig.file(`${id}.poster.jpg`), "jpg");
  }

  test("removes the record, the mp4 and the poster", async () => {
    await lay(CLIP);
    expect(await rig.records.delete({ avatarId: AVATAR, clipId: CLIP })).toEqual({ clipId: CLIP });
    expect(await rig.names()).toEqual([]);
  });

  test("removes the mp4 a FAILED record left next to it, and a stale journal", async () => {
    await rig.put(failedRecord("download-failed", "2026-10-13T13:00:00.000Z"));
    await writeFile(rig.file(`${CLIP}.mp4`), "leftover");
    await writeFile(rig.file(`${CLIP}.journal.jsonl`), "");
    await rig.records.delete({ avatarId: AVATAR, clipId: CLIP });
    expect(await rig.names()).toEqual([]);
  });

  test("deletes a ready clip whose poster is absent", async () => {
    await rig.put(readyRecord());
    await writeFile(rig.file(`${CLIP}.mp4`), "mp4");
    await rig.records.delete({ avatarId: AVATAR, clipId: CLIP });
    expect(await rig.names()).toEqual([]);
  });

  test("touches no other clip's files", async () => {
    await lay(CLIP);
    await lay(OTHER);
    await rig.records.delete({ avatarId: AVATAR, clipId: CLIP });
    expect(await rig.names()).toEqual(files(OTHER).sort());
  });

  test("never touches an exported copy", async () => {
    const exported = join(rig.dir, "exports", "Nini", "2026-10-13_clip_001.mp4");
    await mkdir(join(rig.dir, "exports", "Nini"), { recursive: true });
    await writeFile(exported, "exported");
    await rig.put(readyRecord({ exports: [exportLine(1)] }));
    await rig.records.delete({ avatarId: AVATAR, clipId: CLIP });
    expect(await readFile(exported, "utf8")).toBe("exported");
    expect(await rig.names()).toEqual([]);
  });

  test("removes the record first: a file that cannot be removed leaves the clip deleted, the other file gone, and one line in the log", async () => {
    await rig.put(readyRecord());
    await mkdir(rig.file(`${CLIP}.mp4`));
    await writeFile(rig.file(`${CLIP}.poster.jpg`), "jpg");
    await writeFile(join(rig.file(`${CLIP}.mp4`), "inner"), "x");
    expect(await rig.records.delete({ avatarId: AVATAR, clipId: CLIP })).toEqual({ clipId: CLIP });
    expect(await rig.names()).toEqual([`${CLIP}.mp4`]);
    expect(rig.logs.length).toBe(1);
    await expect(rig.records.get({ avatarId: AVATAR, clipId: CLIP })).rejects.toMatchObject(refusal("NOT_FOUND"));
  });

  test("refuses with IN_FLIGHT job-running while a job works on the clip, and deletes nothing", async () => {
    await lay(CLIP);
    rig.state.busy.add(CLIP);
    await expect(rig.records.delete({ avatarId: AVATAR, clipId: CLIP })).rejects.toMatchObject({ error: { code: "IN_FLIGHT", clipReason: "job-running" } });
    expect(await rig.names()).toEqual(files(CLIP).sort());
  });

  test("refuses with IN_FLIGHT job-running for a clip whose create still runs and has no record yet", async () => {
    rig.state.busy.add(CLIP);
    await writeFile(rig.file(`${CLIP}.journal.jsonl`), "");
    await expect(rig.records.delete({ avatarId: AVATAR, clipId: CLIP })).rejects.toMatchObject({ error: { code: "IN_FLIGHT", clipReason: "job-running" } });
    expect(await rig.names()).toEqual([`${CLIP}.journal.jsonl`]);
  });

  test("refuses with NOT_FOUND for a clip with no record, and removes no file it finds by that name", async () => {
    await writeFile(rig.file(`${CLIP}.mp4`), "orphan");
    await expect(rig.records.delete({ avatarId: AVATAR, clipId: CLIP })).rejects.toMatchObject(refusal("NOT_FOUND"));
    expect(await rig.names()).toEqual([`${CLIP}.mp4`]);
  });

  test("refuses with NOT_FOUND for an avatar that is not there, and LIBRARY_UNAVAILABLE with no library", async () => {
    await expect(rig.records.delete({ avatarId: "avatar-zzzz-0009", clipId: CLIP })).rejects.toMatchObject(refusal("NOT_FOUND"));
    rig.state.open = false;
    await expect(rig.records.delete({ avatarId: AVATAR, clipId: CLIP })).rejects.toMatchObject(refusal("LIBRARY_UNAVAILABLE"));
  });
});

describe("clips.delete: the order that lets nothing come back", () => {
  // A stale journal beside a record is a normal state. A journal with NO record is recovered by the restart as a running clip, so the journal must go first, and the record after it.
  const failing = (suffix: string): Partial<ClipRecordsDeps> => ({
    remove: async (path) => {
      if (path.endsWith(suffix)) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      await rm(path, { force: true });
    },
  });
  async function lay(): Promise<void> {
    await rig.put(readyRecord());
    await writeFile(rig.file(`${CLIP}.mp4`), "mp4");
    await writeFile(rig.file(`${CLIP}.poster.jpg`), "jpg");
    await writeFile(rig.file(`${CLIP}.journal.jsonl`), "");
  }

  test("a record that cannot be removed leaves the media and the clip whole, and no orphan journal", async () => {
    await open(failing(`${CLIP}.json`));
    await lay();
    await expect(rig.records.delete({ avatarId: AVATAR, clipId: CLIP })).rejects.toThrow("EPERM");
    expect(await rig.names()).toContain(`${CLIP}.mp4`);
    expect(await rig.names()).toContain(`${CLIP}.poster.jpg`);
    expect(await rig.names()).toContain(`${CLIP}.json`);
    expect(await rig.names()).not.toContain(`${CLIP}.journal.jsonl`);
    expect((await rig.records.get({ avatarId: AVATAR, clipId: CLIP })).clip.status).toBe("ready");
  });

  test("a journal that cannot be removed fails the delete with the record still in place, so nothing is resurrected", async () => {
    await open(failing(".journal.jsonl"));
    await lay();
    await expect(rig.records.delete({ avatarId: AVATAR, clipId: CLIP })).rejects.toThrow("EPERM");
    expect(await rig.names()).toEqual([`${CLIP}.journal.jsonl`, `${CLIP}.json`, `${CLIP}.mp4`, `${CLIP}.poster.jpg`].sort());
  });

  test("removes the journal, then the record, then the media", async () => {
    const order: string[] = [];
    await open({
      remove: async (path) => {
        order.push(path.slice(path.lastIndexOf(CLIP) + CLIP.length));
        await rm(path, { force: true });
      },
    });
    await lay();
    await rig.records.delete({ avatarId: AVATAR, clipId: CLIP });
    expect(order).toEqual([".journal.jsonl", ".json", ".mp4", ".poster.jpg"]);
  });
});

describe("ClipRecords.rewrite (the one gate of I5.53)", () => {
  beforeEach(() => open());

  test("throws and writes nothing when the new record is not one of the four rewrites", async () => {
    await rig.put(readyRecord());
    const before = await readFile(rig.file(`${CLIP}.json`), "utf8");
    await expect(rig.records.rewrite(AVATAR, CLIP, (current) => ({ ...current, motion: { source: "code", label: "x", text: "she smiles" } }))).rejects.toThrow("I5.53");
    expect(await readFile(rig.file(`${CLIP}.json`), "utf8")).toBe(before);
  });

  test("hands the builder the record as it is on disk now, so an export appended meanwhile is never lost to a seen flag", async () => {
    await rig.put(readyRecord());
    const append = rig.records.rewrite(AVATAR, CLIP, (current) => ({ ...current, exports: [...current.exports, exportLine(1)] }));
    const seen = rig.records.markSeen({ avatarId: AVATAR, clipId: CLIP });
    await Promise.all([append, seen]);
    const { clip } = await rig.records.get({ avatarId: AVATAR, clipId: CLIP });
    expect(clip.seen).toBe(true);
    expect(clip.exports.map((e) => e.relPath)).toEqual([exportLine(1).relPath]);
  });

  test("answers null and writes nothing when the builder has nothing to do", async () => {
    await rig.put(readyRecord());
    expect(await rig.records.rewrite(AVATAR, CLIP, () => null)).toBeNull();
  });

  test("keeps the next decision going after one that threw", async () => {
    await rig.put(readyRecord());
    await expect(rig.records.rewrite(AVATAR, CLIP, () => readyRecord({ id: "clip-0000009" }))).rejects.toThrow();
    expect(await rig.records.markSeen({ avatarId: AVATAR, clipId: CLIP })).toEqual({ clipId: CLIP });
  });
});

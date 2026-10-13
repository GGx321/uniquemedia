import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FREE_MARGIN_BYTES } from "../freeBytes";
import type { VideoDownloadResult } from "../openrouter/types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { CLIP_DOWNLOAD_CAP_BYTES, downloadClip, type DownloadClipOptions } from "./download";
import { useClipFixtures } from "./testing/clipFixtures";
useNativeGlobals();

// I5.54 and §5.10: the clip streams to a temp file in the clips folder (capped at 100 MiB, after a free-space check), is validated, and lands as `<clipId>.mp4` — the provider's bytes,
// unmodified. Every failure after a `completed` is paid, so each one says which of the four paid failures it is.

const clip = useClipFixtures();
const CLIP_ID = "clip-00000001";
const JOB_ID = "gen-abc123";

let clipsDir = "";
beforeEach(async () => {
  clipsDir = await mkdtemp(join(tmpdir(), "studio-download-"));
});
afterEach(async () => {
  await rm(clipsDir, { recursive: true, force: true });
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

interface Call {
  id: string;
  toPath: string;
  capBytes: number;
}

/** A client that plays `answer` for a download; `answer` may write the file the way the real one does. */
function fakeClient(answer: (toPath: string) => Promise<VideoDownloadResult>): { client: DownloadClipOptions["client"]; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      downloadVideo: async (id, toPath, capBytes) => {
        calls.push({ id, toPath, capBytes });
        return answer(toPath);
      },
    },
  };
}

/** A client whose download is the file at `source`, copied byte for byte. */
function serving(source: string): ReturnType<typeof fakeClient> {
  return fakeClient(async (toPath) => {
    await copyFile(source, toPath);
    return { kind: "saved", bytes: (await readFile(source)).byteLength };
  });
}

function options(client: DownloadClipOptions["client"], more: Partial<DownloadClipOptions> = {}): DownloadClipOptions {
  return { client, providerJobId: JOB_ID, clipId: CLIP_ID, clipsDir, requestedSeconds: 5, signal: new AbortController().signal, freeBytes: async () => 10 * CLIP_DOWNLOAD_CAP_BYTES, ...more };
}

describe("downloadClip", () => {
  test("stores a valid clip as <clipId>.mp4 and reports its sha256 and real size", async () => {
    const source = await clip({ width: 720, height: 1280, seconds: 5 });
    const { client } = serving(source);
    const result = await downloadClip(options(client));
    if (result.kind !== "saved") throw new Error(`expected saved, got ${result.reason}: ${result.detail}`);
    expect(result.path).toBe(join(clipsDir, `${CLIP_ID}.mp4`));
    expect(result.sha256).toBe(sha256(await readFile(source)));
    expect([result.clip.width, result.clip.height]).toEqual([720, 1280]);
    expect(result.clip.bytes).toBe((await readFile(source)).byteLength);
  });

  test("keeps the provider's bytes unmodified when the file carries a stray audio track", async () => {
    const source = await clip({ width: 720, height: 1280, seconds: 5, audio: true });
    const { client } = serving(source);
    const result = await downloadClip(options(client));
    if (result.kind !== "saved") throw new Error(`expected saved, got ${result.reason}: ${result.detail}`);
    expect(result.clip.hasAudio).toBe(true);
    const stored = await readFile(result.path);
    expect(sha256(stored)).toBe(sha256(await readFile(source)));
    expect(stored.equals(await readFile(source))).toBe(true);
  });

  test("accepts a 720p file that came back for a pro request and reports 720 x 1280", async () => {
    const { client } = serving(await clip({ width: 720, height: 1280, seconds: 10 }));
    const result = await downloadClip(options(client, { requestedSeconds: 10 }));
    if (result.kind !== "saved") throw new Error(`expected saved, got ${result.reason}`);
    expect(result.clip.height).toBe(1280);
  });

  test("asks the client for the provider's job id, into a temp file in the clips folder, under the 100 MiB cap", async () => {
    const { client, calls } = serving(await clip({ width: 720, height: 1280, seconds: 5 }));
    await downloadClip(options(client));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe(JOB_ID);
    expect(calls[0]?.capBytes).toBe(100 * 1024 * 1024);
    expect(calls[0]?.toPath.startsWith(`${clipsDir}/.${CLIP_ID}.`)).toBe(true);
    expect(calls[0]?.toPath.endsWith(".tmp")).toBe(true);
  });

  test("leaves only <clipId>.mp4 in the clips folder after a good download", async () => {
    const { client } = serving(await clip({ width: 720, height: 1280, seconds: 5 }));
    await downloadClip(options(client));
    expect(await readdir(clipsDir)).toEqual([`${CLIP_ID}.mp4`]);
  });

  test("answers disk-full before any byte when the volume has less than the cap plus the margin", async () => {
    const { client, calls } = fakeClient(async () => ({ kind: "failed", cause: "network", httpStatus: null, detail: "" }));
    const result = await downloadClip(options(client, { freeBytes: async () => CLIP_DOWNLOAD_CAP_BYTES + FREE_MARGIN_BYTES - 1 }));
    expect(result).toMatchObject({ kind: "failed", reason: "disk-full" });
    expect(calls).toHaveLength(0);
  });

  test("goes ahead when the volume has exactly the cap plus the margin", async () => {
    const { client, calls } = serving(await clip({ width: 720, height: 1280, seconds: 5 }));
    const result = await downloadClip(options(client, { freeBytes: async () => CLIP_DOWNLOAD_CAP_BYTES + FREE_MARGIN_BYTES }));
    expect(result.kind).toBe("saved");
    expect(calls).toHaveLength(1);
  });

  test("goes ahead when the volume does not say how much it has free", async () => {
    const { client } = serving(await clip({ width: 720, height: 1280, seconds: 5 }));
    expect((await downloadClip(options(client, { freeBytes: async () => null }))).kind).toBe("saved");
  });

  test("answers disk-full when the disk fills mid-write, and leaves no file behind", async () => {
    const { client } = fakeClient(async (toPath) => {
      await writeFile(toPath, "half a clip");
      return { kind: "failed", cause: "disk", httpStatus: null, detail: "ENOSPC" };
    });
    const result = await downloadClip(options(client));
    expect(result).toMatchObject({ kind: "failed", reason: "disk-full" });
    expect(await readdir(clipsDir)).toEqual([]);
  });

  test("answers download-expired when the provider says the file is gone", async () => {
    const { client } = fakeClient(async () => ({ kind: "gone", httpStatus: 404 }));
    expect(await downloadClip(options(client))).toMatchObject({ kind: "failed", reason: "download-expired" });
  });

  test("answers download-failed on a network failure, and leaves no file behind", async () => {
    const { client } = fakeClient(async () => ({ kind: "failed", cause: "network", httpStatus: null, detail: "reset" }));
    expect(await downloadClip(options(client))).toMatchObject({ kind: "failed", reason: "download-failed" });
    expect(await readdir(clipsDir)).toEqual([]);
  });

  test("answers download-failed and never removes a file that was already there when the client says `exists`", async () => {
    let theirs = "";
    const { client } = fakeClient(async (toPath) => {
      theirs = toPath;
      await writeFile(toPath, "not ours");
      return { kind: "failed", cause: "exists", httpStatus: null, detail: "the target exists" };
    });
    expect(await downloadClip(options(client))).toMatchObject({ kind: "failed", reason: "download-failed" });
    expect((await readFile(theirs)).toString()).toBe("not ours");
  });

  test("answers download-failed when the client refuses a redirect", async () => {
    const { client } = fakeClient(async () => ({ kind: "redirect-refused", httpStatus: 302, host: "elsewhere.example" }));
    expect(await downloadClip(options(client))).toMatchObject({ kind: "failed", reason: "download-failed" });
  });

  test("answers invalid-file when the body is over the cap", async () => {
    const { client } = fakeClient(async () => ({ kind: "too-large", capBytes: CLIP_DOWNLOAD_CAP_BYTES }));
    expect(await downloadClip(options(client))).toMatchObject({ kind: "failed", reason: "invalid-file" });
  });

  test("answers invalid-file for a 16:9 file, removes the temp file and stores nothing", async () => {
    const { client } = serving(await clip({ width: 1280, height: 720, seconds: 5 }));
    const result = await downloadClip(options(client));
    expect(result).toMatchObject({ kind: "failed", reason: "invalid-file" });
    expect(await readdir(clipsDir)).toEqual([]);
  });

  test("answers invalid-file for a body that is not an MP4", async () => {
    const { client } = fakeClient(async (toPath) => {
      await writeFile(toPath, "<html>nope</html>");
      return { kind: "saved", bytes: 17 };
    });
    expect(await downloadClip(options(client))).toMatchObject({ kind: "failed", reason: "invalid-file" });
    expect(await readdir(clipsDir)).toEqual([]);
  });

  test("answers invalid-file when the file is not the length asked", async () => {
    const { client } = serving(await clip({ width: 720, height: 1280, seconds: 4 }));
    expect(await downloadClip(options(client, { requestedSeconds: 5 }))).toMatchObject({ kind: "failed", reason: "invalid-file" });
  });
});

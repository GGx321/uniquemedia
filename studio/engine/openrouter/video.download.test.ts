import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeClient, LOCAL_BASE, TEST_KEY } from "./testing/fakes";
import { FIXTURE_ID } from "./testing/videoFixtures";
import type { OpenRouterFetch, OpenRouterRequestInit } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Binary bodies, so these tests use their own byte-exact fetch rather than the text one in testing/fakes.

let dir: string;
let target: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-video-download-"));
  target = join(dir, ".clip.tmp");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Seen {
  url: string;
  init: OpenRouterRequestInit;
  pulled: number;
  cancelled: boolean;
}

type Chunk = Uint8Array | Error;

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Chunk[];
  /** The body never produces a chunk; it ends with an abort error when the request's signal fires. */
  hangs?: boolean;
  reject?: unknown;
}

function byteFetch(reply: Reply): { fetch: OpenRouterFetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: OpenRouterFetch = async (url, init) => {
    const record: Seen = { url, init, pulled: 0, cancelled: false };
    seen.push(record);
    if (reply.reject !== undefined) throw reply.reject;
    const headers = new Map(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const queue = [...(reply.chunks ?? [])];
    return {
      status: reply.status ?? 200,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      body: {
        getReader: () => ({
          read: async () => {
            if (reply.hangs) {
              return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("This operation was aborted")), { once: true }));
            }
            const next = queue.shift();
            if (record.cancelled || next === undefined) return { done: true };
            if (next instanceof Error) throw next;
            record.pulled++;
            return { done: false, value: next };
          },
          cancel: async () => {
            record.cancelled = true;
          },
        }),
      },
    };
  };
  return { fetch, seen };
}

function bytes(length: number, fill = 7): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function download(reply: Reply, cap = 1_000, overrides: { id?: string; to?: string; signal?: AbortSignal } = {}) {
  const { fetch, seen } = byteFetch(reply);
  const harness = makeClient(fetch);
  const run = () => harness.client.downloadVideo(overrides.id ?? FIXTURE_ID, overrides.to ?? target, cap, overrides.signal ?? new AbortController().signal);
  return { ...harness, seen, run };
}

async function filesLeft(): Promise<string[]> {
  return readdir(dir);
}

test("GETs /content?index=0 with the key as a bearer token and refuses redirects", async () => {
  const { run, seen } = download({ chunks: [bytes(10)] });

  await run();

  expect(seen[0]?.url).toBe(`${LOCAL_BASE}/videos/${FIXTURE_ID}/content?index=0`);
  expect(seen[0]?.init.method).toBe("GET");
  expect(seen[0]?.init.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
  expect(seen[0]?.init.redirect).toBe("error");
});

test("saves the body byte for byte and reports its size", async () => {
  const body = Uint8Array.from({ length: 600 }, (_, i) => i % 256);
  const { run } = download({ chunks: [body.subarray(0, 250), body.subarray(250)] });

  expect(await run()).toEqual({ kind: "saved", bytes: 600 });
  expect(new Uint8Array(await readFile(target))).toEqual(body);
});

test("writes only the file it was given", async () => {
  const { run } = download({ chunks: [bytes(10)] });

  await run();

  expect(await filesLeft()).toEqual([".clip.tmp"]);
});

test("saves a body of exactly the cap", async () => {
  const { run } = download({ chunks: [bytes(500), bytes(500)] }, 1_000);

  expect(await run()).toEqual({ kind: "saved", bytes: 1_000 });
});

test("refuses a body one byte over the cap, stops reading and leaves no file", async () => {
  const { run, seen } = download({ chunks: [bytes(500), bytes(501), bytes(500), bytes(500)] }, 1_000);

  expect(await run()).toEqual({ kind: "too-large", capBytes: 1_000 });
  expect(seen[0]?.cancelled).toBe(true);
  expect(seen[0]?.pulled).toBe(2);
  expect(await filesLeft()).toEqual([]);
});

test("refuses a body whose Content-Length is over the cap without reading it", async () => {
  const { run, seen } = download({ headers: { "content-length": "1001" }, chunks: [bytes(500)] }, 1_000);

  expect(await run()).toEqual({ kind: "too-large", capBytes: 1_000 });
  expect(seen[0]?.pulled).toBe(0);
  expect(seen[0]?.cancelled).toBe(true);
  expect(await filesLeft()).toEqual([]);
});

test("still stops at the cap when Content-Length understates the body", async () => {
  const { run } = download({ headers: { "content-length": "10" }, chunks: [bytes(600), bytes(600)] }, 1_000);

  expect(await run()).toEqual({ kind: "too-large", capBytes: 1_000 });
  expect(await filesLeft()).toEqual([]);
});

test("refuses a redirect that the fetch rejects, and leaves no file", async () => {
  const redirected = new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
  const { run } = download({ reject: redirected });

  expect(await run()).toEqual({ kind: "redirect-refused", httpStatus: null, host: null });
  expect(await filesLeft()).toEqual([]);
});

test("refuses a 302 to another host, names the host and never its path or query", async () => {
  const location = "https://cdn.evil.example/signed/clip.mp4?X-Amz-Signature=SECRETSIG";
  const { run, seen } = download({ status: 302, headers: { location }, chunks: [bytes(10)] });

  const result = await run();

  expect(result).toEqual({ kind: "redirect-refused", httpStatus: 302, host: "cdn.evil.example" });
  expect(JSON.stringify(result)).not.toContain("SECRETSIG");
  expect(seen).toHaveLength(1);
  expect(await filesLeft()).toEqual([]);
});

test("refuses a 307 to the same host too: no redirect is followed", async () => {
  const { run } = download({ status: 307, headers: { location: `${LOCAL_BASE}/other` } });

  expect(await run()).toMatchObject({ kind: "redirect-refused", httpStatus: 307 });
});

test("refuses a redirect whose Location cannot be read, with no host", async () => {
  const { run } = download({ status: 301 });

  expect(await run()).toEqual({ kind: "redirect-refused", httpStatus: 301, host: null });
});

test("leaves a file that already sits at the path alone when the clip is gone before any byte is written", async () => {
  await writeFile(target, "someone else's file");
  const { run } = download({ status: 404, chunks: [] });

  await run();

  expect(await readFile(target, "utf8")).toBe("someone else's file");
});

test("answers failed with cause auth on a 401, and leaves no file", async () => {
  const { run } = download({ status: 401, chunks: [new TextEncoder().encode('{"error":{"message":"no auth"}}')] });

  expect(await run()).toMatchObject({ kind: "failed", cause: "auth", httpStatus: 401 });
  expect(await filesLeft()).toEqual([]);
});

test.each([404, 410] as const)("answers gone on a %d", async (status) => {
  const { run } = download({ status, chunks: [new TextEncoder().encode("{}")] });

  expect(await run()).toEqual({ kind: "gone", httpStatus: status });
  expect(await filesLeft()).toEqual([]);
});

test("answers failed with cause http on a 503", async () => {
  const { run } = download({ status: 503, chunks: [new TextEncoder().encode("unavailable")] });

  expect(await run()).toMatchObject({ kind: "failed", cause: "http", httpStatus: 503 });
});

test("answers failed with cause network when fetch fails", async () => {
  const { run } = download({ reject: new TypeError("fetch failed") });

  expect(await run()).toMatchObject({ kind: "failed", cause: "network", httpStatus: null });
  expect(await filesLeft()).toEqual([]);
});

test("removes the partial file when the stream breaks half way", async () => {
  const { run } = download({ chunks: [bytes(400), new Error("socket hang up")] });

  expect(await run()).toMatchObject({ kind: "failed", cause: "network", httpStatus: 200 });
  expect(await filesLeft()).toEqual([]);
});

test("removes the partial file and answers aborted when the caller's signal fires mid-body", async () => {
  const abort = new AbortController();
  const { run } = download({ hangs: true }, 1_000, { signal: abort.signal });
  const pending = run();
  abort.abort();

  expect(await pending).toMatchObject({ kind: "failed", cause: "aborted" });
  expect(await filesLeft()).toEqual([]);
});

test("answers failed with cause empty on a 200 without a body, and leaves no file", async () => {
  const { run } = download({ chunks: [] });

  expect(await run()).toMatchObject({ kind: "failed", cause: "empty", httpStatus: 200 });
  expect(await filesLeft()).toEqual([]);
});

test("answers failed on a 2xx that is not a 200", async () => {
  const { run } = download({ status: 204, chunks: [] });

  expect(await run()).toMatchObject({ kind: "failed", httpStatus: 204 });
  expect(await filesLeft()).toEqual([]);
});

test("answers failed with cause disk when the file cannot be written", async () => {
  const { run } = download({ chunks: [bytes(10)] }, 1_000, { to: join(dir, "missing", "clip.tmp") });

  expect(await run()).toMatchObject({ kind: "failed", cause: "disk" });
});

test("sends nothing for an id that is not a job id", async () => {
  const { run, seen } = download({ chunks: [bytes(10)] }, 1_000, { id: "../credits" });

  expect(await run()).toMatchObject({ kind: "failed", cause: "malformed", httpStatus: null });
  expect(seen).toHaveLength(0);
});

test.each([0, -1, 1.5, Number.NaN])("throws a RangeError for a cap of %p", async (cap) => {
  const { run } = download({ chunks: [bytes(10)] }, cap);

  await expect(run()).rejects.toBeInstanceOf(RangeError);
});

test("asks once and never retries a failing download", async () => {
  const { run, seen } = download({ status: 503, chunks: [] });

  await run();

  expect(seen).toHaveLength(1);
});

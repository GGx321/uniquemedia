import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RAW_PREFIX_BYTES } from "./openrouter/transport";
import { RAW_KEEP_BYTES, RAW_KEEP_BYTES_IMAGE, RAW_MAX_FILES, rawFileName, saveRawBody } from "./rawStore";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

let dir = "";
beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "studio-raw-")), "raw");
});
afterEach(async () => {
  await rm(join(dir, ".."), { recursive: true, force: true });
});

function idOf(fileName: string): string {
  return Buffer.from(fileName.replace(/\.txt$/, ""), "base64url").toString("utf8");
}

test("the file name is the attempt id in base64url: ids a file name would blur stay apart", async () => {
  for (const id of ["job-1:descriptor#1", "job-1:descriptor_1", "job-1/descriptor#1", "JOB-1:descriptor#1"]) await saveRawBody(dir, id, `body of ${id}`);

  const names = await readdir(dir);
  expect(names.map(idOf).sort()).toEqual(["JOB-1:descriptor#1", "job-1/descriptor#1", "job-1:descriptor#1", "job-1:descriptor_1"]);
  expect(names.every((name) => /^[A-Za-z0-9_-]+\.txt$/.test(name))).toBe(true);
  expect(rawFileName("job-1:descriptor#1")).toBe(`${Buffer.from("job-1:descriptor#1").toString("base64url")}.txt`);
});

test("a body within the limit is kept whole", async () => {
  const body = "x".repeat(RAW_KEEP_BYTES);
  await saveRawBody(dir, "a#1", body);

  expect(await readFile(join(dir, rawFileName("a#1")), "utf8")).toBe(body);
});

test("with no keepBytes given (a chat/descriptor/age-check call), a longer body keeps its start up to the client's own 64 KiB prefix and note, whole", async () => {
  expect(RAW_KEEP_BYTES).toBeGreaterThan(RAW_PREFIX_BYTES + 200);
  const body = "y".repeat(RAW_KEEP_BYTES + 10);
  await saveRawBody(dir, "a#1", body);

  const kept = await readFile(join(dir, rawFileName("a#1")), "utf8");
  expect(kept.startsWith("y".repeat(RAW_KEEP_BYTES))).toBe(true);
  expect(kept.slice(RAW_KEEP_BYTES)).toBe(
    `\n[truncated: the redacted body was ${RAW_KEEP_BYTES + 10} bytes, sha256 ${sha256Hex(body)} of the redacted body; the first ${RAW_KEEP_BYTES} are kept]\n`,
  );
});

test("an explicit keepBytes (an image attempt) caps a longer body far tighter than the chat default", async () => {
  const body = "y".repeat(RAW_KEEP_BYTES_IMAGE + 10);
  await saveRawBody(dir, "a#1", body, { keepBytes: RAW_KEEP_BYTES_IMAGE });

  const kept = await readFile(join(dir, rawFileName("a#1")), "utf8");
  expect(kept.startsWith("y".repeat(RAW_KEEP_BYTES_IMAGE))).toBe(true);
  expect(Buffer.byteLength(kept, "utf8")).toBeLessThan(RAW_KEEP_BYTES_IMAGE + 200);
  expect(kept).toContain(`the redacted body was ${RAW_KEEP_BYTES_IMAGE + 10} bytes, sha256 ${sha256Hex(body)} of the redacted body`);
});

test("an image sent as an array of byte numbers is not kept whole: the redaction rules only catch strings, so the on-disk image cap is what stops it", async () => {
  // A "redacted" body that survived per-string/per-key redaction untouched
  // (every value is a number, not a string), the way an image encoded as an
  // array of byte values would: e.g. {"data":{"bytes":[137,80,78,71,...]}}.
  const bytes = Array.from({ length: 100_000 }, (_, i) => i % 256);
  const body = JSON.stringify({ data: { bytes } });
  expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(RAW_KEEP_BYTES_IMAGE * 4);

  await saveRawBody(dir, "a#1", body, { keepBytes: RAW_KEEP_BYTES_IMAGE });

  const kept = await readFile(join(dir, rawFileName("a#1")), "utf8");
  expect(Buffer.byteLength(kept, "utf8")).toBeLessThan(RAW_KEEP_BYTES_IMAGE + 200);
  expect(kept).toContain(`the redacted body was ${Buffer.byteLength(body, "utf8")} bytes, sha256 ${sha256Hex(body)}`);
});

test("many short base64 chunks, each under the 256-char string threshold, are not kept whole either", async () => {
  // Each chunk alone is short enough that per-string redaction leaves it
  // alone; only the on-disk image cap on the whole body stops thousands of
  // them from reconstructing the image.
  const chunk = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdA==".slice(0, 120);
  const chunks = Array.from({ length: 2_000 }, () => chunk);
  const body = JSON.stringify({ image: { chunks } });
  expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(RAW_KEEP_BYTES_IMAGE * 4);

  await saveRawBody(dir, "a#1", body, { keepBytes: RAW_KEEP_BYTES_IMAGE });

  const kept = await readFile(join(dir, rawFileName("a#1")), "utf8");
  expect(Buffer.byteLength(kept, "utf8")).toBeLessThan(RAW_KEEP_BYTES_IMAGE + 200);
  expect(kept).toContain(`sha256 ${sha256Hex(body)}`);
});

test("truncation never splits a multi-byte UTF-8 character: the character is dropped whole, not half-written", async () => {
  const keepBytes = 512;
  const prefix = "a".repeat(keepBytes - 1);
  // "\u{1F600}" (😀) is 4 UTF-8 bytes; its first byte lands exactly at the cut.
  const body = `${prefix}\u{1F600}${"b".repeat(50)}`;

  await saveRawBody(dir, "a#1", body, { keepBytes });

  const raw = await readFile(join(dir, rawFileName("a#1")));
  const noteStart = raw.indexOf(Buffer.from("\n[truncated:"));
  expect(noteStart).toBeGreaterThan(-1);
  const keptPrefix = raw.subarray(0, noteStart);
  // A clean decode with no replacement character (U+FFFD) proves nothing was split.
  expect(keptPrefix.toString("utf8")).toBe(prefix);
  expect(keptPrefix.includes("�")).toBe(false);
  expect(keptPrefix.length).toBeLessThan(keepBytes);
});

test("a body is never overwritten: saving the same id again fails and the first body stays", async () => {
  await saveRawBody(dir, "a#1", "first");

  expect(await saveRawBody(dir, "a#1", "second").then(() => "saved", (e: unknown) => (e instanceof Error && "code" in e ? e.code : String(e)))).toBe("EEXIST");
  expect(await readFile(join(dir, rawFileName("a#1")), "utf8")).toBe("first");
});

test("the folder keeps the newest bodies only: past the limit the oldest go", async () => {
  const ids = ["a#1", "b#1", "c#1", "d#1", "e#1"];
  for (const [i, id] of ids.entries()) {
    await saveRawBody(dir, id, id, { maxFiles: 3 });
    // Distinct, increasing modification times, as a real sequence of saves would have.
    const at = new Date(Date.UTC(2000, 0, 1, 0, 0, i));
    await utimes(join(dir, rawFileName(id)), at, at);
  }

  expect((await readdir(dir)).map(idOf).sort()).toEqual(["c#1", "d#1", "e#1"]);
  expect(RAW_MAX_FILES).toBe(200);
});

test("the file is on disk before the save resolves", async () => {
  await saveRawBody(dir, "a#1", "body");

  expect((await stat(join(dir, rawFileName("a#1")))).size).toBe(4);
});

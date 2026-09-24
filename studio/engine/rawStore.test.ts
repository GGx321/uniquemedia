import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RAW_PREFIX_BYTES } from "./openrouter/transport";
import { RAW_KEEP_BYTES, RAW_MAX_FILES, rawFileName, saveRawBody } from "./rawStore";

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

test("a longer body keeps its start and says how long it was; the client's own 64 KiB prefix and note fit whole", async () => {
  expect(RAW_KEEP_BYTES).toBeGreaterThan(RAW_PREFIX_BYTES + 200);
  const body = "y".repeat(RAW_KEEP_BYTES + 10);
  await saveRawBody(dir, "a#1", body);

  const kept = await readFile(join(dir, rawFileName("a#1")), "utf8");
  expect(kept.startsWith("y".repeat(RAW_KEEP_BYTES))).toBe(true);
  expect(kept.slice(RAW_KEEP_BYTES)).toBe(`\n[truncated: the body was ${RAW_KEEP_BYTES + 10} bytes; the first ${RAW_KEEP_BYTES} are kept]\n`);
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

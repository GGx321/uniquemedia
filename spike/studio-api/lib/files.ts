import { existsSync } from "node:fs";
import { appendFile, link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { z } from "zod";
import { OUT } from "./config";

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp"] as const;

/** Temp file in the same directory, then rename: readers never see a half-written file. */
export async function writeAtomic(path: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export async function appendJsonl(path: string, value: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`);
}

/** Every line is validated; a malformed line throws with its line number. Missing file = empty. */
export async function readJsonl<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  const out: T[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${relative(OUT, path)}:${i + 1} is not valid JSON`);
    }
    const r = schema.safeParse(parsed);
    if (!r.success) throw new Error(`${relative(OUT, path)}:${i + 1} failed validation: ${r.error.message.slice(0, 300)}`);
    out.push(r.data);
  }
  return out;
}

export async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return schema.parse(parsed);
}

/** An output's extension is only known after the response, so look for any image extension. */
export function findExisting(basePathNoExt: string): string | null {
  for (const ext of IMAGE_EXTS) {
    const p = `${basePathNoExt}.${ext}`;
    if (existsSync(p)) return p;
  }
  return null;
}

export async function listImages(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  return names
    .filter((n) => !n.startsWith(".") && IMAGE_EXTS.some((e) => n.toLowerCase().endsWith(`.${e}`)))
    .sort()
    .map((n) => join(dir, n));
}

/** Path relative to out/, the key shared by results, age, face and report. */
export function outRel(path: string): string {
  return relative(OUT, path);
}

function hasCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}

async function readPid(path: string): Promise<number | null> {
  try {
    const pid = Number((await readFile(path, "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (err) {
    if (hasCode(err, "ENOENT")) return null;
    throw err;
  }
}

function busy(pid: number, path: string): Error {
  return new Error(`Another spike command (pid ${pid}) is running; lock ${outRel(path)}`);
}

/**
 * One paid command at a time: two processes would each read the same ledger
 * and could together exceed the cap. The lock file is created by link(2) from
 * a temp file that already holds our pid, so it never exists half-written and
 * creation fails atomically when it exists. A lock whose pid is dead is taken
 * over under a second exclusive file, re-checked, and replaced with rename(2).
 */
export async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  const mine = `${lockPath}.${process.pid}.tmp`;
  const release = async (): Promise<void> => {
    if ((await readPid(lockPath)) === process.pid) await rm(lockPath, { force: true });
  };
  await writeFile(mine, String(process.pid));
  try {
    try {
      await link(mine, lockPath);
      return release;
    } catch (err) {
      if (!hasCode(err, "EEXIST")) throw err;
    }
    const holder = await readPid(lockPath);
    if (holder !== null && isAlive(holder)) throw busy(holder, lockPath);

    const takeover = `${lockPath}.takeover`;
    try {
      await link(mine, takeover);
    } catch (err) {
      if (!hasCode(err, "EEXIST")) throw err;
      const other = await readPid(takeover);
      if (other !== null && isAlive(other)) throw busy(other, takeover);
      throw new Error(`${outRel(takeover)} was left by a crashed takeover; delete it and retry`);
    }
    try {
      const again = await readPid(lockPath);
      if (again !== null && again !== holder && isAlive(again)) throw busy(again, lockPath);
      await rename(mine, lockPath);
    } finally {
      await rm(takeover, { force: true });
    }
    return release;
  } finally {
    await rm(mine, { force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return hasCode(err, "EPERM");
  }
}

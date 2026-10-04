// Usage: bun upload.ts <tag> <dir-with-installers>   (FORCE=true allows a downgrade)
// Frees space, uploads the .dmg/.exe to uniquemedia/<version>/, publishes
// uniquemedia/latest.json, then deletes the previous version.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { del, list, put, type ListBlobResultBlob } from "@vercel/blob";
import {
  BLOB_PREFIX,
  LATEST_PATHNAME,
  blobsToDelete,
  buildLatest,
  checkDowngrade,
  checkSize,
  classifyAssets,
  currentVersionOf,
  parseVersion,
  staleBeforeUpload,
  type Platform,
} from "./downloads";

const CONTENT_TYPES: Record<Platform, string> = {
  mac: "application/x-apple-diskimage",
  win: "application/vnd.microsoft.portable-executable",
};

async function listAll(token: string): Promise<ListBlobResultBlob[]> {
  const blobs: ListBlobResultBlob[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: BLOB_PREFIX, cursor, token });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function main(): Promise<void> {
  const [tag, dir] = process.argv.slice(2);
  if (!tag || !dir) throw new Error("Usage: bun upload.ts <tag> <dir>");

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not set (add it as a repository secret).");
  }
  const force = process.env.FORCE === "true";

  // Validate everything that can be validated before touching the store.
  const version = parseVersion(tag);
  const names = classifyAssets(readdirSync(dir));
  const files = (Object.keys(names) as Platform[]).map((platform) => ({
    platform,
    name: names[platform],
    file: Bun.file(join(dir, names[platform])),
  }));
  const newBytes = files.reduce((n, f) => n + f.file.size, 0);

  const existing = await listAll(token);
  const latestBlob = existing.find((b) => b.pathname === LATEST_PATHNAME);
  let current: string | null = null;
  if (latestBlob) {
    const res = await fetch(`${latestBlob.url}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not read the current latest.json (HTTP ${res.status})`);
    current = currentVersionOf(await res.json());
  }
  checkDowngrade(version, current, force);

  // Make room first: keep only the version latest.json points to.
  const paths = existing.map((b) => b.pathname);
  const before = new Set(staleBeforeUpload(paths, current));
  const kept = existing.filter((b) => !before.has(b.pathname));
  checkSize(kept, version, newBytes); // throws before anything is deleted or uploaded
  if (before.size > 0) {
    await del(existing.filter((b) => before.has(b.pathname)).map((b) => b.url), { token });
    for (const p of before) console.log(`deleted ${p}`);
  }

  const urls: Partial<Record<Platform, string>> = {};
  for (const f of files) {
    const blob = await put(`${BLOB_PREFIX}${version}/${f.name}`, f.file, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      multipart: true,
      contentType: CONTENT_TYPES[f.platform],
      token,
    });
    urls[f.platform] = blob.url;
    console.log(`uploaded ${blob.pathname}`);
  }

  // latest.json goes last, so it never points at an installer that is not there yet.
  const latest = buildLatest({ version, mac: urls.mac as string, win: urls.win as string, now: new Date() });
  await put(LATEST_PATHNAME, JSON.stringify(latest), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60,
    token,
  });
  console.log(`published ${LATEST_PATHNAME} for ${version}`);

  // The previous version is no longer referenced: delete it.
  const after = new Set(blobsToDelete(kept.map((b) => b.pathname), version));
  if (after.size > 0) {
    await del(kept.filter((b) => after.has(b.pathname)).map((b) => b.url), { token });
    for (const p of after) console.log(`deleted ${p}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "upload failed");
  process.exit(1);
});

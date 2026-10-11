// Usage: bun upload.ts <tag> <dir-with-installers>   (FORCE=true allows a downgrade)
// Uploads the .dmg/.exe to uniquemedia/<version>/ and publishes uniquemedia/latest.json.
// The order of every upload, publish, wait and delete comes from planUpload (downloads.ts):
// when the old and new version do not fit the store together it replaces one platform at a time.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { del, list, put, type ListBlobResultBlob } from "@vercel/blob";
import {
  BLOB_PREFIX,
  LATEST_CACHE_SECONDS,
  LATEST_PATHNAME,
  buildLatest,
  checkDowngrade,
  classifyAssets,
  currentRefsOf,
  executePlan,
  parseVersion,
  planUpload,
  type Current,
  type Platform,
  type PlanIo,
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

  const existing = await listAll(token);
  const latestBlob = existing.find((b) => b.pathname === LATEST_PATHNAME);
  let current: Current | null = null;
  if (latestBlob) {
    const res = await fetch(`${latestBlob.url}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not read the current latest.json (HTTP ${res.status})`);
    current = currentRefsOf(await res.json());
  }
  checkDowngrade(version, current?.version ?? null, force);

  // Throws before anything is deleted or uploaded when the plan cannot stay under the limit.
  const plan = planUpload({
    version,
    current,
    blobs: existing.map((b) => ({ pathname: b.pathname, size: b.size })),
    files: files.map((f) => ({ platform: f.platform, name: f.name, size: f.file.size })),
  });
  console.log(`plan: ${plan.mode}, peak ${(plan.peakBytes / 1048576).toFixed(0)} MB`);

  const urls = new Map(existing.map((b) => [b.pathname, b.url]));
  const urlOf = (pathname: string): string => {
    const url = urls.get(pathname);
    if (!url) throw new Error(`No url known for ${pathname}`);
    return url;
  };
  const io: PlanIo = {
    upload: async (step) => {
      const f = files.find((x) => x.platform === step.platform);
      if (!f) throw new Error(`No file for ${step.platform}`);
      const blob = await put(step.pathname, f.file, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        multipart: true,
        contentType: CONTENT_TYPES[f.platform],
        token,
      });
      urls.set(blob.pathname, blob.url);
      console.log(`uploaded ${blob.pathname}`);
    },
    publish: async (step) => {
      const latest = buildLatest({ version: step.version, mac: urlOf(step.mac), win: urlOf(step.win), now: new Date() });
      await put(LATEST_PATHNAME, JSON.stringify(latest), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
        cacheControlMaxAge: LATEST_CACHE_SECONDS,
        token,
      });
      console.log(`published ${LATEST_PATHNAME} for ${step.version} (mac ${step.mac}, win ${step.win})`);
    },
    remove: async (pathnames) => {
      await del(pathnames.map(urlOf), { token });
      for (const p of pathnames) console.log(`deleted ${p}`);
    },
    sleep: async (ms) => {
      console.log(`waiting ${ms / 1000} s for cached copies of latest.json to expire`);
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
  await executePlan(plan, io);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "upload failed");
  process.exit(1);
});

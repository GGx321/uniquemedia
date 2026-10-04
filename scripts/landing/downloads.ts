// Pure helpers for publishing the installers to the public Vercel Blob store.

export const BLOB_PREFIX = "uniquemedia/";
export const LATEST_PATHNAME = `${BLOB_PREFIX}latest.json`;

export type Platform = "mac" | "win";

export interface Latest {
  version: string;
  mac: string;
  win: string;
  publishedAt: string;
}

/** "v0.6.0" -> "0.6.0". Only plain vX.Y.Z tags are uniquifier releases. */
export function parseVersion(tag: string): string {
  const m = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!m) throw new Error(`Not a uniquifier release tag (expected vX.Y.Z): ${tag}`);
  return m[1];
}

export function classifyAsset(name: string): Platform | null {
  if (/\.dmg$/i.test(name)) return "mac";
  if (/\.exe$/i.test(name)) return "win";
  return null;
}

export function buildLatest(input: { version: string; mac: string; win: string; now: Date }): Latest {
  return {
    version: input.version,
    mac: input.mac,
    win: input.win,
    publishedAt: input.now.toISOString(),
  };
}

/** Hobby plan stores 1 GB; stay clear of it. */
export const SIZE_LIMIT_BYTES = 950 * 1024 * 1024;

/** Exactly one .dmg and one .exe; anything else (checksums, blockmaps) is ignored. */
export function classifyAssets(names: string[]): Record<Platform, string> {
  const found: Partial<Record<Platform, string[]>> = {};
  for (const name of names) {
    const platform = classifyAsset(name);
    if (platform) (found[platform] ??= []).push(name);
  }
  const out: Partial<Record<Platform, string>> = {};
  for (const [platform, ext] of [["mac", ".dmg"], ["win", ".exe"]] as const) {
    const list = found[platform] ?? [];
    if (list.length === 0) throw new Error(`No ${ext} installer found among the release assets`);
    if (list.length > 1) throw new Error(`More than one ${ext} installer found: ${list.join(", ")}`);
    out[platform] = list[0];
  }
  return { mac: out.mac as string, win: out.win as string };
}

/** The version a parsed latest.json points to. Throws on anything unexpected. */
export function currentVersionOf(latest: unknown): string {
  const v = typeof latest === "object" && latest !== null ? (latest as { version?: unknown }).version : undefined;
  if (typeof v !== "string" || !/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error("Existing latest.json has no valid version; refusing to guess what to delete");
  }
  return v;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Refuse to publish an older version over a newer latest.json unless forced. */
export function checkDowngrade(next: string, current: string | null, force: boolean): void {
  if (current && !force && compareVersions(next, current) < 0) {
    throw new Error(`Refusing a downgrade from ${current} to ${next} (dispatch with force: true to override)`);
  }
}

/** Before uploading: drop every version except the one latest.json points to. */
export function staleBeforeUpload(pathnames: string[], currentVersion: string | null): string[] {
  const keepDir = currentVersion ? `${BLOB_PREFIX}${currentVersion}/` : null;
  return pathnames.filter(
    (p) => p.startsWith(BLOB_PREFIX) && p !== LATEST_PATHNAME && !(keepDir && p.startsWith(keepDir)),
  );
}

/** Blobs that remain after the pre-upload cleanup plus the new files must fit. */
export function checkSize(kept: { pathname: string; size: number }[], newVersion: string, newBytes: number): void {
  const newDir = `${BLOB_PREFIX}${newVersion}/`; // overwritten by the upload, so not counted
  const total = kept.filter((b) => !b.pathname.startsWith(newDir)).reduce((n, b) => n + b.size, 0) + newBytes;
  if (total > SIZE_LIMIT_BYTES) {
    throw new Error(
      `Storage would reach ${(total / 1048576).toFixed(0)} MB, over the 950 MB limit; nothing was uploaded`,
    );
  }
}

/** Pathnames to delete after publishing: everything under uniquemedia/ except the new version and latest.json. */
export function blobsToDelete(pathnames: string[], keepVersion: string): string[] {
  const keepDir = `${BLOB_PREFIX}${keepVersion}/`;
  return pathnames.filter(
    (p) => p.startsWith(BLOB_PREFIX) && p !== LATEST_PATHNAME && !p.startsWith(keepDir),
  );
}

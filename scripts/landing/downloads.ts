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


/**
 * latest.json is put with a 60 s max-age. A copy can sit in the CDN for that long and then in a browser for
 * another 60 s, so a file is deleted no earlier than twice that (plus a margin) after the last latest.json
 * that referenced it was replaced.
 */
export const LATEST_CACHE_SECONDS = 60;
export const CACHE_WAIT_SECONDS = 2 * LATEST_CACHE_SECONDS + 5;

/** What latest.json points at, as store pathnames. */
export interface Current {
  version: string;
  mac: string;
  win: string;
}

export type PlanStep =
  | { kind: "delete"; pathnames: string[] }
  | { kind: "upload"; platform: Platform; pathname: string; bytes: number }
  | { kind: "publish"; version: string; mac: string; win: string }
  | { kind: "wait"; seconds: number };

export interface Plan {
  mode: "all" | "rolling";
  steps: PlanStep[];
  /** Highest total store size at any point of the plan. */
  peakBytes: number;
}

export interface PlanIo {
  upload(step: Extract<PlanStep, { kind: "upload" }>): Promise<void>;
  publish(step: Extract<PlanStep, { kind: "publish" }>): Promise<void>;
  remove(pathnames: string[]): Promise<void>;
  sleep(ms: number): Promise<void>;
}

function pathnameOf(url: unknown): string {
  let pathname: string | null = null;
  if (typeof url === "string") {
    try {
      pathname = decodeURIComponent(new URL(url).pathname.slice(1));
    } catch {
      pathname = null;
    }
  }
  if (!pathname || !pathname.startsWith(BLOB_PREFIX) || pathname === LATEST_PATHNAME) {
    throw new Error("Existing latest.json points outside uniquemedia/; refusing to guess what to keep");
  }
  return pathname;
}

/** The version and installer pathnames a parsed latest.json points to. Throws on anything unexpected. */
export function currentRefsOf(latest: unknown): Current {
  const version = currentVersionOf(latest);
  const { mac, win } = latest as { mac?: unknown; win?: unknown };
  return { version, mac: pathnameOf(mac), win: pathnameOf(win) };
}

function peakOf(start: Map<string, number>, steps: PlanStep[]): number {
  const sizes = new Map(start);
  const total = () => [...sizes.values()].reduce((n, v) => n + v, 0);
  let peak = total();
  for (const s of steps) {
    if (s.kind === "upload") sizes.set(s.pathname, s.bytes);
    if (s.kind === "delete") for (const p of s.pathnames) sizes.delete(p);
    peak = Math.max(peak, total());
  }
  return peak;
}

/**
 * Orders every store change so that latest.json never points at a missing file and a file is
 * deleted only after the latest.json that referenced it has expired from caches. When the old
 * and new version do not fit together it rolls one platform at a time. Pure: nothing is touched
 * here, and it throws (so the caller touches nothing) if even the rolling peak is over the limit.
 */
export function planUpload(input: {
  version: string;
  current: Current | null;
  blobs: { pathname: string; size: number }[];
  files: { platform: Platform; name: string; size: number }[];
  limitBytes?: number;
}): Plan {
  const { version, current } = input;
  const limit = input.limitBytes ?? SIZE_LIMIT_BYTES;
  const files = input.files.map((f) => ({ ...f, pathname: `${BLOB_PREFIX}${version}/${f.name}` }));
  const newPaths = new Set(files.map((f) => f.pathname));
  const refs = current ? [current.mac, current.win] : [];

  const inStore = new Map(
    input.blobs.filter((b) => b.pathname.startsWith(BLOB_PREFIX) && b.pathname !== LATEST_PATHNAME).map((b) => [b.pathname, b.size]),
  );
  // Leftovers nothing references (and the upload will not overwrite) go first; they never count toward the peak.
  const stale = [...inStore.keys()].filter((p) => !refs.includes(p) && !newPaths.has(p));
  const start = new Map([...inStore].filter(([p]) => !stale.includes(p)));
  // A latest.json cached from an earlier run may still point at them, so wait before deleting.
  const head: PlanStep[] =
    stale.length > 0 ? [{ kind: "wait", seconds: CACHE_WAIT_SECONDS }, { kind: "delete", pathnames: stale }] : [];
  const kept = refs.filter((p) => !newPaths.has(p) && start.has(p)); // the old installers that outlive the uploads

  // Nothing to send when the same path with the same size is already there (a re-run after a partial one).
  const uploadOf = (platform: Platform): PlanStep[] => {
    const f = files.find((x) => x.platform === platform) as (typeof files)[number];
    return inStore.get(f.pathname) === f.size ? [] : [{ kind: "upload", platform, pathname: f.pathname, bytes: f.size }];
  };
  const newPath = (platform: Platform) => (files.find((f) => f.platform === platform) as (typeof files)[number]).pathname;
  const tooBig = (peak: number, what: string) =>
    new Error(`Storage would reach ${(peak / 1048576).toFixed(0)} MB${what}, over the ${(limit / 1048576).toFixed(0)} MB limit; nothing was changed`);

  const allSteps: PlanStep[] = [
    ...head,
    ...uploadOf("mac"),
    ...uploadOf("win"),
    { kind: "publish", version, mac: newPath("mac"), win: newPath("win") },
    ...(kept.length > 0 ? [{ kind: "wait", seconds: CACHE_WAIT_SECONDS } as const, { kind: "delete", pathnames: kept } as const] : []),
  ];
  const allPeak = peakOf(start, allSteps);
  if (allPeak <= limit) return { mode: "all", steps: allSteps, peakBytes: allPeak };
  if (!current) throw tooBig(allPeak, "");

  for (const p of refs) {
    if (!start.has(p)) throw new Error(`latest.json points at ${p}, which is not in the store; cannot roll safely`);
  }
  const rolling: PlanStep[] = [...head];
  for (const platform of ["mac", "win"] as const) {
    const old = current[platform];
    rolling.push(...uploadOf(platform));
    // The mixed step keeps the old version label: the other platform still serves the old installer.
    rolling.push(
      platform === "mac"
        ? { kind: "publish", version: current.version, mac: newPath("mac"), win: current.win }
        : { kind: "publish", version, mac: newPath("mac"), win: newPath("win") },
    );
    if (!newPaths.has(old)) rolling.push({ kind: "wait", seconds: CACHE_WAIT_SECONDS }, { kind: "delete", pathnames: [old] });
  }
  const rollingPeak = peakOf(start, rolling);
  if (rollingPeak > limit) throw tooBig(rollingPeak, " even rolling one platform at a time");
  return { mode: "rolling", steps: rolling, peakBytes: rollingPeak };
}

export async function executePlan(plan: Plan, io: PlanIo): Promise<void> {
  for (const step of plan.steps) {
    if (step.kind === "upload") await io.upload(step);
    else if (step.kind === "publish") await io.publish(step);
    else if (step.kind === "delete") await io.remove(step.pathnames);
    else await io.sleep(step.seconds * 1000);
  }
}

/**
 * The newest version latest.json involves: its label, or the version directory of either installer it points
 * at (a half-rolled latest.json keeps the old label but already serves a new installer).
 */
export function effectiveVersion(current: Current | null): string | null {
  if (!current) return null;
  const found = [current.mac, current.win]
    .map((p) => new RegExp(`^${BLOB_PREFIX}(\\d+\\.\\d+\\.\\d+)/`).exec(p)?.[1])
    .filter((v): v is string => v !== undefined);
  return [current.version, ...found].reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
}

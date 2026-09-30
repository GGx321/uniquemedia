import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CdnResponse, CdnTransport } from "../cdnTransport";
import { musicLists, musicTracks } from "../fixtures";
import { parseFlashapiList, type MusicTrack } from "../listSchema";

/**
 * Test-only: what the track store's tests serve and read. The 3c.1 list gives real URLs on the real CDN hosts (so the
 * allowlist runs on what it will see), a fake CDN answers them from the four HE-AAC excerpts, and every track's claimed
 * length is set to its excerpt's, since an excerpt is 6 to 8 seconds of a track the list says is minutes long. Production
 * code never imports this file (it lives under `testing/`, which the purity guard and the bundle check keep out).
 */

export const EXCERPTS = [musicTracks.hot, musicTracks.threshold, musicTracks.quiet, musicTracks.he48k] as const;

/** A 1x1 JPEG, PNG and lossless WebP: only what the store reads (their first bytes) matters. */
export const JPEG_1X1 = Uint8Array.from(Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64"));
export const PNG_1X1_BYTES = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
export const WEBP_1X1 = Uint8Array.from(Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64"));

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const excerptBytes = new Map<string, Uint8Array>();
export function excerptOf(index: number): Uint8Array {
  const file = EXCERPTS[index % EXCERPTS.length]?.file ?? "";
  let bytes = excerptBytes.get(file);
  if (bytes === undefined) {
    bytes = new Uint8Array(readFileSync(file));
    excerptBytes.set(file, bytes);
  }
  return bytes;
}

/** The first `count` tracks of a 3c.1 list, each claiming the length of the excerpt that serves it. */
export function listTracks(count: number, which: keyof typeof musicLists = "kyiv"): MusicTrack[] {
  const fixture = JSON.parse(readFileSync(musicLists[which].file, "utf8")) as { response: unknown };
  const parsed = parseFlashapiList(fixture.response);
  if (!parsed.ok) throw new Error("the fixture list does not parse");
  return parsed.tracks.slice(0, count).map((track, index) => ({ ...track, durationMs: EXCERPTS[index % EXCERPTS.length]?.durationMs ?? 8000 }));
}

export interface Served {
  status?: number;
  headers?: Record<string, string>;
  bytes?: Uint8Array;
  /** A body of your own, in place of `bytes`. */
  body?: AsyncIterable<Uint8Array>;
}

export interface FakeCdn {
  transport: CdnTransport;
  /** Every href requested, in order. */
  requested: string[];
  destroyed: number;
  /** Serve `served` for this exact URL (an href). Anything not set is a 404. */
  serve(href: string, served: Served | (() => Served)): void;
  /** Called with the href just before it is answered: a hook for a test that looks at the disk at that moment. */
  onRequest: ((href: string) => void | Promise<void>) | null;
}

export function fakeCdn(): FakeCdn {
  const table = new Map<string, Served | (() => Served)>();
  const cdn: FakeCdn = {
    requested: [],
    destroyed: 0,
    onRequest: null,
    serve: (href, served) => void table.set(href, served),
    transport: async ({ url }) => {
      cdn.requested.push(url.href);
      await cdn.onRequest?.(url.href);
      const entry = table.get(url.href);
      const served: Served = typeof entry === "function" ? entry() : (entry ?? { status: 404, bytes: new Uint8Array(0) });
      const bytes = served.bytes ?? new Uint8Array(0);
      const body =
        served.body ??
        (async function* () {
          if (bytes.byteLength > 0) yield bytes;
        })();
      const response: CdnResponse = {
        status: served.status ?? 200,
        headers: { ...(served.body === undefined && (served.status === undefined || served.status === 200) ? { "content-length": String(bytes.byteLength) } : {}), ...served.headers },
        body,
        destroy: () => void cdn.destroyed++,
      };
      return response;
    },
  };
  return cdn;
}

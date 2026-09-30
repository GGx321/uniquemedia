import type { FlashapiResponseInfo } from "./client";
import type { ListParse } from "./listSchema";
import { redactKnown } from "./redactKnown";
import { signedUrlExpiresAtMs } from "./signedUrl";

// What the first real refresh logs (plan, Quota row; N6, SP5), built from what the client and the parser already
// reduced: header NAMES with values only for the rate-limit family, the status, the item count, `page_info`, the dropped
// items, unknown keys, the distinct open-string values, the explicit count, each URL's scheme and host, the minimum
// expiry, and the local quota counter beside the server's. Never the key, never a whole (signed) URL, never a title.
// The per-download half of the plan's list (status, bytes, codec, duration against `duration_in_ms`, sha256) belongs to
// 3c.4's downloads and is added there, into the same report; the one-preview measurement likewise.

const MAX_DROPPED_INDICES = 50;

export interface RefreshReportInput {
  /** The answer's own figures; null when the request got no answer (network, timeout). */
  response: FlashapiResponseInfo | null;
  /** The parsed list; null when there was none (an error answer, an unparseable body). */
  list: Extract<ListParse, { ok: true }> | null;
  /** Sends the ledger holds in the window, this request included. */
  localSentInWindow: number;
  now: number;
  /** Every string in the report is passed through `redactKnown(text, key)`: required, so no caller can forget it. */
  key: string;
}

export interface RefreshReport {
  httpStatus: number | null;
  headerNames: string[];
  rateLimit: Record<string, string>;
  bodyBytes: number | null;
  quota: { localSentInWindow: number; serverRemaining: number | null; serverLimit: number | null };
  items: number | null;
  kept: number | null;
  bodyStatus: string | null;
  pageInfo: { nextMaxId?: string; moreAvailable?: boolean } | null;
  dropped: { total: number; byReason: Record<string, number>; indices: number[] };
  unknownKeys: { topLevel: string[]; track: string[]; metadata: string[] };
  monetizationValues: string[];
  licensedSubtypes: string[];
  explicit: number | null;
  urlOrigins: string[];
  minExpiresAt: string | null;
}

function redactDeep<T>(value: T, key: string): T {
  if (typeof value === "string") return redactKnown(value, key) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => redactDeep(item, key)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [redactKnown(name, key), redactDeep(item, key)])) as T;
  }
  return value;
}

export function buildRefreshReport(input: RefreshReportInput): RefreshReport {
  const { response, list } = input;
  const byReason: Record<string, number> = {};
  for (const item of list?.dropped ?? []) byReason[item.reason] = (byReason[item.reason] ?? 0) + 1;
  const expiries: number[] = [];
  for (const track of list?.tracks ?? []) {
    for (const url of [track.downloadUrl, track.coverUrl]) {
      const at = url === null ? null : signedUrlExpiresAtMs(url);
      if (at !== null) expiries.push(at);
    }
  }
  const report: RefreshReport = {
    httpStatus: response?.status ?? null,
    headerNames: response?.headerNames ?? [],
    rateLimit: response?.rateLimit ?? {},
    bodyBytes: response?.bodyBytes ?? null,
    quota: { localSentInWindow: input.localSentInWindow, serverRemaining: response?.remaining ?? null, serverLimit: response?.limit ?? null },
    items: list?.observed.itemCount ?? null,
    kept: list?.tracks.length ?? null,
    bodyStatus: list?.observed.bodyStatus ?? null,
    pageInfo: list?.observed.pageInfo ?? null,
    dropped: { total: list?.dropped.length ?? 0, byReason, indices: (list?.dropped ?? []).slice(0, MAX_DROPPED_INDICES).map((d) => d.index) },
    unknownKeys: {
      topLevel: [...(list?.observed.unknownTopLevelKeys ?? [])],
      track: [...(list?.observed.unknownTrackKeys ?? [])],
      metadata: [...(list?.observed.unknownMetadataKeys ?? [])],
    },
    monetizationValues: [...(list?.observed.monetizationValues ?? [])],
    licensedSubtypes: [...(list?.observed.subtypeValues ?? [])],
    explicit: list?.observed.explicitCount ?? null,
    urlOrigins: [...(list?.observed.urlOrigins ?? [])],
    minExpiresAt: expiries.length === 0 ? null : new Date(Math.min(...expiries)).toISOString(),
  };
  return redactDeep(report, input.key);
}

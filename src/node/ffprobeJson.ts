/**
 * Defensive reader for `ffprobe -print_format json` output.
 *
 * ffprobe output crosses a trust boundary: it is JSON produced by another
 * process, every key is optional, every number arrives as a string, and a
 * failed probe can emit `{}` or nothing at all. Nothing here assumes a shape
 * and nothing is cast into one — a malformed payload yields an empty result,
 * never a throw and never a half-built value.
 */

export interface ProbeStream {
  codecType: string; // "video" | "audio" | ... ; "" when absent
  codecName: string; // "mjpeg", "h264", ... ; "" when absent
  width: number | null; // null, not 0 — 0 would read as a real 0x0 image
  height: number | null;
  durationSec: number | null;
}

export interface ProbeResult {
  streams: ProbeStream[];
  formatDurationSec: number | null;
}

const EMPTY: ProbeResult = { streams: [], formatDurationSec: null };

/** True only for a plain object we may read own properties from. */
function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own properties only: a payload naming `__proto__` must not be able to reach
 *  the prototype chain and fake a field. */
function own(source: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(source, key)
    ? Object.getOwnPropertyDescriptor(source, key)?.value
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Numbers arrive as strings ("640", "2.008000"), and "N/A" arrives too. */
function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseFfprobeJson(stdout: string): ProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return EMPTY;
  }
  if (!isRecord(parsed)) return EMPTY;

  const rawStreams = own(parsed, "streams");
  const streams: ProbeStream[] = Array.isArray(rawStreams)
    ? rawStreams.map((raw: unknown) =>
        isRecord(raw)
          ? {
              codecType: asString(own(raw, "codec_type")),
              codecName: asString(own(raw, "codec_name")),
              width: asFiniteNumber(own(raw, "width")),
              height: asFiniteNumber(own(raw, "height")),
              durationSec: asFiniteNumber(own(raw, "duration")),
            }
          : { codecType: "", codecName: "", width: null, height: null, durationSec: null }
      )
    : [];

  const rawFormat = own(parsed, "format");
  return {
    streams,
    formatDurationSec: isRecord(rawFormat) ? asFiniteNumber(own(rawFormat, "duration")) : null,
  };
}

/** The longest duration stated anywhere in the probe, or 0 when none is. */
export function longestDuration(probe: ProbeResult): number {
  let longest = probe.formatDurationSec ?? 0;
  for (const stream of probe.streams) {
    if (stream.durationSec !== null && stream.durationSec > longest) longest = stream.durationSec;
  }
  return longest;
}

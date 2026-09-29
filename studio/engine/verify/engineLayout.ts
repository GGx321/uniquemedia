import { findMovSignatureFields } from "../../../src/node/movSignature";
import type { Findings } from "./boxes";

/**
 * A second opinion from the uniquifier's own MOV walker
 * (`src/node/movSignature.ts`, imported and never modified), asked only of a
 * file that passed everything else. It walks `ftyp` and `moov` and throws on a
 * layout ffmpeg's muxer would not write (a brand other than `qt  ` or `isom`,
 * no `moov`, a sample entry too short for its vendor or compressor field). That
 * is the same walk the uniquifier trusts before it patches those fields, so a
 * file it refuses is not one the engine wrote.
 *
 * It walks a whole file and the media data is not in memory, so it is handed
 * the two boxes joined: its top level then holds exactly `ftyp` and `moov`.
 * Its report of the fields it would patch is not used: Studio accepts the
 * engine's signature (`minor_version`, the `Lavc` compressor name) and checks
 * each of those fields itself.
 */
export function checkEngineLayout(ftyp: Uint8Array, moov: Uint8Array, findings: Findings): void {
  const joined = new Uint8Array(ftyp.length + moov.length);
  joined.set(ftyp, 0);
  joined.set(moov, ftyp.length);
  try {
    findMovSignatureFields(joined);
  } catch (cause) {
    findings.add("STRUCTURE_UNRECOGNISED", `the layout is not one ffmpeg's muxer writes: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

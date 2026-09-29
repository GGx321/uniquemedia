import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { BUILTIN_MARKERS, forbiddenCode, UUID_PAYLOAD_HEAD_BYTES } from "./allowlist";
import { Findings, MOOV_MAX_BYTES, MOOV_SCHEMA, readAt, TOP_LEVEL_ALLOWED, walkNested, walkTopLevel, type TopBox } from "./boxes";
import { checkFtyp, checkMoov } from "./checks";
import { checkEngineLayout } from "./engineLayout";
import { checkMediaData } from "./media";
import { quote } from "./reader";
import { scanForNeedles, type Needle } from "./scan";
import { checkStructure } from "./structure";
import { MAX_OUTPUT_BYTES, MIN_FORBIDDEN_STRING_BYTES, VerifyIoError, type VerifyExpected, type VerifyOptions, type VerifyResult } from "./types";

// The output verifier (plan slice 3a.7): walks the boxes of a finished MP4 and
// refuses anything but the engine's own output. It returns every reason it
// finds, as stable codes, and throws only when the file cannot be read (and
// RangeError for a bad argument).

/** Opens the file, so that the size and the reads all come from one handle (nothing can swap the file between them). */
async function openFile(path: string): Promise<FileHandle> {
  try {
    return await open(path, "r");
  } catch (cause) {
    const code = cause instanceof Error ? Reflect.get(cause, "code") : undefined;
    throw new VerifyIoError(code === "ENOENT" ? "not_found" : "read_failed", path, { cause });
  }
}

async function regularFileSize(handle: FileHandle, path: string): Promise<number> {
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new VerifyIoError("not_a_file", path);
    return info.size;
  } catch (cause) {
    if (cause instanceof VerifyIoError) throw cause;
    throw new VerifyIoError("read_failed", path, { cause });
  }
}

/** A `free` box is padding; anything readable inside it is a place to hide a note. The real one is 8 bytes. */
const FREE_MAX_SCAN_BYTES = 64 * 1024;

/** The real `ftyp` is 32 bytes. */
const FTYP_MAX_BYTES = 1024;

const CALLER_LABEL = "caller-string-";

/** Names a hit for the log; the caller's own string is never echoed back. */
function describeNeedle(label: string): string {
  if (!label.startsWith(CALLER_LABEL)) return `photo-metadata marker '${label}'`;
  const [index, encoding] = label.slice(CALLER_LABEL.length).split("/");
  return `caller string #${index}${encoding ? ` (${encoding})` : ""}`;
}

/** Each caller string is searched as UTF-8 and as UTF-16, either byte order (EXIF and XMP both carry text in those forms). */
function callerNeedles(strings: readonly string[]): Needle[] {
  return strings.flatMap((text, i) => {
    const utf8 = new TextEncoder().encode(text);
    if (utf8.length < MIN_FORBIDDEN_STRING_BYTES) throw new RangeError(`forbidden string #${i} is under ${MIN_FORBIDDEN_STRING_BYTES} bytes`);
    const le = Buffer.from(text, "utf16le");
    return [
      { label: `${CALLER_LABEL}${i}`, bytes: utf8 },
      { label: `${CALLER_LABEL}${i}/utf-16le`, bytes: Uint8Array.from(le) },
      { label: `${CALLER_LABEL}${i}/utf-16be`, bytes: Uint8Array.from(Buffer.from(le).swap16()) },
    ];
  });
}

/** A caller mistake, not a property of the file: refused before the file is opened. */
function assertUsable(expected: VerifyExpected, options: VerifyOptions): { needles: Needle[]; maxBytes: number } {
  if (!Number.isSafeInteger(expected.frames) || expected.frames < 1) throw new RangeError(`expected.frames must be a positive whole number, got ${expected.frames}`);
  const maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new RangeError(`options.maxBytes must be a positive finite number, got ${maxBytes}`);
  return { needles: callerNeedles(expected.forbiddenStrings ?? []), maxBytes };
}

/** What `verifyAndHashMp4` found: the verdict, and the digest of the bytes it judged. */
export interface VerifiedFile {
  readonly result: VerifyResult;
  /** sha256 (lowercase hex) of the whole file as read by the verification itself; null when the file was refused before, or without, a complete read. */
  readonly sha256: string | null;
  /** The size the handle reported: the length of the bytes that were verified. */
  readonly bytes: number;
}

/**
 * `verifyRenderedMp4`, and the file's sha256 taken from the SAME sequential read
 * of the whole file (the content scan): one pass, so there is no moment between
 * "verified" and "hashed" in which the file could be swapped. The digest is null
 * when the file was refused as too large (never read) or the scan stopped early.
 */
export async function verifyAndHashMp4(path: string, expected: VerifyExpected, options: VerifyOptions = {}): Promise<VerifiedFile> {
  const { needles, maxBytes } = assertUsable(expected, options);
  const findings = new Findings(expected.forbiddenStrings ?? []);
  const handle = await openFile(path);
  try {
    const size = await regularFileSize(handle, path);
    if (size > maxBytes) {
      findings.add("FILE_TOO_LARGE", `${size} bytes is over the ${maxBytes}-byte cap`);
      return { result: { ok: false, reasons: findings.list }, sha256: null, bytes: size };
    }
    const hash = createHash("sha256");
    let hashed = 0;
    await verifyOpenFile(handle, path, size, expected, needles, findings, (chunk) => {
      hash.update(chunk);
      hashed += chunk.length;
    });
    const result: VerifyResult = findings.list.length === 0 ? { ok: true } : { ok: false, reasons: findings.list };
    return { result, sha256: hashed === size ? hash.digest("hex") : null, bytes: size };
  } finally {
    await handle.close();
  }
}

export async function verifyRenderedMp4(path: string, expected: VerifyExpected, options: VerifyOptions = {}): Promise<VerifyResult> {
  return (await verifyAndHashMp4(path, expected, options)).result;
}

async function verifyOpenFile(handle: FileHandle, path: string, size: number, expected: VerifyExpected, needles: readonly Needle[], findings: Findings, onChunk: (chunk: Uint8Array) => void): Promise<void> {
  const top = await walkTopLevel(handle, path, size, findings);
  await checkTopLevel(handle, path, top, findings);
  const ftyp = top.find((b) => b.type === "ftyp");
  let ftypBytes: Uint8Array | undefined;
  if (ftyp) {
    if (ftyp.end - ftyp.start > FTYP_MAX_BYTES) findings.add("FTYP_BRAND_NOT_ALLOWED", `ftyp is ${ftyp.end - ftyp.start} bytes, over the ${FTYP_MAX_BYTES}-byte cap`, "ftyp");
    else {
      ftypBytes = await readAt(handle, path, ftyp.start, ftyp.end - ftyp.start);
      checkFtyp(ftypBytes, ftyp.body - ftyp.start, findings);
    }
  }
  const moov = top.find((b) => b.type === "moov");
  const mdat = top.find((b) => b.type === "mdat");
  if (moov) {
    if (moov.end - moov.start > MOOV_MAX_BYTES) {
      findings.add("BOX_TOO_LARGE", `moov is ${moov.end - moov.start} bytes, over the ${MOOV_MAX_BYTES}-byte cap`, "moov");
    } else {
      const bytes = await readAt(handle, path, moov.start, moov.end - moov.start);
      const children = walkNested(bytes, moov.body - moov.start, bytes.length, "moov", MOOV_SCHEMA, findings);
      checkMoov(bytes, children, findings);
      checkStructure(bytes, children, expected.frames, findings);
      if (mdat) checkMediaData(bytes, children, mdat, findings);
      if (ftypBytes && findings.list.length === 0) checkEngineLayout(ftypBytes, bytes, findings);
    }
  }
  const hits = await scanForNeedles(handle, path, size, [...BUILTIN_MARKERS, ...needles], undefined, onChunk);
  for (const hit of hits) findings.add("SOURCE_METADATA_STRING", `${describeNeedle(hit.label)} found at byte ${hit.offset}`);
}

/**
 * ftyp first, exactly one each of ftyp, moov and mdat, at most one `free` and
 * that one empty (ffmpeg writes exactly one, the reserved header of a faststart
 * mdat; several would be several places for a note), and nothing else. A
 * forbidden type gets its own code, not UNKNOWN_BOX.
 */
async function checkTopLevel(handle: FileHandle, path: string, top: readonly TopBox[], findings: Findings): Promise<void> {
  for (const type of ["ftyp", "moov", "mdat"]) {
    const count = top.filter((b) => b.type === type).length;
    if (count === 0) findings.add("MISSING_BOX", `the file has no '${type}' box`, type);
    if (count > 1) findings.add("DUPLICATE_BOX", `the file has ${count} '${type}' boxes`, type);
  }
  const frees = top.filter((b) => b.type === "free").length;
  if (frees > 1) findings.add("DUPLICATE_BOX", `the file has ${frees} 'free' boxes, expected at most one`, "free");
  if (top.some((b) => b.type === "ftyp") && top[0]?.type !== "ftyp") findings.add("FTYP_NOT_FIRST", "ftyp is not the first box", "ftyp");
  const moovAt = top.find((b) => b.type === "moov")?.start;
  const mdatAt = top.find((b) => b.type === "mdat")?.start;
  if (moovAt !== undefined && mdatAt !== undefined && moovAt > mdatAt) findings.add("NOT_FASTSTART", "moov comes after mdat, so the file cannot start playing before it is fully read", "moov");
  for (const b of top) {
    const head = b.type === "uuid" ? await readAt(handle, path, b.body, Math.min(UUID_PAYLOAD_HEAD_BYTES, b.end - b.body)) : new Uint8Array(0);
    const forbidden = forbiddenCode(b.type, head);
    if (forbidden) findings.add(forbidden, `top-level box ${quote(b.type)} at byte ${b.start} is never allowed`, b.type);
    else if (!TOP_LEVEL_ALLOWED.has(b.type)) findings.add("UNKNOWN_BOX", `top-level box ${quote(b.type)} is not allowed`, b.type);
    else if (b.type === "free") await checkFree(handle, path, b, findings);
  }
}

async function checkFree(handle: FileHandle, path: string, box: TopBox, findings: Findings): Promise<void> {
  const length = box.end - box.body;
  const payload = length > FREE_MAX_SCAN_BYTES ? undefined : await readAt(handle, path, box.body, length);
  if (!payload || payload.some((b) => b !== 0)) findings.add("FREE_BOX_NOT_EMPTY", `the free box at byte ${box.start} holds ${length} bytes that are not all zero`, "free");
}

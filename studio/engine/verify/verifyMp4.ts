import { open, stat, type FileHandle } from "node:fs/promises";
import { BUILTIN_MARKERS, forbiddenCode, UUID_PAYLOAD_HEAD_BYTES } from "./allowlist";
import { checkFtyp, checkMoov } from "./checks";
import { checkEngineLayout } from "./engineLayout";
import { Findings, MOOV_MAX_BYTES, MOOV_SCHEMA, readAt, TOP_LEVEL_ALLOWED, walkNested, walkTopLevel, type TopBox } from "./boxes";
import { scanForNeedles, type Needle } from "./scan";
import { checkStructure } from "./structure";
import { MAX_OUTPUT_BYTES, MIN_FORBIDDEN_STRING_BYTES, VerifyIoError, type VerifyExpected, type VerifyOptions, type VerifyResult } from "./types";

// The output verifier (plan slice 3a.7): walks the boxes of a finished MP4 and
// refuses anything but the engine's own output. It returns every reason it
// finds, as stable codes, and throws only when the file cannot be read.

async function sizeOf(path: string): Promise<number> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new VerifyIoError("not_a_file", path);
    return info.size;
  } catch (cause) {
    if (cause instanceof VerifyIoError) throw cause;
    const code = cause instanceof Error ? Reflect.get(cause, "code") : undefined;
    throw new VerifyIoError(code === "ENOENT" ? "not_found" : "read_failed", path, { cause });
  }
}

async function openFile(path: string): ReturnType<typeof open> {
  try {
    return await open(path, "r");
  } catch (cause) {
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
  return label.startsWith(CALLER_LABEL) ? `caller string #${label.slice(CALLER_LABEL.length)}` : `photo-metadata marker '${label}'`;
}

/** A caller mistake, not a property of the file: refused before the file is opened. */
function assertUsable(expected: VerifyExpected): Needle[] {
  if (!Number.isSafeInteger(expected.frames) || expected.frames < 1) throw new RangeError(`expected.frames must be a positive whole number, got ${expected.frames}`);
  return (expected.forbiddenStrings ?? []).map((text, i) => {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length < MIN_FORBIDDEN_STRING_BYTES) throw new RangeError(`forbidden string #${i} is under ${MIN_FORBIDDEN_STRING_BYTES} bytes`);
    return { label: `${CALLER_LABEL}${i}`, bytes };
  });
}

export async function verifyRenderedMp4(path: string, expected: VerifyExpected, options: VerifyOptions = {}): Promise<VerifyResult> {
  const callerNeedles = assertUsable(expected);
  const findings = new Findings();
  const size = await sizeOf(path);
  const maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
  if (size > maxBytes) {
    findings.add("FILE_TOO_LARGE", `${size} bytes is over the ${maxBytes}-byte cap`);
    return { ok: false, reasons: findings.list };
  }

  const handle = await openFile(path);
  try {
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
    if (moov) {
      if (moov.end - moov.start > MOOV_MAX_BYTES) {
        findings.add("BOX_TOO_LARGE", `moov is ${moov.end - moov.start} bytes, over the ${MOOV_MAX_BYTES}-byte cap`, "moov");
      } else {
        const bytes = await readAt(handle, path, moov.start, moov.end - moov.start);
        const children = walkNested(bytes, moov.body - moov.start, bytes.length, "moov", MOOV_SCHEMA, findings);
        checkMoov(bytes, children, findings);
        checkStructure(bytes, children, expected.frames, findings);
        if (ftypBytes && findings.list.length === 0) checkEngineLayout(ftypBytes, bytes, findings);
      }
    }
    const hits = await scanForNeedles(handle, path, size, [...BUILTIN_MARKERS, ...callerNeedles]);
    for (const hit of hits) findings.add("SOURCE_METADATA_STRING", `${describeNeedle(hit.label)} found at byte ${hit.offset}`);
  } finally {
    await handle.close();
  }
  return findings.list.length === 0 ? { ok: true } : { ok: false, reasons: findings.list };
}

/**
 * ftyp first, exactly one each of ftyp, moov and mdat, and nothing else but a
 * `free` that is empty. A forbidden type gets its own code, not UNKNOWN_BOX.
 */
async function checkTopLevel(handle: FileHandle, path: string, top: readonly TopBox[], findings: Findings): Promise<void> {
  for (const type of ["ftyp", "moov", "mdat"]) {
    const count = top.filter((b) => b.type === type).length;
    if (count === 0) findings.add("MISSING_BOX", `the file has no '${type}' box`, type);
    if (count > 1) findings.add("DUPLICATE_BOX", `the file has ${count} '${type}' boxes`, type);
  }
  if (top.some((b) => b.type === "ftyp") && top[0]?.type !== "ftyp") findings.add("FTYP_NOT_FIRST", "ftyp is not the first box", "ftyp");
  const moovAt = top.find((b) => b.type === "moov")?.start;
  const mdatAt = top.find((b) => b.type === "mdat")?.start;
  if (moovAt !== undefined && mdatAt !== undefined && moovAt > mdatAt) findings.add("NOT_FASTSTART", "moov comes after mdat, so the file cannot start playing before it is fully read", "moov");
  for (const b of top) {
    const head = b.type === "uuid" ? await readAt(handle, path, b.body, Math.min(UUID_PAYLOAD_HEAD_BYTES, b.end - b.body)) : new Uint8Array(0);
    const forbidden = forbiddenCode(b.type, head);
    if (forbidden) findings.add(forbidden, `top-level box '${b.type}' at byte ${b.start} is never allowed`, b.type);
    else if (!TOP_LEVEL_ALLOWED.has(b.type)) findings.add("UNKNOWN_BOX", `top-level box '${b.type}' is not allowed`, b.type);
    else if (b.type === "free") await checkFree(handle, path, b, findings);
  }
}

async function checkFree(handle: FileHandle, path: string, box: TopBox, findings: Findings): Promise<void> {
  const length = box.end - box.body;
  const payload = length > FREE_MAX_SCAN_BYTES ? undefined : await readAt(handle, path, box.body, length);
  if (!payload || payload.some((b) => b !== 0)) findings.add("FREE_BOX_NOT_EMPTY", `the free box at byte ${box.start} holds ${length} bytes that are not all zero`, "free");
}

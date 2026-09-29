import { open, stat } from "node:fs/promises";
import { Findings, MOOV_MAX_BYTES, MOOV_SCHEMA, readAt, TOP_LEVEL_ALLOWED, walkNested, walkTopLevel, type TopBox } from "./boxes";
import { MAX_OUTPUT_BYTES, VerifyIoError, type VerifyExpected, type VerifyOptions, type VerifyResult } from "./types";

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

export async function verifyRenderedMp4(path: string, _expected: VerifyExpected, options: VerifyOptions = {}): Promise<VerifyResult> {
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
    checkTopLevel(top, findings);
    const moov = top.find((b) => b.type === "moov");
    if (moov) {
      if (moov.end - moov.start > MOOV_MAX_BYTES) {
        findings.add("BOX_TOO_LARGE", `moov is ${moov.end - moov.start} bytes, over the ${MOOV_MAX_BYTES}-byte cap`, "moov");
      } else {
        const bytes = await readAt(handle, path, moov.start, moov.end - moov.start);
        walkNested(bytes, moov.body - moov.start, bytes.length, "moov", MOOV_SCHEMA, findings);
      }
    }
  } finally {
    await handle.close();
  }
  return findings.list.length === 0 ? { ok: true } : { ok: false, reasons: findings.list };
}

/** ftyp first, exactly one each of ftyp, moov and mdat, and nothing else but free. */
function checkTopLevel(top: readonly TopBox[], findings: Findings): void {
  for (const type of ["ftyp", "moov", "mdat"]) {
    const count = top.filter((b) => b.type === type).length;
    if (count === 0) findings.add("MISSING_BOX", `the file has no '${type}' box`, type);
    if (count > 1) findings.add("DUPLICATE_BOX", `the file has ${count} '${type}' boxes`, type);
  }
  if (top.some((b) => b.type === "ftyp") && top[0]?.type !== "ftyp") findings.add("FTYP_NOT_FIRST", "ftyp is not the first box", "ftyp");
  for (const b of top) if (!TOP_LEVEL_ALLOWED.has(b.type)) findings.add("UNKNOWN_BOX", `top-level box '${b.type}' is not allowed`, b.type);
}

import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { MAX_IMPORT_PHOTO_BYTES } from "../engine/control";
import { errorResponseFor, PROTOCOL_VERSION, type CommandMessage, type EngineError, type ResponseMessage } from "../shared/engine";

// T6c (import an existing avatar), design constraint 1: the renderer never
// sends a path or raw bytes. avatars.pickImportPhoto is answered entirely by
// main: it opens its own native dialog (never handed a path from the
// renderer, exactly like settingsFlow.ts's own pickFolder), reads the picked
// file with a size cap, and hands the bytes to the engine over the control
// channel (engineHost.ts's stageImportPhoto) — never through this command's
// own answer, which only ever carries the staged photo's id and pixel size.

export type ImportPhotoCommand = Extract<CommandMessage, { type: "avatars.pickImportPhoto" }>;

/**
 * 20 MB: generous for a real photo, small enough to bound memory and the
 * control-channel transfer. The engine's own control contract (control.ts's
 * `MAX_IMPORT_PHOTO_BYTES`) enforces the exact same number independently —
 * this is that constant, re-exported under its established name here so
 * nothing here keeps a second copy that could drift from it (L3).
 */
export const MAX_IMPORT_FILE_BYTES = MAX_IMPORT_PHOTO_BYTES;

export interface ImportFlowDeps {
  /** Main's own native open dialog (image filters); null means the user cancelled. */
  pickImportFile(): Promise<string | null>;
  engine: {
    stageImportPhoto(bytes: Uint8Array<ArrayBuffer>): Promise<{ error: EngineError | null; stage?: { stagingId: string; width: number; height: number } }>;
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `avatars.pickImportPhoto`: opens main's dialog, reads the picked file
 * (refusing one over the size cap before it is ever read into memory), and
 * hands its bytes to the engine to validate and stage. A cancelled dialog
 * answers `{ picked: false }`, never an error.
 */
export async function handleImportPhotoCommand(command: ImportPhotoCommand, deps: ImportFlowDeps): Promise<ResponseMessage> {
  const path = await deps.pickImportFile();
  if (path === null) {
    return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { picked: false } };
  }

  // L3: open, then stat the open handle, then read a bounded number of bytes
  // directly — never stat-the-path-then-readFile-it-whole. That older shape
  // is a TOCTOU: the path can name something else by the time it is read,
  // and a FIFO or a character device (e.g. /dev/zero) reports no size a
  // stat on the bare path can be trusted for, so an unbounded read of it can
  // hang forever or exhaust memory. O_NONBLOCK matters even for the open()
  // call itself: opening a FIFO's read end for plain blocking read() waits
  // for a writer to open the other end, before a single check runs. isFile()
  // on the open handle's own stat then rejects anything that is not a plain
  // file before a single byte is read; reading at most MAX+1 bytes (never
  // the whole file at once) bounds peak memory and catches an oversized file
  // without trusting its reported size at all.
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    // Windows has no FIFOs of this kind and no O_NONBLOCK to match; explicit
    // per platform, since `fsConstants.O_NONBLOCK | 0` there only "works" by
    // undefined-coercing to 0 — never something to rely on.
    const fh = await open(path, fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NONBLOCK));
    try {
      const info = await fh.stat();
      if (!info.isFile()) {
        return errorResponseFor(command, { code: "VALIDATION", detail: "the picked path is not a regular file" });
      }
      const buffer = Buffer.alloc(MAX_IMPORT_FILE_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await fh.read(buffer, total, buffer.length - total, null);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > MAX_IMPORT_FILE_BYTES) {
        return errorResponseFor(command, { code: "VALIDATION", detail: `the picked file is larger than ${MAX_IMPORT_FILE_BYTES} bytes` });
      }
      // Uint8Array.from, not `new Uint8Array(buffer)`: it always allocates
      // its own plain ArrayBuffer-backed copy, so this is never typed (or at
      // runtime backed) by Buffer's own pooled/shared allocator.
      bytes = Uint8Array.from(buffer.subarray(0, total));
    } finally {
      await fh.close();
    }
  } catch (error) {
    return errorResponseFor(command, { code: "INTERNAL", detail: `the picked file could not be read: ${describe(error)}` });
  }

  const staged = await deps.engine.stageImportPhoto(bytes);
  if (staged.error !== null) return errorResponseFor(command, staged.error);
  if (staged.stage === undefined) {
    return errorResponseFor(command, { code: "INTERNAL", detail: "the engine accepted the photo but did not stage it" });
  }
  return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { picked: true, ...staged.stage } };
}

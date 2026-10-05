import { posix, win32 } from "node:path";
import { z } from "zod";
import {
  AbsolutePath,
  Count,
  errorResponseFor,
  isUnsafePickedPath,
  MAX_PICKED_FILES,
  MAX_REFUSED_FILES,
  mediaByteCap,
  PROTOCOL_VERSION,
  type CommandMessage,
  type EngineError,
  type MediaPickKind,
  type MediaPickResult,
  type MediaRefusal,
  type MediaUnsupportedReason,
  type PickedFileIdentity,
  type ResponseMessage,
} from "../shared/engine";
import { openRegularNoFollow, UnsafeOpenError, type OpenRegularOps } from "../engine/library/openRegular";
import { pickedIdentityOf } from "../engine/media/identity";
import { isTrustedSender, type SenderFrame, type TrustedRenderer } from "./requests";

// Own media come in through main only (3f.1, invariant 34, K29). The window sends `media.pickImport {kind}` and nothing else, and is
// never told a path. Main opens its own native dialog (per-kind filters, several files), and looks at EACH picked file before the engine
// hears of it:
//   - the path is absolute and is not a Windows device, stream or reserved name;
//   - it is a plain file, not a link, a folder or a device, opened with no symlink following where the platform has the flag;
//   - its size, read from the OPEN HANDLE (never from the path, which can name something else a moment later), is not zero and not over
//     the kind's cap.
// Then the engine is sent the path and the identity main saw, over the control channel (`media.import`). It opens the path once more,
// authoritatively, stages a copy in its own area and hands that copy to the kind's importer. Main's look only saves a round trip and
// pins the identity; the engine's own checks never rest on it.

export type MediaPickCommand = Extract<CommandMessage, { type: "media.pickImport" }>;

export function isMediaPickCommand(command: CommandMessage): command is MediaPickCommand {
  return command.type === "media.pickImport";
}

/** The engine's answer to `media.import`: `error` is null on success with `mediaJobId` set; a refused file carries `mediaReason`. */
export interface MediaImportReply {
  error: EngineError | null;
  mediaJobId?: string | undefined;
  mediaReason?: MediaUnsupportedReason | undefined;
}

export interface MediaImportFlowDeps {
  /** Main's native open dialog for `kind` (several files); null when cancelled. Never handed a path by the window. */
  pickFiles(kind: MediaPickKind): Promise<readonly string[] | null>;
  engine: {
    /** `signal` aborts the copy in flight: the window that asked has closed. */
    importMedia(call: { pick: MediaPickKind; path: string; name: string; expected: PickedFileIdentity }, signal?: AbortSignal): Promise<MediaImportReply>;
  };
  platform: NodeJS.Platform;
  /** Aborted when the window that asked closes: the copy in flight is stopped and the rest of the pick is not started. */
  signal?: AbortSignal | undefined;
  /** The disk calls and `O_NOFOLLOW` of main's look, for a test that plays a swap or Windows. */
  ops?: OpenRegularOps;
  noFollow?: number;
}

const MAX_NAME_UNITS = 120;

/** The file's base name for display: control characters replaced, at most 120 characters, `file` when nothing is left. */
export function displayNameOf(path: string, platform: NodeJS.Platform): string {
  const base = (platform === "win32" ? win32 : posix).basename(path);
  // C0 and C1 controls and the bidi marks, embeddings, overrides and isolates (§ MediaFileName): a name must not read as another.
  // eslint-disable-next-line no-control-regex
  let name = base.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
  if (name.length > MAX_NAME_UNITS) {
    name = name.slice(0, MAX_NAME_UNITS);
    // Never cut a surrogate pair in half.
    const last = name.charCodeAt(name.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) name = name.slice(0, -1);
  }
  return name === "" ? "file" : name;
}

export type Preflight = { ok: true; identity: PickedFileIdentity } | { ok: false; reason: MediaUnsupportedReason };

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && typeof Reflect.get(error, "code") === "string" ? String(Reflect.get(error, "code")) : undefined;
}

/** Main's look at one picked file, before the engine hears of it (see the header). Never throws. */
export async function preflightPickedFile(path: string, kind: MediaPickKind, deps: Pick<MediaImportFlowDeps, "ops" | "noFollow" | "platform">): Promise<Preflight> {
  if (!AbsolutePath.safeParse(path).success || isUnsafePickedPath(path, deps.platform)) return { ok: false, reason: "not-a-file" };
  let handle;
  try {
    handle = await openRegularNoFollow(path, {
      ...(deps.ops === undefined ? {} : { ops: deps.ops }),
      ...(deps.noFollow === undefined ? {} : { noFollow: deps.noFollow }),
    });
  } catch (error) {
    if (error instanceof UnsafeOpenError) return { ok: false, reason: error.code === "ECHANGED" ? "changed" : "not-a-file" };
    const code = errorCode(error);
    return { ok: false, reason: code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" ? "not-a-file" : "unreadable" };
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (info.size === 0n) return { ok: false, reason: "empty" };
    if (info.size > BigInt(mediaByteCap(kind))) return { ok: false, reason: "too-large" };
    return { ok: true, identity: pickedIdentityOf(info) };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** One pick at a time: a second dialog while one is open, or while its files are being copied, is refused. */
let pickInProgress = false;

/**
 * `media.pickImport`: main's dialog, a look at each picked file, and the engine's import of the ones that pass, one after another (a
 * 2 GB copy is not run beside another, and a second pick is refused while this one runs). A cancel is `{ picked: false }`. A refused file is
 * listed by name and reason and the rest still go through, a failed importer or a cancelled copy included. An error that is not about a file
 * (the engine is busy, not running) fails the command only when nothing was done yet; otherwise the jobs already started are kept and
 * that file and the rest are listed as `failed`. Files beyond what one answer lists are counted in `skipped`, never dropped silently.
 */
export async function handleMediaPickCommand(command: MediaPickCommand, deps: MediaImportFlowDeps): Promise<ResponseMessage> {
  if (pickInProgress) return errorResponseFor(command, { code: "IN_FLIGHT", detail: "another import is being picked" });
  pickInProgress = true;
  try {
    return await pickAndImport(command, deps);
  } finally {
    pickInProgress = false;
  }
}

async function pickAndImport(command: MediaPickCommand, deps: MediaImportFlowDeps): Promise<ResponseMessage> {
  const kind = command.payload.kind;
  const picked = await deps.pickFiles(kind);
  if (picked === null || picked.length === 0) return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { picked: false } };
  const outcome = await importPickedPaths(kind, picked, 0, deps);
  if (!outcome.ok) return errorResponseFor(command, outcome.error);
  return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: outcome.result };
}

/** What a pick or a drop came to: the pick's own result, or an error that is not about a file (nothing was done). */
export type PickedOutcome = { ok: true; result: MediaPickResult } | { ok: false; error: EngineError };

/**
 * The paths a pick (main's dialog) or a drop (the preload's `webUtils` paths) named, each looked at by main and then handed to the engine,
 * one after another: the ONE place both go through. `beyond` counts files no path was ever looked at for (a drop's files past what the
 * preload maps), reported as `skipped` with the ones past what the answer lists. See `handleMediaPickCommand` for the rules.
 */
async function importPickedPaths(kind: MediaPickKind, picked: readonly string[], beyond: number, deps: Omit<MediaImportFlowDeps, "pickFiles">, refuseUnopened: (path: string) => boolean = () => false): Promise<PickedOutcome> {
  const jobIds: string[] = [];
  const refused: MediaRefusal[] = [];
  let taken = 0;
  // Once the pick cannot go on (the window closed, the engine failed), every file after it is listed with that reason and not asked for.
  let stopped: "cancelled" | "failed" | null = null;
  const listed = picked.slice(0, MAX_REFUSED_FILES);
  for (const path of listed) {
    const name = displayNameOf(path, deps.platform);
    if (deps.signal?.aborted === true) stopped = "cancelled";
    if (stopped !== null) {
      refused.push({ name, reason: stopped });
      continue;
    }
    if (taken >= MAX_PICKED_FILES) {
      refused.push({ name, reason: "too-many" });
      continue;
    }
    taken++;
    // A path the caller refuses before the disk is touched (a drop's network path on Windows) is not a file it will open.
    if (refuseUnopened(path)) {
      refused.push({ name, reason: "not-a-file" });
      continue;
    }
    const look = await preflightPickedFile(path, kind, deps);
    if (!look.ok) {
      refused.push({ name, reason: look.reason });
      continue;
    }
    const reply = await deps.engine.importMedia({ pick: kind, path, name, expected: look.identity }, deps.signal);
    if (reply.mediaReason !== undefined) {
      refused.push({ name, reason: reply.mediaReason });
    } else if (reply.error === null && reply.mediaJobId !== undefined) {
      jobIds.push(reply.mediaJobId);
    } else {
      // Not about this file. With nothing done there is nothing to lose: the command fails with the error. Otherwise the jobs already started stay.
      if (jobIds.length === 0 && refused.length === 0) {
        return { ok: false, error: reply.error ?? { code: "INTERNAL", detail: "the engine answered the import with neither a job nor a reason" } };
      }
      refused.push({ name, reason: "failed" });
      stopped = "failed";
    }
  }
  return { ok: true, result: { picked: true, jobIds, refused, skipped: picked.length - listed.length + beyond } };
}

// ---------- files dropped onto «Мои» (3f.6 round 2, M13: the owner's decision of 2026-10-04) ----------
// The window hands the preload `File` objects only; the preload maps each to the path Electron gave it (`webUtils.getPathForFile`: a file the
// page built itself has none) and sends the paths here, over a channel of their own. A page cannot forge a path, and cannot reach the channel
// (contextIsolation). Main answers only its app window's own top frame, and then treats the paths exactly as its own dialog's picks.

/** What the preload sends for a drop (preload/dropped.ts): the dropped files' paths (as many as a pick's answer lists), and how many more were dropped. */
const DroppedPayload = z.strictObject({
  paths: z.array(z.string().min(1).max(32_767)).max(MAX_REFUSED_FILES),
  more: Count.max(1_000_000),
});

/**
 * A Windows path that names another machine: `\\host\share`, `//host/share`, `\\?\UNC\host\share` (and a device's `\\.\`). Opening one
 * would make Windows connect to the host and authenticate to it (NTLM), so a DROP never reaches the disk with one (review LOW-1); main's own
 * dialog may still pick from a share the owner browses to. A long local path (`\\?\C:\…`) is local. Off Windows, `//` is a plain `/`.
 */
export function isWindowsRemotePath(path: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  const normal = path.replace(/\//g, "\\");
  return normal.startsWith("\\\\") && !/^\\\\\?\\[A-Za-z]:\\/.test(normal);
}

const DROP_NOT_TRUSTED: EngineError = { code: "VALIDATION", detail: "the drop did not come from the app's own window" };

/**
 * Files dropped onto the «Мои» drop zone: the sender's frame first (the app window's own top frame showing the app's page), the payload's
 * shape, then the same path a pick takes (`importPickedPaths`, kind `any`), one pick or drop at a time. Never throws.
 */
export async function handleDroppedMedia(raw: unknown, frame: SenderFrame, trusted: TrustedRenderer, deps: Omit<MediaImportFlowDeps, "pickFiles">): Promise<PickedOutcome> {
  if (!isTrustedSender(frame, trusted)) return { ok: false, error: DROP_NOT_TRUSTED };
  const parsed = DroppedPayload.safeParse(raw);
  if (!parsed.success) return { ok: false, error: { code: "VALIDATION", detail: "a drop is the preload's paths and a count" } };
  const { paths, more } = parsed.data;
  if (paths.length === 0 && more === 0) return { ok: true, result: { picked: false } };
  if (pickInProgress) return { ok: false, error: { code: "IN_FLIGHT", detail: "another import is being picked" } };
  pickInProgress = true;
  try {
    return await importPickedPaths("any", paths, more, deps, (path) => isWindowsRemotePath(path, deps.platform));
  } catch {
    return { ok: false, error: { code: "INTERNAL", detail: "main failed to import the dropped files" } };
  } finally {
    pickInProgress = false;
  }
}

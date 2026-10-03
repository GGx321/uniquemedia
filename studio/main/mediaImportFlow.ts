import { posix, win32 } from "node:path";
import {
  AbsolutePath,
  errorResponseFor,
  MAX_PICKED_FILES,
  MAX_REFUSED_FILES,
  mediaByteCap,
  PROTOCOL_VERSION,
  type CommandMessage,
  type EngineError,
  type MediaPickKind,
  type MediaRefusal,
  type MediaUnsupportedReason,
  type ResponseMessage,
} from "../shared/engine";
import { openRegularNoFollow, UnsafeOpenError, type FileIdentity, type OpenRegularOps } from "../engine/library/openRegular";

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
    importMedia(call: { pick: MediaPickKind; path: string; name: string; expected: FileIdentity }): Promise<MediaImportReply>;
  };
  platform: NodeJS.Platform;
  /** The disk calls and `O_NOFOLLOW` of main's look, for a test that plays a swap or Windows. */
  ops?: OpenRegularOps;
  noFollow?: number;
}

const MAX_NAME_UNITS = 120;

/** The file's base name for display: control characters replaced, at most 120 characters, `file` when nothing is left. */
export function displayNameOf(path: string, platform: NodeJS.Platform): string {
  const base = (platform === "win32" ? win32 : posix).basename(path);
  // eslint-disable-next-line no-control-regex
  let name = base.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (name.length > MAX_NAME_UNITS) {
    name = name.slice(0, MAX_NAME_UNITS);
    // Never cut a surrogate pair in half.
    const last = name.charCodeAt(name.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) name = name.slice(0, -1);
  }
  return name === "" ? "file" : name;
}

const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * True for a path Windows would not read as a plain file: the device namespace (`\\.\COM1`, `\\.\pipe\x`, `\\?\GLOBALROOT\...`), a name
 * with an alternate data stream (`a.jpg:secret`), and a reserved device name (`CON`, `nul.txt`, `COM1`). Read by Windows' rules on any
 * platform so it is tested everywhere; false on every other platform, where a colon and `CON` are ordinary.
 */
export function isUnsafePickedPath(path: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  const normal = path.replace(/\//g, "\\");
  if (normal.startsWith("\\\\.\\")) return true;
  let rest = normal;
  if (normal.startsWith("\\\\?\\")) {
    rest = normal.slice(4);
    if (/^UNC\\/i.test(rest)) rest = rest.slice(4);
    else if (/^[A-Za-z]:\\/.test(rest)) rest = rest.slice(2);
    else return true;
  } else if (/^[A-Za-z]:/.test(normal)) {
    rest = normal.slice(2);
  }
  if (rest.includes(":")) return true;
  // The drive-relative and UNC roots have no name of a device in them; every other segment is a name Windows may read as one.
  return rest.split("\\").some((segment) => RESERVED_DEVICE_NAME.test(segment.split(".")[0]?.trimEnd() ?? ""));
}

export type Preflight = { ok: true; identity: FileIdentity } | { ok: false; reason: MediaUnsupportedReason };

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
    return { ok: true, identity: { dev: String(info.dev), ino: String(info.ino) } };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * `media.pickImport`: main's dialog, a look at each picked file, and the engine's import of the ones that pass, one after another (a
 * 2 GB copy is not run beside another). A cancel is `{ picked: false }`. A refused file is listed by name and reason and the rest still go
 * through; an error that is not about a file (the engine is busy, not running) fails the whole command with that error.
 */
export async function handleMediaPickCommand(command: MediaPickCommand, deps: MediaImportFlowDeps): Promise<ResponseMessage> {
  const kind = command.payload.kind;
  const picked = await deps.pickFiles(kind);
  if (picked === null || picked.length === 0) return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { picked: false } };

  const jobIds: string[] = [];
  const refused: MediaRefusal[] = [];
  let taken = 0;
  for (const path of picked.slice(0, MAX_REFUSED_FILES)) {
    const name = displayNameOf(path, deps.platform);
    if (taken >= MAX_PICKED_FILES) {
      refused.push({ name, reason: "too-many" });
      continue;
    }
    taken++;
    const look = await preflightPickedFile(path, kind, deps);
    if (!look.ok) {
      refused.push({ name, reason: look.reason });
      continue;
    }
    const reply = await deps.engine.importMedia({ pick: kind, path, name, expected: look.identity });
    if (reply.error !== null && reply.mediaReason === undefined) return errorResponseFor(command, reply.error);
    if (reply.mediaReason !== undefined) refused.push({ name, reason: reply.mediaReason });
    else if (reply.mediaJobId !== undefined) jobIds.push(reply.mediaJobId);
    else return errorResponseFor(command, { code: "INTERNAL", detail: "the engine answered the import with neither a job nor a reason" });
  }
  return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { picked: true, jobIds, refused } };
}

import { posix, win32 } from "node:path";
import { errorResponseFor, EXPORT_CHANGING_DETAIL, isSafeName, PROTOCOL_VERSION, RelativePath, type CommandMessage, type EngineCommandMessage, type ResponseMessage, type VideoSummary } from "../shared/engine";

// «Открыть в папке» (3d.6): `videos.reveal {videoId}`, and «Папка «Готовые видео»» (3e.2, K17): `videos.revealFolder {avatarId}`.
// Only main can open the system file manager, and the window names an id and nothing else. Main reads the place itself from the
// engine's own read-only answers (`videos.get` by id: one question, never a listing, so a video past `videos.list`'s bound is
// found too; `videos.list` and `export.check` for an avatar's folder), joins the record's relative path to the CURRENT export
// folder, and opens it. The relative path is the contract's allow-list shape, checked again here, so the joined path can never
// leave the export folder.

export type RevealCommand = Extract<CommandMessage, { type: "videos.reveal" }>;
export type RevealFolderCommand = Extract<CommandMessage, { type: "videos.revealFolder" }>;

export function isRevealCommand(command: CommandMessage): command is RevealCommand {
  return command.type === "videos.reveal";
}

export function isRevealFolderCommand(command: CommandMessage): command is RevealFolderCommand {
  return command.type === "videos.revealFolder";
}

export interface RevealFlowDeps {
  engine: { request(command: EngineCommandMessage): Promise<ResponseMessage> };
  /** The export folder as main saved it. */
  exportPath(): string;
  /** `shell.showItemInFolder`. */
  show(path: string): void;
  newId(): string;
  platform: NodeJS.Platform;
}

export interface RevealFolderFlowDeps {
  engine: { request(command: EngineCommandMessage): Promise<ResponseMessage> };
  exportPath(): string;
  /** `shell.openPath`: resolves "" when the folder opened, else the file manager's own error text (never passed on). */
  openFolder(path: string): Promise<string>;
  /** Whether `path` is a real folder (a link is not followed, so a link is not one). */
  isFolder(path: string): Promise<boolean>;
  newId(): string;
  platform: NodeJS.Platform;
}

const apiOf = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** The place of a video's file: the record's relative path under `root`, or null when it would not stay inside it. */
export function placeOf(root: string, relPath: string, platform: NodeJS.Platform): string | null {
  if (!RelativePath.safeParse(relPath).success) return null;
  const api = apiOf(platform);
  if (!api.isAbsolute(root)) return null;
  const place = api.join(root, ...relPath.split("/"));
  const inside = api.relative(root, place);
  return inside === "" || inside.startsWith("..") || api.isAbsolute(inside) ? null : place;
}

/** An avatar's folder under `root`, from the first segment of a record's relative path; null for one that is not the record shape. */
function folderOf(root: string, relPath: string, platform: NodeJS.Platform): string | null {
  if (placeOf(root, relPath, platform) === null) return null;
  const name = relPath.slice(0, relPath.indexOf("/"));
  return isSafeName(name) ? apiOf(platform).join(root, name) : null;
}

export async function handleRevealCommand(command: RevealCommand, deps: RevealFlowDeps): Promise<ResponseMessage> {
  // The record is judged against this folder: a switch while it was read makes the answer about another one.
  const root = deps.exportPath();
  const answer = await deps.engine.request({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "command", type: "videos.get", payload: { videoId: command.payload.videoId } });
  if (!answer.ok) return errorResponseFor(command, answer.error);
  if (answer.type !== "videos.get") return errorResponseFor(command, { code: "INTERNAL", detail: "the engine answered the video with something else" });
  const video = answer.result.video;
  if (video.fileState !== "present") return errorResponseFor(command, { code: "NOT_FOUND", detail: `the video's file is not in the export folder (${video.fileState})` });
  if (deps.exportPath() !== root) return errorResponseFor(command, { code: "IN_FLIGHT", detail: EXPORT_CHANGING_DETAIL });
  const place = placeOf(root, video.relPath, deps.platform);
  if (place === null) return errorResponseFor(command, { code: "INTERNAL", detail: "the video's place is not inside the export folder" });
  deps.show(place);
  return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { videoId: video.videoId } };
}

/** The states of a record whose file lives (or lived) in the CURRENT export folder: its folder name is this root's. */
const IN_THIS_ROOT: ReadonlySet<VideoSummary["fileState"]> = new Set(["present", "missing", "changed"]);

export async function handleRevealFolderCommand(command: RevealFolderCommand, deps: RevealFolderFlowDeps): Promise<ResponseMessage> {
  const root = deps.exportPath();
  const check = await deps.engine.request({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "command", type: "export.check", payload: {} });
  if (!check.ok) return errorResponseFor(command, check.error);
  if (check.type !== "export.check") return errorResponseFor(command, { code: "INTERNAL", detail: "the engine answered the export check with something else" });
  if (check.result.exportStatus.status === "unavailable") return errorResponseFor(command, { code: "EXPORT_UNAVAILABLE", exportReason: check.result.exportStatus.reason });
  const listed = await deps.engine.request({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "command", type: "videos.list", payload: { avatarId: command.payload.avatarId } });
  if (!listed.ok) return errorResponseFor(command, listed.error);
  if (listed.type !== "videos.list") return errorResponseFor(command, { code: "INTERNAL", detail: "the engine answered the videos with something else" });
  // The newest video of this export folder names the avatar's folder in it (its name may carry a suffix the avatar's name does not).
  const own = listed.result.videos.find((v) => IN_THIS_ROOT.has(v.fileState));
  const candidate = own === undefined ? null : folderOf(root, own.relPath, deps.platform);
  const folder = candidate !== null && (await deps.isFolder(candidate)) ? candidate : null;
  if (deps.exportPath() !== root) return errorResponseFor(command, { code: "IN_FLIGHT", detail: EXPORT_CHANGING_DETAIL });
  const failure = await deps.openFolder(folder ?? root);
  // The file manager's text names the path: only a fixed sentence travels.
  if (failure !== "") return errorResponseFor(command, { code: "INTERNAL", detail: "the folder could not be opened" });
  return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { opened: folder === null ? "root" : "avatar" } };
}

import { posix, win32 } from "node:path";
import { errorResponseFor, PROTOCOL_VERSION, RelativePath, type CommandMessage, type EngineCommandMessage, type EngineError, type ResponseMessage } from "../shared/engine";

// «Открыть в папке» (3d.6): `videos.reveal {videoId}`. Only main can open the system file manager, and the window names a
// video id and nothing else. Main finds the record itself (the engine's own `avatars.list` and `videos.list`: no command
// of the engine turns a video id into a place), joins its relative path to the CURRENT export folder, and shows the file
// only when the record says it is `present` there. The relative path is the contract's allow-list shape, checked again
// here, so the joined path can never leave the export folder.

export type RevealCommand = Extract<CommandMessage, { type: "videos.reveal" }>;

export function isRevealCommand(command: CommandMessage): command is RevealCommand {
  return command.type === "videos.reveal";
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

/** The place of a video's file: the record's relative path under `root`, or null when it would not stay inside it. */
function placeOf(root: string, relPath: string, platform: NodeJS.Platform): string | null {
  if (!RelativePath.safeParse(relPath).success) return null;
  const api = platform === "win32" ? win32 : posix;
  if (!api.isAbsolute(root)) return null;
  const place = api.join(root, ...relPath.split("/"));
  const inside = api.relative(root, place);
  return inside === "" || inside.startsWith("..") || api.isAbsolute(inside) ? null : place;
}

export async function handleRevealCommand(command: RevealCommand, deps: RevealFlowDeps): Promise<ResponseMessage> {
  const avatars = await deps.engine.request({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "command", type: "avatars.list", payload: {} });
  if (!avatars.ok) return errorResponseFor(command, avatars.error);
  if (avatars.type !== "avatars.list") return errorResponseFor(command, { code: "INTERNAL", detail: "the engine answered the avatars with something else" });

  let skipped: EngineError | null = null;
  for (const avatar of avatars.result.avatars) {
    const listed = await deps.engine.request({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "command", type: "videos.list", payload: { avatarId: avatar.avatarId } });
    if (!listed.ok) {
      skipped ??= listed.error;
      continue;
    }
    if (listed.type !== "videos.list") continue;
    const video = listed.result.videos.find((v) => v.videoId === command.payload.videoId);
    if (video === undefined) continue;
    if (video.fileState !== "present") {
      return errorResponseFor(command, { code: "NOT_FOUND", detail: `the video's file is not in the export folder (${video.fileState})` });
    }
    const place = placeOf(deps.exportPath(), video.relPath, deps.platform);
    if (place === null) return errorResponseFor(command, { code: "INTERNAL", detail: "the video's place is not inside the export folder" });
    deps.show(place);
    return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { videoId: video.videoId } };
  }
  // A list that failed may have held the video: say that, rather than "no such video".
  if (skipped !== null && skipped.code !== "NOT_FOUND") return errorResponseFor(command, skipped);
  return errorResponseFor(command, { code: "NOT_FOUND", detail: `no video ${command.payload.videoId}` });
}

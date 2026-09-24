import type { CommandMessage, EventMessage, ResponseMessage } from "../shared/engine";

/** IPC channel names shared by Studio's main process and preload. */
export const CH = {
  version: "studio:version",
  /** renderer → main (`ipcRenderer.invoke`): one T0 command, answered with its T0 response. */
  request: "studio:request",
  /** main → renderer (`webContents.send`): T0 engine events. */
  event: "studio:event",
} as const;

/**
 * The bridge the preload exposes to the renderer as `window.studio`, and
 * nothing else. Main validates every command against the T0 contract and
 * checks it comes from the app's own top frame; responses and events are
 * validated by main before they are delivered. The API key goes in through
 * `settings.setApiKey` and never comes back: responses carry only its status.
 */
export interface StudioApi {
  /** Sends one command (engine commands and the main-only key commands alike). Never rejects for an engine error: it resolves with an error response. */
  request(command: CommandMessage): Promise<ResponseMessage>;
  /** Calls `listener` for every engine event; returns the function that stops it. */
  subscribe(listener: (event: EventMessage) => void): () => void;
  /** Studio's own version (studio/version.json), not the uniquifier's. */
  version(): Promise<string>;
}

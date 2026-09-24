/** IPC channel names shared by Studio's main process and preload. */
export const CH = {
  version: "studio:version",
} as const;

/** The bridge the preload exposes to the renderer as `window.studio`. */
export interface StudioApi {
  /** Studio's own version (studio/version.json), not the uniquifier's. */
  version(): Promise<string>;
}

import type { StudioApi } from "../preload/api";

declare global {
  interface Window {
    studio: StudioApi;
  }
}

declare module "react" {
  interface CSSProperties {
    /** A range input's thumb position, 0–1: ui.css paints the track's filled part up to it. */
    "--range-fill"?: number;
  }
}

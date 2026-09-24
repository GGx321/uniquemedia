import type { StudioApi } from "../preload/api";

declare global {
  interface Window {
    studio: StudioApi;
  }
}

import type { Api } from "../../electron/ipc";

declare global {
  interface Window {
    api: Api;
  }
}

export const api: Api = window.api;

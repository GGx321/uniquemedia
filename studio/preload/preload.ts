import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { EventMessage } from "../shared/engine";
import { CH, type StudioApi } from "./api";

const studio: StudioApi = {
  request: (command) => ipcRenderer.invoke(CH.request, command),
  subscribe: (listener) => {
    // The IpcRendererEvent stays here: the renderer gets the event payload only.
    const forward = (_event: IpcRendererEvent, message: EventMessage) => listener(message);
    ipcRenderer.on(CH.event, forward);
    return () => {
      ipcRenderer.removeListener(CH.event, forward);
    };
  },
  version: () => ipcRenderer.invoke(CH.version),
};

contextBridge.exposeInMainWorld("studio", studio);

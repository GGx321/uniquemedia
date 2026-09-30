import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { EventMessage } from "../shared/engine";
import { CH, type StudioApi } from "./api";

/** What the window saves before a quit (the montage editor's pending edit); main waits for them, bounded. */
const flushHandlers = new Set<() => Promise<void>>();

ipcRenderer.on(CH.flushRequest, (_event: IpcRendererEvent, id: unknown) => {
  if (typeof id !== "string") return;
  // Every handler settles, whatever it answers: a failed save is the window's to show, not a reason to stall the quit.
  void Promise.allSettled([...flushHandlers].map((handler) => handler())).then(() => ipcRenderer.send(CH.flushDone, id));
});

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
  onFlushRequest: (handler) => {
    flushHandlers.add(handler);
    return () => {
      flushHandlers.delete(handler);
    };
  },
};

contextBridge.exposeInMainWorld("studio", studio);

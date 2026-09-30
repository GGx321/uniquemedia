import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { EventMessage } from "../shared/engine";
import { CH, type StudioApi } from "./api";

/** What the window saves before a quit (the montage editor's pending edit); each answers whether it saved. */
const flushHandlers = new Set<() => Promise<boolean>>();

ipcRenderer.on(CH.flushRequest, (_event: IpcRendererEvent, id: unknown) => {
  if (typeof id !== "string") return;
  // A handler that throws did not save. The answer goes back whatever happened: main decides whether the quit goes on.
  void Promise.all([...flushHandlers].map((handler) => handler().then((saved) => saved === true, () => false))).then((saved) =>
    ipcRenderer.send(CH.flushDone, { id, ok: saved.every(Boolean) }),
  );
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
  quitWithoutSaving: () => ipcRenderer.send(CH.quitWithoutSaving),
};

contextBridge.exposeInMainWorld("studio", studio);

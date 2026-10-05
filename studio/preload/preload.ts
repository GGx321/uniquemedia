import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { EventMessage } from "../shared/engine";
import { CH, type StudioApi } from "./api";
import { dropBridge } from "./dropBridge";
import { trustedDropGate } from "./dropGate";

/** 3f.6 round 2 (MEDIUM-2): the last drop the browser itself made on this window; `importDropped` takes only its files, once, within 10 s. */
const dropGate = trustedDropGate(window);

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
  // 3f.6 round 2 (M13): `File` objects in (only the last trusted drop's own, once), the paths Electron knows for them out to main; the page
  // never names a path. Round 3: the bridge is built and tested in dropBridge.ts; preload.test.ts pins this wiring.
  importDropped: dropBridge(ipcRenderer, dropGate, webUtils),
};

contextBridge.exposeInMainWorld("studio", studio);

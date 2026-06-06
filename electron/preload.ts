import { contextBridge, ipcRenderer } from "electron";
import { CH, type Api } from "./ipc";

const api: Api = {
  pickFile: () => ipcRenderer.invoke(CH.pickFile),
  probe: (path) => ipcRenderer.invoke(CH.probe, path),
  chooseOutDir: () => ipcRenderer.invoke(CH.chooseOutDir),
  start: (req) => ipcRenderer.invoke(CH.start, req),
  cancel: () => ipcRenderer.invoke(CH.cancel),
  openFile: (path) => ipcRenderer.invoke(CH.openFile, path),
  revealInFolder: (path) => ipcRenderer.invoke(CH.reveal, path),
  onBatchProgress: (cb) => ipcRenderer.on(CH.evtProgress, (_e, p) => cb(p)),
  onCopyDone: (cb) => ipcRenderer.on(CH.evtCopyDone, (_e, c) => cb(c)),
  onBatchDone: (cb) => ipcRenderer.on(CH.evtBatchDone, (_e, s) => cb(s)),
  onError: (cb) => ipcRenderer.on(CH.evtError, (_e, x) => cb(x)),
};

contextBridge.exposeInMainWorld("api", api);

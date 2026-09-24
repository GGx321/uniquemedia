import { contextBridge, ipcRenderer } from "electron";
import { CH, type StudioApi } from "../shared/ipc";

const studio: StudioApi = {
  version: () => ipcRenderer.invoke(CH.version),
};

contextBridge.exposeInMainWorld("studio", studio);

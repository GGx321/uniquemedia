// 3f.6 round 3 (the drag-and-drop security review, LOW): the preload's `importDropped`, built here apart from Electron so a test can hand it a
// fake `ipcRenderer`, a fake `webUtils` and a fake gate. preload.ts only wires the real ones in (pinned by preload.test.ts).

import { CH } from "./api";
import type { DropGate } from "./dropGate";
import { droppedFiles, type PathSource } from "./dropped";

/** Electron's `ipcRenderer`, as far as the bridge uses it. */
export interface DropInvoker {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * The bridge's `importDropped`: the asked files go through `gate` first (only the last trusted drop's own objects, once), then each that is left
 * is mapped to the path the OS gave it (`source`, Electron's `webUtils`), and only those paths go to main.
 */
export function dropBridge(ipc: DropInvoker, gate: DropGate, source: PathSource): (files: File[]) => Promise<unknown> {
  return (files) => ipc.invoke(CH.importDropped, droppedFiles(gate.take(files), source));
}

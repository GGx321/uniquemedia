import { createEngineClient, type EngineBridge, type EngineClient } from "./client";

// `window.studio` is typed by the preload's current `StudioApi`, which grows as
// T1 lands. Everything here reads it as `unknown` and checks each function at
// runtime, so the renderer works with an older preload, a newer one, or none
// (a plain browser against the vite dev server).

function studioObject(): object | null {
  const studio: unknown = Reflect.get(globalThis, "studio");
  return typeof studio === "object" && studio !== null ? studio : null;
}

function method(target: object, name: string): ((...args: unknown[]) => unknown) | null {
  const fn: unknown = Reflect.get(target, name);
  if (typeof fn !== "function") return null;
  return (...args: unknown[]): unknown => Reflect.apply(fn, target, args);
}

/** The engine bridge from the preload, or null while `window.studio.request` is missing. */
export function readWindowBridge(): EngineBridge | null {
  const studio = studioObject();
  if (!studio) return null;
  const request = method(studio, "request");
  const subscribe = method(studio, "subscribe");
  if (!request || !subscribe) return null;
  return {
    request: async (command) => await request(command),
    subscribe: (listener) => {
      const off = subscribe(listener);
      return typeof off === "function" ? () => void Reflect.apply(off, undefined, []) : () => {};
    },
  };
}

/** The real engine client, or null when the preload does not expose one yet. */
export function windowStudioClient(): EngineClient | null {
  const bridge = readWindowBridge();
  return bridge ? createEngineClient(bridge, "window") : null;
}

/**
 * Hands `handler` to the preload: main calls it before quitting and waits (bounded) for its answer, so an edit still
 * inside its autosave wait is saved first (3d.2 review, HIGH 2); `false` (not saved) cancels the quit before the
 * engine is shut down (the re-review). A no-op without a bridge that offers it.
 */
export function onFlushRequest(handler: () => Promise<boolean>): () => void {
  const studio = studioObject();
  const register = studio ? method(studio, "onFlushRequest") : null;
  if (!register) return () => {};
  const off = register(handler);
  return typeof off === "function" ? () => void Reflect.apply(off, undefined, []) : () => {};
}

/** Asks main to quit although this window could not save (the owner's «Выйти без сохранения»); a no-op without a bridge. */
export function quitWithoutSaving(): void {
  const studio = studioObject();
  const quit = studio ? method(studio, "quitWithoutSaving") : null;
  if (quit) quit();
}

/** Studio's version from the preload; rejects when there is no bridge or it fails. */
export async function readStudioVersion(): Promise<string> {
  const studio = studioObject();
  const version = studio ? method(studio, "version") : null;
  if (!version) throw new Error("window.studio.version is missing");
  const value: unknown = await version();
  if (typeof value !== "string") throw new Error("window.studio.version returned a non-string");
  return value;
}

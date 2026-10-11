// Test helpers: the App wired to the mock engine on a manual clock.
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { CommandMessage, CommandType } from "../shared/engine";
import { App } from "./App";
import { MockEngine, type MockEngineOptions, mockEngineClient } from "./engine/mockEngine";
import { ManualScheduler } from "./engine/scheduler";
import { SCENE_REVIEW_KEY } from "./screens/photos/sceneReview";

/**
 * CS.6: the «Сцены на проверку» switch is remembered in localStorage, which every test of a run shares: each setup starts from the owner's default (ON,
 * nothing stored) unless it asks for a position. A test of today's path (the run writes its own scenes) asks for `sceneReview: "off"`.
 */
export interface SetupOptions extends MockEngineOptions {
  sceneReview?: "on" | "off";
  /** A manual clock for the photo lists' re-read wait (returned as `pagesScheduler`); without it the wait runs on real timers. */
  pagesScheduler?: ManualScheduler;
}

export function setup({ sceneReview, pagesScheduler, ...options }: SetupOptions = {}) {
  try {
    if (sceneReview === undefined) localStorage.removeItem(SCENE_REVIEW_KEY);
    else localStorage.setItem(SCENE_REVIEW_KEY, sceneReview);
  } catch {
    // No storage in this environment: the switch reads ON.
  }
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, latencyMs: 0, ...options });
  const client = mockEngineClient(engine);
  const utils = render(<App client={client} pagesScheduler={pagesScheduler} />);
  return { engine, scheduler, pagesScheduler, client, ...utils };
}

export function callsOf<T extends CommandType>(engine: MockEngine, type: T): Extract<CommandMessage, { type: T }>[] {
  return engine.calls.filter((c): c is Extract<CommandMessage, { type: T }> => c.type === type);
}

/** Runs timers (job progress) inside act, so React sees the events. */
export function tick(scheduler: ManualScheduler, steps = 1): void {
  act(() => {
    for (let i = 0; i < steps; i++) scheduler.next();
  });
}

/** Mock-engine actions that emit events must run inside act, like any other state change. */
export function inAct(fn: () => void): void {
  act(fn);
}

export function runAll(scheduler: ManualScheduler): void {
  act(() => scheduler.runAll());
}

/** Lets pending promise chains (mock responses) settle inside act. */
export async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

export async function openSection(label: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: label }));
  await flush();
}

/** From the Avatars screen (empty or not) into a fresh wizard. */
export async function openWizard(): Promise<void> {
  const button =
    (await screen.findAllByRole("button", { name: /Новый аватар|Создать первый аватар/ })).at(0) ?? null;
  if (!button) throw new Error("no «Новый аватар» button");
  fireEvent.click(button);
  await screen.findByRole("heading", { level: 1, name: "Новый аватар" });
}

/** The estimate as shown: its limit, then the expected cost — "до $0.23 · ожидаемая ≈ $0.21"; null while there is none. */
export function estimateText(): string | null {
  const worst = document.querySelector(".estimate-worst")?.textContent;
  const expected = document.querySelector(".estimate-expected")?.textContent;
  return worst && expected ? `${worst} · ${expected}` : null;
}

/**
 * A getByText matcher on an element's whole text, markup inside it included
 * (a price set in mono inside a sentence), matching the innermost element
 * that still holds all of it.
 */
export function withText(pattern: RegExp): (content: string, element: Element | null) => boolean {
  return (_, element) =>
    element !== null && pattern.test(element.textContent ?? "") && Array.from(element.children).every((child) => !pattern.test(child.textContent ?? ""));
}

/** A short, printable identity for an element, so a focus assertion fails with a readable diff instead of a DOM dump. */
export function describeElement(el: Element | null): string {
  if (!el) return "(nothing)";
  const name = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? "";
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} «${name}»`;
}

export function focusedLabel(): string {
  return describeElement(document.activeElement);
}

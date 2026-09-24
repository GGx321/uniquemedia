// Test helpers: the App wired to the mock engine on a manual clock.
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { CommandMessage, CommandType } from "../shared/engine";
import { App } from "./App";
import { MockEngine, type MockEngineOptions, mockEngineClient } from "./engine/mockEngine";
import { ManualScheduler } from "./engine/scheduler";

export function setup(options: MockEngineOptions = {}) {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, latencyMs: 0, ...options });
  const client = mockEngineClient(engine);
  const utils = render(<App client={client} />);
  return { engine, scheduler, client, ...utils };
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

export function estimateText(): string | null {
  return document.querySelector(".estimate-figure")?.textContent ?? null;
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

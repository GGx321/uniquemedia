import { render, screen } from "@testing-library/react";
import type { CommandMessage, ResponseMessage } from "../../../shared/engine";
import { App } from "../../App";
import { MockEngine, type MockEngineOptions, mockEngineClient } from "../../engine/mockEngine";
import { ManualScheduler } from "../../engine/scheduler";
import { flush, openSection } from "../../testing";
import { MIA } from "./categoryScreenKit";
import { SCENE_REVIEW_KEY } from "./sceneReview";

// S5.6e screen tests' kit: the price of the scenes' writer is set by the test, so no test here depends on what the mock engine charges for a chunk (the
// template writes built-in scenes for nothing; the model's price stays where a model writes).

/** The mock engine, with the writer's price set by the test: `scenes.estimateCompose` and `scenes.estimateWrite` answer it, everything else is the mock's. */
export class WriterPricedEngine extends MockEngine {
  writerWorstMicros = 0;

  override async request(command: CommandMessage): Promise<ResponseMessage> {
    const response = await super.request(command);
    if (!response.ok || (response.type !== "scenes.estimateCompose" && response.type !== "scenes.estimateWrite")) return response;
    const worst = this.writerWorstMicros;
    const result = { estimate: { expectedMicros: Math.round(worst / 8), worstMicros: worst, prices: "fallback" as const, pricesAsOf: "2026-10-11" } };
    return { ...response, result };
  }
}

/** The options every engine of these tests starts from: Mia, a manual clock, no latency; the test's own after them. */
export function writerPricedOptions(options: MockEngineOptions = {}): MockEngineOptions {
  return { scheduler: new ManualScheduler(), latencyMs: 0, avatars: [MIA], ...options };
}

/** Mia's Photos screen on `engine`, with «Сцены на проверку» as asked. */
export async function showPhotos(engine: MockEngine, review: "on" | "off"): Promise<void> {
  localStorage.setItem(SCENE_REVIEW_KEY, review);
  render(<App client={mockEngineClient(engine)} />);
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  await openSection("Фото");
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  await flush();
}

/** Mia's Photos screen on a `WriterPricedEngine` whose writer costs `writerWorstMicros`, with «Сцены на проверку» as asked. */
export async function openWriterPriced(writerWorstMicros: number, review: "on" | "off", options: MockEngineOptions = {}) {
  const engine = new WriterPricedEngine(writerPricedOptions(options));
  engine.writerWorstMicros = writerWorstMicros;
  await showPhotos(engine, review);
  return engine;
}

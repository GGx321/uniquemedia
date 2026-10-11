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
    if ((command.type !== "scenes.estimateCompose" && command.type !== "scenes.estimateWrite") || !response.ok) return response;
    const worst = this.writerWorstMicros;
    return { ...response, result: { estimate: { expectedMicros: Math.round(worst / 8), worstMicros: worst, prices: "fallback", pricesAsOf: "2026-10-11" } } };
  }
}

/** Mia's Photos screen on a `WriterPricedEngine` whose writer costs `writerWorstMicros`, with «Сцены на проверку» as asked. */
export async function openWriterPriced(writerWorstMicros: number, review: "on" | "off", options: MockEngineOptions = {}) {
  localStorage.setItem(SCENE_REVIEW_KEY, review);
  const engine = new WriterPricedEngine({ scheduler: new ManualScheduler(), latencyMs: 0, avatars: [MIA], ...options });
  engine.writerWorstMicros = writerWorstMicros;
  render(<App client={mockEngineClient(engine)} />);
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  await openSection("Фото");
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  await flush();
  return engine;
}

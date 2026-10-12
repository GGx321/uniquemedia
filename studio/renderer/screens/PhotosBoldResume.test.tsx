import { describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { PRICE_SCOPES_RU } from "../../shared/engine";
import { errorText } from "../lib/errors";
import { openSection, setup } from "../testing";
import { MIA } from "./photos/categoryScreenKit";

// S5.R4-fix: a stopped run's resume row, refused a price for the 2K tier alone, says state 55's sentence like every other «Смелая» price column does.

describe("a stopped run's resume row (state 55)", () => {
  test("a resume estimate refused for the 2K tier alone says state 55's warning, never the general price text", async () => {
    const { engine } = setup({ avatars: [MIA] });
    engine.seedRun({ avatarId: MIA.avatarId, count: 12, categories: ["nightwear"], level: "bold", poses: { profile: false, back: false } }, 8);
    engine.failNext("runs.estimateResume", { code: "PRICE_UNAVAILABLE", priceScope: "bold", detail: "the price list has no 2K tier" });
    await openSection("Фото");
    const notice = await screen.findByText(PRICE_SCOPES_RU.bold);
    expect(notice.closest(".notice")?.classList.contains("notice-warn")).toBe(true);
    expect(screen.queryByText(errorText({ code: "PRICE_UNAVAILABLE" })) === null).toBe(true);
  });

  test("a resume estimate refused without a price scope keeps the general price text", async () => {
    const { engine } = setup({ avatars: [MIA] });
    engine.seedRun({ avatarId: MIA.avatarId, count: 12, categories: ["nightwear"], level: "bold", poses: { profile: false, back: false } }, 8);
    engine.failNext("runs.estimateResume", { code: "PRICE_UNAVAILABLE", detail: "no price" });
    await openSection("Фото");
    await screen.findByText(errorText({ code: "PRICE_UNAVAILABLE" }));
    expect(screen.queryByText(PRICE_SCOPES_RU.bold) === null).toBe(true);
  });
});

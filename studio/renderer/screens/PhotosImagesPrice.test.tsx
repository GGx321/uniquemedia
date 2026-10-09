import { describe, expect, test } from "bun:test";
import { waitFor } from "@testing-library/react";
import { callsOf, flush } from "../testing";
import { MIA } from "./photos/categoryScreenKit";
import { about, drawStepText } from "./photos/scenePaid";
import { card, openReview, priceRow } from "./photos/sceneScreenKit";

// S4.6p: the price of DRAWING a scene set is the engine's own figure (`runs.estimateImages`), on the generate card's compose mode and on the owner's strip. The window used to
// work it out as the run's estimate less the compose's (`useImagesPrice`); the renderer never computes money, so these pin that it asks, shows what it is told and works
// nothing out in its place.

const SET = "set-cut-0001";

/** Mia with 60 planned scenes, 25 written: «Дописать», and the photos of the whole set are priced as images. */
function cutOff() {
  return openReview({
    sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: SET, count: 60, written: 25, stopped: "closed", cutOff: { chunk: 2 }, categories: ["home", "travel", "shoot", "glam", "fit"] }],
  });
}

describe("the generate card's compose mode (step 2: the photos)", () => {
  test("asks the engine for the images of the form's count and shows its expected price", async () => {
    const { engine, client } = await openReview();
    // What the card itself asked, before the test asks anything.
    const askedByCard = callsOf(engine, "runs.estimateImages").map((c) => c.payload);
    const asked = await client.request("runs.estimateImages", { avatarId: MIA.avatarId, count: 20 });
    if (!asked.ok) throw new Error("the engine refused the price");
    await waitFor(() => expect(priceRow(/фото$/)).toContain(about(asked.result.estimate.expectedMicros)));
    expect(askedByCard.some((payload) => "count" in payload && payload.avatarId === MIA.avatarId && payload.count === 20)).toBe(true);
  });

  test("a price the engine cannot give leaves the step at «≈ …», with nothing worked out in its place", async () => {
    const { engine, client } = await openReview();
    await waitFor(() => expect(priceRow(/фото$/)).toContain("≈ $"));
    engine.failNext("runs.estimateImages", { code: "PRICE_UNAVAILABLE", detail: "no price" });
    // A dearer image quality changes what the draw costs, so the card asks again.
    const settings = await client.request("settings.get", {});
    if (!settings.ok) throw new Error("no settings");
    await client.request("settings.setModels", { imageModel: settings.result.imageModel, imageQuality: "medium", textModel: settings.result.textModel });
    await flush();
    await waitFor(() => expect(priceRow(/фото$/)).toContain("≈ …"));
  });
});

describe("the owner's strip (step 2: the photos of the set)", () => {
  test("asks the engine for the images of every scene the set would draw, and works no run − compose out", async () => {
    const { engine, client } = await cutOff();
    const askedByStrip = callsOf(engine, "runs.estimateImages").map((c) => c.payload);
    const asked = await client.request("runs.estimateImages", { avatarId: MIA.avatarId, count: 60 });
    if (!asked.ok) throw new Error("the engine refused the price");
    await waitFor(() => expect(priceRow(/фото$/)).toContain(about(asked.result.estimate.expectedMicros)));
    expect(askedByStrip.some((payload) => "count" in payload && payload.avatarId === MIA.avatarId && payload.count === 60)).toBe(true);
    // The old price took the writer off a run estimate probed with one built-in category; nothing probes now.
    expect(callsOf(engine, "runs.estimate").filter((c) => c.payload.categories.length === 1 && c.payload.categories[0] === "home")).toHaveLength(0);
    expect(card().textContent).toContain("без правок");
  });

  test("follows a change of the image quality: the new figure is the engine's for it", async () => {
    const { client } = await cutOff();
    await waitFor(() => expect(priceRow(/фото$/)).toContain("≈ $"));
    const before = priceRow(/фото$/);
    const settings = await client.request("settings.get", {});
    if (!settings.ok) throw new Error("no settings");
    await client.request("settings.setModels", { imageModel: settings.result.imageModel, imageQuality: "medium", textModel: settings.result.textModel });
    const asked = await client.request("runs.estimateImages", { avatarId: MIA.avatarId, count: 60 });
    if (!asked.ok) throw new Error("the engine refused the price");
    await waitFor(() => expect(priceRow(/фото$/)).toContain(about(asked.result.estimate.expectedMicros)));
    expect(priceRow(/фото$/)).not.toBe(before);
  });
});

describe("step 2 of a launch's strip (the engine's answer, as the window words it)", () => {
  const estimate = { expectedMicros: 840_000, worstMicros: 2_520_000, prices: "live" as const, pricesAsOf: "2026-10-09" };

  test("«≈ …» until the engine has answered, or when it refuses", () => {
    expect(drawStepText(null)).toBe("≈ …");
  });

  test("«—» when nothing is left to draw, never «≈ $0.000»", () => {
    expect(drawStepText({ estimate: { ...estimate, expectedMicros: 0, worstMicros: 0 }, photos: 0 })).toBe("—");
  });

  test("«≈ $X» of the engine's expected price when there are photos", () => {
    expect(drawStepText({ estimate, photos: 12 })).toBe(about(840_000));
  });
});

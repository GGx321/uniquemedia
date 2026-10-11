import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { MIA } from "../engine/mockEngine.testkit";
import { flush, runAll, tick } from "../testing";
import { card, describedText, goButton, isDisabled, nb, openReview } from "./photos/sceneScreenKit";

// S5.3d review M3: a reference-portrait batch claims the avatar like a photo run does, so «Фото» does not offer a run, a compose or a draw of hers
// while it draws (the engine would refuse each IN_FLIGHT behind a general text): the buttons wait, and say for what.

const REASON = "Дождитесь, пока дорисуются варианты мастер-портрета.";
const IMPORTED = { portraits: [{ avatarId: MIA.avatarId, sourcePhotoId: MIA.masterPhotoId }] };

/** Starts her batch the way another window (or «Внешность») would, and lets its first progress reach this window. */
async function drawPortraits(harness: Awaited<ReturnType<typeof openReview>>): Promise<void> {
  await act(async () => {
    const reply = await harness.client.request("avatars.generatePortraits", { avatarId: MIA.avatarId, acceptedWorstMicros: 300_000 });
    if (!reply.ok) throw new Error(`generatePortraits: ${reply.error.code}`);
  });
  tick(harness.scheduler);
  await flush();
}

describe("while her portraits draw, «Фото» waits", () => {
  test("a photo run: «Сгенерировать» waits with the reason, and comes back when the batch ends", async () => {
    const harness = await openReview({ ...IMPORTED, sceneReview: "off" });
    await waitFor(() => expect(goButton().textContent).toContain("Сгенерировать"));
    expect(isDisabled(goButton())).toBe(false);

    await drawPortraits(harness);
    expect(isDisabled(goButton())).toBe(true);
    expect(card().textContent).toContain(REASON);

    runAll(harness.scheduler);
    await flush();
    await waitFor(() => expect(isDisabled(goButton())).toBe(false));
    expect(card().textContent).not.toContain(REASON);
  });

  test("a compose (scenes on review): «Составить» waits with the reason", async () => {
    const harness = await openReview(IMPORTED);
    await waitFor(() => expect(goButton().textContent).toContain("Составить"));
    await drawPortraits(harness);
    expect(isDisabled(goButton())).toBe(true);
    expect(describedText(goButton())).toContain(REASON);
  });

  test("a draw of an open set: «Отрисовать» waits with the reason", async () => {
    const harness = await openReview(IMPORTED);
    fireEvent.click(await screen.findByRole("button", { name: nb("Составить 20 сцен · до $0.075") }));
    await flush();
    runAll(harness.scheduler);
    await flush();
    const draw = await screen.findByRole("button", { name: nb("Отрисовать 20 фото · до $3.00") });
    expect(isDisabled(draw)).toBe(false);

    await drawPortraits(harness);
    expect(isDisabled(goButton())).toBe(true);
    expect(card().textContent).toContain(REASON);
  });
});

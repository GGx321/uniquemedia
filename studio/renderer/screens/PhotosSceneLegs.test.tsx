import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { flush, openSection, setup } from "../testing";
import { MIA } from "./photos/categoryScreenKit";
import { card, sceneCard } from "./photos/sceneScreenKit";

// S5.8b (plan s5a2 §6.3, §7; mockup 28 of .omc/stage5/design): a set composed with «Ножки» on review. Each legs frame wears its capture's own label
// («Ножки сверху», «Снизу, к стопам», or the mirror's «Зеркало, лицо за телефоном» for a sole to the mirror), and the strip's line names the legs after
// «Подача». The set's view names no share, so the line counts the frames: «Ножки: 3 кадра» where the mockup says «немного, 15 %» (README's open question 5
// asks whether the line keeps these bits at all).

const LEGS_LABELS = ["Ножки сверху", "Снизу, к стопам", "Зеркало, лицо за телефоном"];

/** The strip's lock line, as read. */
function lockLine(): string {
  return card().querySelector(".scene-strip-lock")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

/** A card's tags as read: its category, who took the photo, its angle and its «Подача», in order. */
function tags(n: number): string[] {
  return Array.from(sceneCard(n).querySelectorAll(".scene-card-tags > .tag")).map((t) => t.textContent?.replace(/\s+/g, " ").trim() ?? "");
}

describe("a set composed with «Ножки» (mockup 28)", () => {
  test("names its legs frames in the strip's line, and each wears its capture's label", async () => {
    const { client } = setup({ avatars: [MIA], sceneReview: "on" });
    await screen.findByRole("heading", { level: 2, name: "Mia" });
    await openSection("Фото");
    await within(await screen.findByRole("region", { name: "Генерация фото" })).findByRole("button", { name: /^Составить 20\sсцен/ });
    fireEvent.click(within(within(card()).getByRole("radiogroup", { name: "Ножки" })).getByRole("radio", { name: /^Немного/ }));
    await flush();
    fireEvent.click(await within(card()).findByRole("button", { name: /^Составить 20\sсцен/ }));
    await flush();
    await waitFor(() => expect(card().querySelector(".scene-strip-lock")).not.toBeNull());

    const reply = await client.request("scenes.get", { avatarId: MIA.avatarId });
    if (!reply.ok || reply.result.sceneSet === null) throw new Error("no set was composed");
    const legs = reply.result.sceneSet.scenes.filter((s) => s.framing === "legs");
    // 15 % of 20 built-in photos (I5.29).
    expect(legs).toHaveLength(3);
    await waitFor(() => expect(lockLine()).toBe("Подача: обычная · Ножки: 3 кадра · Ракурс — из сцены. Настройки набора не меняются — Пересоставить… начнёт заново."));
    for (const scene of legs) expect(LEGS_LABELS).toContain(tags(scene.sceneId)[1] ?? "");
    // An ordinary frame never wears a legs label.
    const ordinary = reply.result.sceneSet.scenes.find((s) => s.framing === undefined);
    if (ordinary === undefined) throw new Error("every scene is a legs one");
    expect(["Ножки сверху", "Снизу, к стопам"]).not.toContain(tags(ordinary.sceneId)[1] ?? "");
  });
});

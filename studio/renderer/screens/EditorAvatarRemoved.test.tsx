import { describe, expect, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { PHOTO_IDS } from "../engine/mockEngine.testkit";
import { callsOf, flush } from "../testing";
import { asAnotherWindow, makeDraft, MIA, openDrafts, SOFIA, studio } from "./montage/screenKit";

// «Удалить аватар»: an editor open on a draft of an avatar that is deleted (in another window) closes with a notice. Its draft went to the Trash
// with the avatar, so nothing is saved any more and nothing is left to edit.

const P1 = PHOTO_IDS[0] ?? "";

/** Opens the one draft there is from the drafts screen, and waits for the editor. */
async function openEditor(): Promise<void> {
  await openDrafts();
  await screen.findByRole("heading", { level: 3, name: /Mia/ });
  fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
  await screen.findByRole("region", { name: "Таймлайн" });
  await flush();
}

describe("the drafts screen", () => {
  test("drops the drafts of a deleted avatar and keeps another avatar's", async () => {
    const { client } = await studio({ avatars: [MIA, SOFIA] });
    await makeDraft(client, MIA.avatarId, [P1]);
    await makeDraft(client, SOFIA.avatarId, []);
    await openDrafts();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2);

    await asAnotherWindow(() => client.request("avatars.delete", { avatarId: MIA.avatarId }));

    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "").join("|")).toContain("Sofia");
    expect(screen.queryAllByRole("heading", { level: 3 }).filter((h) => (h.textContent ?? "").includes("Mia"))).toHaveLength(0);
  });
});

describe("an open editor", () => {
  test("is replaced by a notice that says the avatar was deleted, with a way back to the avatars", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();

    await asAnotherWindow(() => client.request("avatars.delete", { avatarId: MIA.avatarId }));

    const notice = await screen.findByText("Аватар удалён");
    expect(notice.closest(".notice")?.getAttribute("role")).toBe("alert");
    expect(screen.getByText(/в Корзине/)).toBeDefined();
    expect(screen.queryByRole("region", { name: "Таймлайн" }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "К аватарам" }));
    await screen.findByRole("heading", { level: 1, name: "Аватары" });
  });

  test("saves nothing after the avatar went", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    const saves = callsOf(engine, "montages.save").length;

    await asAnotherWindow(() => client.request("avatars.delete", { avatarId: MIA.avatarId }));
    await screen.findByText("Аватар удалён");
    await flush();

    expect(callsOf(engine, "montages.save")).toHaveLength(saves);
  });

  test("stays open when ANOTHER avatar is deleted", async () => {
    const { client } = await studio({ avatars: [MIA, SOFIA] });
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();

    await asAnotherWindow(() => client.request("avatars.delete", { avatarId: SOFIA.avatarId }));

    expect(screen.getByRole("region", { name: "Таймлайн" })).toBeDefined();
    expect(screen.queryByText("Аватар удалён") === null).toBe(true);
  });
});

import { afterEach, expect, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { defaultSpec } from "../../shared/montage";
import { freePhotos, PHOTO_IDS } from "../engine/mockEngine.testkit";
import { flush } from "../testing";
import { asAnotherWindow, MIA, openDrafts, studio } from "./montage/screenKit";

// The editor passes the avatar's usage to the render block: while it is unknown the block says the avatar's reason and flags the frames the engine refused.

afterEach(() => {
  Reflect.deleteProperty(window, "studio");
});

test("a render blocked for an avatar whose records cannot be read shows the avatar's reason and flags every frame", async () => {
  const photos = freePhotos(3);
  const { client } = await studio({ photos, avatars: [{ ...MIA, usage: { state: "unknown", reasons: ["record-unreadable"] } }] });
  // A draft with photos cannot be created for such an avatar, so it is made empty and saved with them.
  const made = await asAnotherWindow(() => client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [] }));
  if (!made.ok) throw new Error(made.error.code);
  const spec = defaultSpec(MIA.avatarId, [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? ""], made.result.montage.spec.seed);
  await asAnotherWindow(() => client.request("montages.save", { montageId: made.result.montage.montageId, spec, name: null }));

  await openDrafts();
  await screen.findAllByRole("heading", { level: 3, name: /Mia/ });
  const [open] = screen.getAllByRole("button", { name: "Открыть" });
  if (open === undefined) throw new Error("no draft card");
  fireEvent.click(open);
  await screen.findByRole("region", { name: "Таймлайн" });
  await flush();

  await screen.findByText("Записи этого аватара повреждены или недоступны — откройте «Фото» этого аватара");
  await waitFor(() => expect(document.querySelectorAll(".ed-clip-flagged, .ed-clip-warn").length).toBeGreaterThan(0));
});

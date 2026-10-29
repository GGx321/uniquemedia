import { describe, expect, test } from "bun:test";
import type { AvatarSummary } from "../../shared/engine";
import { freePhotos, makeMock, MIA, unwrap, type Mock } from "./mockEngine.testkit";

// 3e.2: what the Photos screen asks of the mock, the way the engine answers it: an avatar's usage on its summary
// (`AvatarSummary.usage`) and the two recoveries, `videos.get` by id, the video's title, first clip and track id, and main's
// «Папка «Готовые видео»» (`videos.revealFolder`). The mock has no disk: an avatar's broken records or marks are the usage it
// was seeded with, and the recoveries clear their own reason, as the engine's do once the disk is put right.


function withUsage(usage: AvatarSummary["usage"], extra: Parameters<typeof makeMock>[0] = {}): Mock {
  const photos = freePhotos(6);
  return makeMock({ photos, avatars: [{ ...MIA, photoCount: photos.length, eligibleUnusedCount: 0, usage }], ...extra });
}

const avatarEvents = (mock: Mock, mark: number) => mock.events.slice(mark).flatMap((e) => (e.type === "avatar.changed" ? [e.payload.avatar] : []));

async function avatarOf(mock: Mock, avatarId = MIA.avatarId): Promise<AvatarSummary | undefined> {
  return (await unwrap(mock.client.request("avatars.list", {}))).avatars.find((a) => a.avatarId === avatarId);
}

describe("AvatarSummary.usage", () => {
  test("the demo's avatars, and every avatar the mock makes, have a sound usage", async () => {
    const mock = makeMock({ preset: "demo", avatars: undefined, photos: undefined });
    for (const avatar of (await unwrap(mock.client.request("avatars.list", {}))).avatars) expect(avatar.usage).toEqual({ state: "ok" });
  });
});

describe("videos.quarantineRecords", () => {
  test("clears a broken record: answers 1, and the avatar, trusted again, is announced with its counts back", async () => {
    const mock = withUsage({ state: "unknown", reasons: ["record-unreadable"] });
    const mark = mock.events.length;

    const answer = await unwrap(mock.client.request("videos.quarantineRecords", { avatarId: MIA.avatarId }));

    expect(answer).toEqual({ avatarId: MIA.avatarId, quarantined: 1 });
    expect(avatarEvents(mock, mark)).toEqual([expect.objectContaining({ usage: { state: "ok" }, eligibleUnusedCount: 6 })]);
    expect((await avatarOf(mock))?.usage).toEqual({ state: "ok" });
  });

});


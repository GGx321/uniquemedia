import { act, screen } from "@testing-library/react";
import type { AvatarSummary, Montage, PhotoSummary } from "../../../shared/engine";
import type { EngineClient } from "../../engine/client";
import type { MockEngine, MockMusicOptions } from "../../engine/mockEngine";
import { freePhotos, MIA, SOFIA } from "../../engine/mockEngine.testkit";
import { flush, openSection, setup } from "../../testing";

// Test support for the drafts screen and the editor (3d.2): the App on the mock engine with Mia (and Sofia) and
// their free scene photos, and drafts made the way another window would make them. Test-only.

export { MIA, SOFIA };

export function withCounts(avatar: AvatarSummary, photos: readonly PhotoSummary[]): AvatarSummary {
  const own = photos.filter((p) => p.avatarId === avatar.avatarId);
  return { ...avatar, photoCount: own.length, eligibleUnusedCount: own.filter((p) => p.eligible && !p.used && !p.reserved).length };
}

/**
 * The App with `avatars` (Mia by default) and their photos (6 free ones of Mia by default), on the Avatars screen; `music` is the
 * mock's track store (3d.3b), none by default.
 */
export async function studio(options: { avatars?: AvatarSummary[]; photos?: PhotoSummary[]; music?: MockMusicOptions } = {}) {
  const photos = options.photos ?? freePhotos(6);
  const avatars = (options.avatars ?? [MIA]).map((a) => withCounts(a, photos));
  const harness = setup(options.music === undefined ? { avatars, photos } : { avatars, photos, music: options.music });
  const first = avatars[0];
  if (first !== undefined) await screen.findByRole("heading", { level: 2, name: first.name });
  return harness;
}

/** A draft made through the client, as another window (or the Photos screen) would. */
export async function makeDraft(client: EngineClient, avatarId: string, photoIds: string[]): Promise<Montage> {
  const reply = await asAnotherWindow(() => client.request("montages.create", { avatarId, photoIds }));
  if (!reply.ok) throw new Error(`montages.create: ${reply.error.code}`);
  return reply.result.montage;
}

/** The sidebar's «Монтаж», and its list loaded. */
export async function openDrafts(): Promise<void> {
  await openSection("Монтаж");
  await screen.findByRole("heading", { level: 1, name: "Монтаж" });
  await flush();
}

/**
 * The paid music commands a mock was sent (3d.5's money guard): `music.refresh` spends 1 of the 30 flashapi requests and
 * `music.recoverQuotaLog` closes the quota for 31 days. Only Settings may send them, after the owner confirms; the editor never.
 */
export function paidMusicCalls(engine: MockEngine): string[] {
  return engine.calls.filter((c) => c.type === "music.refresh" || c.type === "music.recoverQuotaLog").map((c) => c.type);
}

/** A command sent from the test (another window), inside act so React sees the events it causes. */
export async function asAnotherWindow<T>(fn: () => Promise<T>): Promise<T> {
  const holder: { pending?: Promise<T> } = {};
  await act(async () => {
    holder.pending = fn();
    await holder.pending;
  });
  await flush();
  if (holder.pending === undefined) throw new Error("the command was not sent");
  return holder.pending;
}

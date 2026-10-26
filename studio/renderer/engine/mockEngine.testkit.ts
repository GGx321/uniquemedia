import type { AvatarSummary, EventMessage, PhotoSummary } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { shotOf } from "../../shared/scenes/captures";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { bankDraw } from "./mockBankScenes";
import type { MockSceneSetSeed } from "./mockSceneSets";
import { ManualScheduler } from "./scheduler";

// Test support for the mock's montage and video tests: an active avatar, scene photos of it in every state the montage
// commands care about, and a mock on a manual clock behind the same validating client the renderer uses. Test-only.

export const MIA: AvatarSummary = {
  avatarId: "avatar-mia-0001",
  name: "Mia",
  descriptor: mockDescriptor(DEFAULT_TRAITS),
  masterPhotoId: "photo-mia-master",
  createdAt: "2026-09-24T09:00:00.000Z",
  status: "active",
  photoCount: 0,
  videoCount: 0,
  eligibleUnusedCount: 0,
  usage: { state: "ok" },
};

/** A second active avatar, for the drafts of several avatars. */
export const SOFIA: AvatarSummary = { ...MIA, avatarId: "avatar-sofia-0002", name: "Sofia", masterPhotoId: "photo-sofia-master" };

/** A retired avatar: its drafts and videos still list, nothing new is made for it. */
export const NORA: AvatarSummary = { ...MIA, avatarId: "avatar-nora-0003", name: "Nora", masterPhotoId: "photo-nora-master", status: "archived" };

/**
 * A scene photo of `avatar` in `n`-th place. An odd `n` carries a face score (the mock's focus resolver judges it), an even one
 * does not (an unchecked photo: it gets no focus). `patch` sets the state a test needs: used, reserved, rejected...
 */
export function scenePhoto(n: number, patch: Partial<PhotoSummary> = {}, avatar: AvatarSummary = MIA): PhotoSummary {
  const id = String(n).padStart(4, "0");
  return {
    photoId: `photo-${avatar.name.toLowerCase()}-${id}`,
    avatarId: avatar.avatarId,
    runId: null,
    category: "home",
    createdAt: new Date(Date.UTC(2026, 8, 24, 10, 0, n)).toISOString(),
    used: false,
    usedIn: [],
    rejected: false,
    reserved: false,
    eligible: true,
    ...(n % 2 === 1 ? { qa: { faceCos: 0.86 } } : {}),
    ...patch,
  };
}

/** `count` free scene photos of `avatar`, numbered from 1. */
export function freePhotos(count: number, avatar: AvatarSummary = MIA): PhotoSummary[] {
  return Array.from({ length: count }, (_, i) => scenePhoto(i + 1, {}, avatar));
}

export function makeMock(options: ConstructorParameters<typeof MockEngine>[0] = {}) {
  const scheduler = new ManualScheduler();
  const photos = options.photos ?? freePhotos(6);
  const avatars = options.avatars ?? [{ ...MIA, photoCount: photos.length, eligibleUnusedCount: photos.filter((p) => p.eligible && !p.used && !p.reserved).length }];
  const engine = new MockEngine({ scheduler, avatars, photos, ...options });
  const client = mockEngineClient(engine);
  const events: EventMessage[] = [];
  client.subscribe((e) => events.push(e));
  return { scheduler, engine, client, events };
}

export type Mock = ReturnType<typeof makeMock>;

export async function unwrap<T>(reply: Promise<{ ok: true; result: T } | { ok: false; error: { code: string; detail?: string | undefined } }>): Promise<T> {
  const r = await reply;
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.detail ?? ""}`);
  return r.result;
}

/** The scene photo ids of MIA in the default mock, in order. */
export const PHOTO_IDS = freePhotos(6).map((p) => p.photoId);

export const scene = (photoId: string) => ({ source: "scene" as const, photoId });

/** A saved draft of `photoIds` (in this order), made through the client. */
export async function draftOf(mock: Mock, photoIds: string[], avatarId: string = MIA.avatarId) {
  return (await unwrap(mock.client.request("montages.create", { avatarId, photoIds }))).montage;
}

/** `videos.render` of a draft, unwrapped. */
export async function renderDraft(mock: Mock, montageId: string): Promise<{ jobId: string; videoId: string }> {
  return unwrap(mock.client.request("videos.render", { montageId }));
}

export const typesOf = (events: EventMessage[]): string[] => events.map((e) => e.type);

/** The events of one job, in order. */
export function eventsOfJob(events: EventMessage[], jobId: string): EventMessage[] {
  return events.filter((e) => "jobId" in e.payload && e.payload.jobId === jobId);
}

/** The render jobs of the snapshot. */
export async function renderJobsOf(mock: Mock) {
  const snapshot = await unwrap(mock.client.request("engine.snapshot", {}));
  return snapshot.jobs.flatMap((j) => (j.kind === "render" ? [j] : []));
}

/**
 * 5a.4 (S5.BA3, 2026-10-26, plan s5a4 §7.4, QB-5, BA2 part 2 review L1): a set stored before 5a.4, written, that mixes «Дом» scenes drawn as «Кокетливая» (no route) with «Ночнушки и бельё» scenes
 * on the Seedream route. «Смелая» plans «Дом» on the route now, so a test that needs scenes on and off the route in one set seeds this one instead of composing it.
 */
export function mixedSetSeed(avatarId: string, sceneSetId: string, counts: { home: number; nightwear: number } = { home: 5, nightwear: 5 }): MockSceneSetSeed {
  const home = Array.from({ length: counts.home }, (_, k) => {
    const draw = bankDraw("home", k, { level: k % 2 === 0 ? "flirty" : "ordinary" });
    return { category: "home" as const, shot: shotOf(draw.capture), pose: draw.pose, place: draw.place, text: `A home scene (${k}).`, ...(k % 2 === 0 ? { level: "flirty" as const } : {}) };
  });
  const nightwear = Array.from({ length: counts.nightwear }, (_, k) => {
    const draw = bankDraw("nightwear", k, { level: "bold" });
    return { category: "nightwear" as const, shot: shotOf(draw.capture), pose: draw.pose, place: draw.place, text: `A nightwear scene (${k}).`, level: "bold" as const, route: "seedream" as const };
  });
  return { avatarId, sceneSetId, count: counts.home + counts.nightwear, written: counts.home + counts.nightwear, categories: ["home", "nightwear"], level: "bold", scenes: [...home, ...nightwear] };
}

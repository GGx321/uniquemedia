import type { LaunchAvatarView, LaunchDraft, LaunchDraftInput, LaunchPreview, LaunchPreviewAvatar, LaunchSummary, LaunchVideo, LaunchView, LogLine, PaidHold } from "./autopilot";

// Fixtures of the Stage 4 contract tests (S4.1): one valid launch, preview, summary, hold and log line of each kind, shared by the contract tests, the mock's tests and
// the renderer's. Test support only: it imports no test runner. The typed constants are valid by their types; the helpers beside them (`viewWith`, `avatarRow`, ...)
// take loose patches so a test can break one field and see the contract refuse it.

export const A = "avatar-mia-0001";
export const B = "avatar-sofia-0002";
export const LAUNCH = "launch-0a1b2c3d4e5f";
export const SET = "set-mia-00000001";
export const NOW = "2026-10-08T14:02:00.000Z";
export const LATER = "2026-10-08T14:06:00.000Z";

export const draftSettings: LaunchDraftInput = {
  avatarIds: [A, B],
  videosPerAvatar: 10,
  mix: { single: 70, collage: 20, slides: 10 },
  categories: ["home", "cat-abcdefgh"],
  poses: { profile: false, back: false },
  library: true,
  generate: true,
  sceneReview: true,
  stickers: false,
};
export const draft: LaunchDraft = { ...draftSettings, planSeed: 123_456 };

export const holdAt = { at: NOW };
export const budgetHold: PaidHold = { reason: "budget", at: NOW, detail: { freeMicros: 180_000, needMicros: 1_050_000, kind: "resume-slice" } };
export const HOLDS: Record<string, unknown> = {
  budget: budgetHold,
  credits: { reason: "credits", ...holdAt, detail: {} },
  key: { reason: "key", ...holdAt, detail: {} },
  halt: { reason: "halt", ...holdAt, detail: { code: "SETTLE_ABOVE_WORST" } },
  network: { reason: "network", ...holdAt, detail: { drops: 1, attempt: 1, nextAt: LATER } },
  "price-unavailable": { reason: "price-unavailable", ...holdAt, detail: { attempt: 2, nextAt: LATER } },
  price: { reason: "price", ...holdAt, detail: { stage: "slice", fromPhotos: 5, toPhotos: 0 } },
  internal: { reason: "internal", ...holdAt, detail: { kind: "allocation-exceeded" } },
};

export const LOG_SAMPLES: Record<string, Record<string, unknown>> = {
  start: { acceptedMicros: 4_140_000 },
  "scenes-ready": { scenes: 14, withoutText: 2 },
  "review-continued": { photos: 14, writtenByOwner: 2 },
  "slice-start": { index: 1, total: 4, photos: 14, capMicros: 2_940_000 },
  photo: { done: 9, total: 14, faceCos: 0.84 },
  "photo-retry": { sceneId: 7, attempt: 2, attempts: 3, viaFallback: true },
  "photo-failed": { slot: 9, attempts: 3, cause: "face", faceCos: 0.47 },
  "video-done": { key: "1-5", shape: "collage", size: 3, durationMs: 8_500, bytes: 2_300_000 },
  degrade: { fewerVideos: 2, missingPhotos: 3 },
  "hold-network": { drops: 3 },
  "avatar-busy": {},
  "app-restarted": { cause: "engine-restart", requests: 4 },
  "scenes-writing": { scenes: 14 },
  "budget-ended": { done: 9, total: 14 },
  "hold-key": {},
  "hold-credits": {},
  "hold-halt": { code: "SETTLE_ABOVE_WORST" },
  "hold-price": { detail: { stage: "slice", fromPhotos: 5, toPhotos: 0 } },
  "hold-price-unavailable": { attempt: 2 },
  "hold-internal": { holdKind: "allocation-exceeded" },
  "hold-export": { exportReason: "not-enough-space" },
  "render-dropped": { key: "1-6" },
  "price-shrink": { fromPhotos: 5, toPhotos: 4 },
  "review-write": { write: "redraw", micros: 2_000 },
  pausing: { requests: 4, renders: 2 },
  paused: {},
  resumed: { acceptedRemainingMicros: 2_930_000 },
  "host-quit": { requests: 4 },
  "network-retry": { attempt: 1, attempts: 2, afterMs: 60_000 },
  "hold-budget": { holdKind: "resume-slice", freeMicros: 180_000, needMicros: 1_050_000 },
  skipped: { reason: "failure-rate", failed: 3, total: 5 },
  "waiting-music": { key: "1-8", neededMs: 9_500 },
  "review-approved-paused": { photos: 12 },
  "music-refresh": { added: 6, remaining: 20 },
  stopped: { spentMicros: 330_000 },
  done: { videosDone: 28, videosPlanned: 30 },
};
export const logLine = (kind: string, over: Record<string, unknown> = {}) => ({ at: NOW, kind, ...LOG_SAMPLES[kind], ...over });
export const startLine: LogLine = { at: NOW, kind: "start", acceptedMicros: 4_140_000 };

/** An avatar of the launch, drawing its second slice of four. */
export const drawingRow = (avatarId: string): LaunchAvatarView => ({
  avatarId,
  phase: "drawing",
  waiting: null,
  skipped: null,
  photos: { done: 9, total: 14 },
  montage: { done: 6, total: 10 },
  videos: { done: 5, total: 10 },
  sceneSetId: SET,
  setRevision: 3,
  scenes: 14,
  scenesWithoutText: 0,
  continuePhotos: 14,
  slice: { index: 2, total: 4 },
  dropped: null,
  waitingMusic: 0,
  undrawnScenes: 5,
  resumableSlots: 2,
  drawAllocationMicros: 1_050_000,
});
/** An avatar of the launch that is only montaging library photos: no set, no slice. */
export const libraryRow = (avatarId: string): LaunchAvatarView => ({
  ...drawingRow(avatarId),
  phase: "montage",
  sceneSetId: null,
  setRevision: null,
  scenes: null,
  scenesWithoutText: null,
  continuePhotos: null,
  slice: null,
  undrawnScenes: 0,
  resumableSlots: 0,
  drawAllocationMicros: null,
});
export const avatarRow = (avatarId: string, over: Record<string, unknown> = {}) => ({ ...drawingRow(avatarId), ...over });

export const view: LaunchView = {
  launchId: LAUNCH,
  createdAt: NOW,
  endedAt: null,
  activeMs: 161_000,
  status: "running",
  paused: null,
  paidHold: null,
  freeHold: null,
  draft,
  acceptedMicros: 4_140_000,
  plannedWorstMicros: 4_140_000,
  plannedExpectedMicros: 1_340_000,
  plan: { videos: 20, photos: 56, fromLibrary: 37, toGenerate: 19 },
  spentMicros: 1_210_000,
  remainingMicros: 2_930_000,
  reviewWritesMicros: 0,
  inFlight: { requests: 4, openMicros: 280_000 },
  waitingMusic: 0,
  resumeBlockedBy: null,
  avatars: [drawingRow(A), libraryRow(B)],
  logTail: [startLine],
};
export const viewWith = (over: Record<string, unknown>) => ({ ...view, ...over });

export const summary: LaunchSummary = {
  launchId: LAUNCH,
  createdAt: NOW,
  endedAt: null,
  status: "running",
  avatarCount: 2,
  avatarIds: [A, B],
  videosDone: 10,
  videosPlanned: 20,
  spentMicros: 1_210_000,
  acceptedMicros: 4_140_000,
  plannedWorstMicros: 4_140_000,
};

export const videoDone: LaunchVideo = {
  key: "0-1",
  avatarId: A,
  shape: "collage",
  size: 3,
  durationMs: 8_500,
  bytes: 2_300_000,
  track: { source: "trending", title: "Soft Static", artist: "Ivo" },
  state: "done",
  dropReason: null,
  videoId: "video-0000000a",
  publishedAt: null,
};
export const video = (key: string, over: Record<string, unknown> = {}) => ({ ...videoDone, key, ...over });

const previewRowOf = (avatarId: string, over: Partial<LaunchPreviewAvatar> = {}): LaunchPreviewAvatar => ({
  avatarId,
  videos: 10,
  shapes: { single: 7, collage: 2, slides: 1 },
  free: 31,
  fromLibrary: 14,
  toGenerate: 0,
  busy: false,
  blocked: null,
  usage: { state: "ok" },
  ...over,
});
export const previewRow = (avatarId: string, over: Record<string, unknown> = {}) => ({ ...previewRowOf(avatarId), ...over });

export const preview: LaunchPreview = {
  planSeed: 123_456,
  avatars: [previewRowOf(A), previewRowOf(B, { free: 4, fromLibrary: 4, toGenerate: 10, busy: true })],
  totals: { videos: 20, photosNeeded: 28, fromLibrary: 18, toGenerate: 10 },
  estimate: { expectedMicros: 700_000, worstMicros: 3_000_000, prices: "live", pricesAsOf: "2026-10-08" },
  perShapeExpectedMicros: { single: 70_000, collage: 210_000, slides: 350_000 },
  month: { budgetMicros: 10_000_000, committedMicros: 1_640_000, freeMicros: 8_360_000, fit: "fits", raiseToMicros: null },
  balance: { micros: 12_400_000, asOf: NOW },
  music: { candidates: 24, ownFlagged: 3, explicitSkipped: 2, autoRefresh: "will", quotaRemaining: 21 },
  disk: { neededBytes: 9_000_000, freeBytes: 50_000_000_000 },
  timeSeconds: 1_200,
  blockers: [],
};
export const previewWith = (over: Record<string, unknown>) => ({ ...preview, ...over });

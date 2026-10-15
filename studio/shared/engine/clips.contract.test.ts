import { describe, expect, test } from "bun:test";
import { ClipReason, CLIP_FILE_DAMAGED_DETAIL, CLIP_REASONS, CLIP_UNSUITABLE_REASONS, EngineError, LAUNCH_REASONS } from "./errors";
import { CLIP_EXPORT_FAILED_RU, CLIP_FILE_DAMAGED_RU, CLIP_REASONS_RU, clipExportLineRu, PRICE_SCOPES_RU } from "./errorMessagesRu";
import { COMMAND_TYPES, ENGINE_COMMAND_TYPES, MAIN_ONLY_COMMANDS, OkResponse, type CommandType } from "./commands";
import { SLEEP_CLASS, heldWhileAsleep } from "./commandHold";
import { PROTOCOL_VERSION } from "./envelope";
import { parseEngineCommand } from "./messages";
import { MoneyStatus } from "./state";

// Stage 5, 5b.1, S5.V1 (plan s5b1 §5.2, §8): the clip commands, the clip reasons and their Russian texts, `priceScope: "video"` and `MoneyStatus.reconcileAvailableAt`.
// Everything is additive in protocol 5: each shape is tried first in its old form (it parses and gains no key), then with the new field, then with it broken.

const AVATAR = "avatar-aaaa-0001";
const PHOTO = "photo-0001";
const CLIP = "clip-0000001";

const command = (type: string, payload: unknown) => ({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "command", type, payload });
const accepts = (type: string, payload: unknown): boolean => parseEngineCommand(command(type, payload)).ok;
const answers = (type: string, result: unknown): boolean => OkResponse.safeParse({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type, ok: true, result }).success;

const estimate = (expectedMicros: number, worstMicros: number) => ({ expectedMicros, worstMicros, prices: "live" as const, pricesAsOf: "2026-10-13" });
const motion = { id: "scene", source: "scene", label: "Как в сцене", text: "she slowly lifts the cup" };
const prices = { std5: estimate(420_000, 850_000), pro5: estimate(560_000, 850_000), std10: estimate(840_000, 1_550_000), pro10: estimate(1_120_000, 1_550_000), grok5: estimate(710_000, 850_000), grok10: estimate(1_410_000, 1_550_000) };
const noFallbackPrices = { std5: estimate(420_000, 504_000), pro5: estimate(560_000, 672_000), std10: estimate(840_000, 924_000), pro10: estimate(1_120_000, 1_232_000) };
const options = { suitable: true, photoId: PHOTO, motions: [motion], prices, fallback: "auto", bold: false, noFallbackPrices, monthFits: { std5: "with-fallback", pro5: "with-fallback", std10: "with-fallback", pro10: "with-fallback" } };
const summary = {
  clipId: CLIP,
  avatarId: AVATAR,
  photoId: PHOTO,
  createdAt: "2026-10-13T10:00:00.000Z",
  seen: false,
  motion: { source: "scene", label: "Как в сцене", text: "she slowly lifts the cup" },
  request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
  model: "kling-std",
  fallback: false,
  recovered: false,
  cost: { micros: 420_000, kind: "billed" },
  exports: [],
  status: "ready",
  width: 720,
  height: 1280,
  durationMs: 5_000,
  face: { verdict: "match", p75: 0.71, frames: 11 },
};

const CLIP_COMMANDS = ["clips.options", "clips.create", "clips.list", "clips.get", "clips.markSeen", "clips.delete", "clips.retryDownload", "clips.export", "clips.reveal"] as const;

describe("the clip commands exist", () => {
  test("all nine are in the command set", () => {
    for (const type of CLIP_COMMANDS) expect(COMMAND_TYPES).toContain(type);
  });

  test("clips.reveal is main's alone: it is in MAIN_ONLY_COMMANDS and the engine refuses it", () => {
    expect(MAIN_ONLY_COMMANDS).toContain("clips.reveal");
    expect(ENGINE_COMMAND_TYPES as readonly string[]).not.toContain("clips.reveal");
    expect(accepts("clips.reveal", { avatarId: AVATAR, clipId: CLIP })).toBe(false);
  });

  test("clips.get is an engine command, and so is every other clip command but reveal", () => {
    for (const type of CLIP_COMMANDS) {
      if (type === "clips.reveal") continue;
      expect(MAIN_ONLY_COMMANDS).not.toContain(type);
      expect(ENGINE_COMMAND_TYPES as readonly string[]).toContain(type);
    }
  });
});

describe("clips.options", () => {
  test("takes an avatar and a photo and nothing else", () => {
    expect(accepts("clips.options", { avatarId: AVATAR, photoId: PHOTO })).toBe(true);
    expect(accepts("clips.options", { avatarId: AVATAR })).toBe(false);
    expect(accepts("clips.options", { avatarId: AVATAR, photoId: PHOTO, extra: 1 })).toBe(false);
  });

  test("answers ClipOptions: a suitable photo or an unsuitable one with its reason", () => {
    expect(answers("clips.options", options)).toBe(true);
    expect(answers("clips.options", { suitable: false, photoId: PHOTO, reason: "bold-off" })).toBe(true);
    expect(answers("clips.options", { suitable: false, photoId: PHOTO })).toBe(false);
  });
});

describe("clips.create", () => {
  const create = { avatarId: AVATAR, photoId: PHOTO, motionId: "scene", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 };

  test("takes the sheet's choices and the accepted worst case", () => {
    expect(accepts("clips.create", create)).toBe(true);
    expect(accepts("clips.create", { ...create, motionId: "g-blink-smile", model: "grok", quality: "pro", seconds: 10, fallback: "none" })).toBe(true);
  });

  test("has no `reveal` field: the reveal was dropped (Q-B)", () => {
    expect(accepts("clips.create", { ...create, reveal: true })).toBe(false);
  });

  test("refuses a missing accepted worst case, a float one and a negative one", () => {
    const { acceptedWorstMicros: _accepted, ...noWorst } = create;
    expect(accepts("clips.create", noWorst)).toBe(false);
    expect(accepts("clips.create", { ...create, acceptedWorstMicros: 850_000.5 })).toBe(false);
    expect(accepts("clips.create", { ...create, acceptedWorstMicros: -1 })).toBe(false);
  });

  test("refuses a length of 7 s, a quality that is not std or pro, a fallback that is not auto or none and a model that is not kling or grok", () => {
    expect(accepts("clips.create", { ...create, seconds: 7 })).toBe(false);
    expect(accepts("clips.create", { ...create, quality: "hd" })).toBe(false);
    expect(accepts("clips.create", { ...create, fallback: "offer" })).toBe(false);
    expect(accepts("clips.create", { ...create, model: "seedance" })).toBe(false);
  });

  test("refuses a motion id that is neither `scene` nor `g-…` (never free text)", () => {
    expect(accepts("clips.create", { ...create, motionId: "she dances wildly" })).toBe(false);
    expect(accepts("clips.create", { ...create, motionId: "" })).toBe(false);
  });

  test("answers the job id", () => {
    expect(answers("clips.create", { jobId: "job-00000001" })).toBe(true);
    expect(answers("clips.create", { jobId: "job-00000001", clipId: CLIP })).toBe(false);
  });
});

describe("clips.list", () => {
  test("takes an avatar", () => {
    expect(accepts("clips.list", { avatarId: AVATAR })).toBe(true);
    expect(accepts("clips.list", {})).toBe(false);
  });

  test("answers the clips, newest first, at most 500, with notListedTotal absent when 0 and never 0", () => {
    expect(answers("clips.list", { clips: [summary] })).toBe(true);
    expect(answers("clips.list", { clips: [], notListedTotal: 3 })).toBe(true);
    expect(answers("clips.list", { clips: [], notListedTotal: 0 })).toBe(false);
    const many = Array.from({ length: 501 }, (_, i) => ({ ...summary, clipId: `clip-${String(i).padStart(8, "0")}` }));
    expect(answers("clips.list", { clips: many.slice(0, 500) })).toBe(true);
    expect(answers("clips.list", { clips: many })).toBe(false);
  });
});

describe("clips.get", () => {
  test("takes an avatar and a clip and answers the clip with its exports' file state", () => {
    expect(accepts("clips.get", { avatarId: AVATAR, clipId: CLIP })).toBe(true);
    expect(accepts("clips.get", { avatarId: AVATAR })).toBe(false);
    const exported = { rootId: "root-00000001", relPath: "Nini/2026-10-13_clip_001.mp4", profile: "1080p30-dup", at: "2026-10-13T10:00:00.000Z", bytes: 4_000_000, sha256: "b".repeat(64), fileState: "present" };
    expect(answers("clips.get", { clip: { ...summary, exports: [exported] } })).toBe(true);
    expect(answers("clips.get", { clip: summary, extra: 1 })).toBe(false);
  });
});

describe("clips.markSeen, clips.delete, clips.retryDownload, clips.export, clips.reveal", () => {
  test("markSeen and delete take an avatar and a clip and answer the clip's id", () => {
    for (const type of ["clips.markSeen", "clips.delete"] as const) {
      expect(accepts(type, { avatarId: AVATAR, clipId: CLIP })).toBe(true);
      expect(accepts(type, { avatarId: AVATAR, clipId: CLIP, extra: 1 })).toBe(false);
      expect(answers(type, { clipId: CLIP })).toBe(true);
      expect(answers(type, {})).toBe(false);
    }
  });

  test("retryDownload and export take an avatar and a clip and answer a job id", () => {
    for (const type of ["clips.retryDownload", "clips.export"] as const) {
      expect(accepts(type, { avatarId: AVATAR, clipId: CLIP })).toBe(true);
      expect(accepts(type, { avatarId: AVATAR, clipId: CLIP, path: "/tmp/x.mp4" })).toBe(false);
      expect(answers(type, { jobId: "job-00000001" })).toBe(true);
      expect(answers(type, { clipId: CLIP })).toBe(false);
    }
  });

  test("reveal answers the clip's id (main answers it, not the engine)", () => {
    expect(answers("clips.reveal", { clipId: CLIP })).toBe(true);
    expect(answers("clips.reveal", { clipId: CLIP, path: "/Users/alex/x.mp4" })).toBe(false);
  });
});

describe("the sleep classes (S4.7)", () => {
  test("every clip command is classified", () => {
    for (const type of CLIP_COMMANDS) expect(SLEEP_CLASS[type]).toBeDefined();
  });

  test("only clips.create (and, from 5b.2, clips.createBatch) starts paid work, so only they are held while the Mac sleeps", () => {
    expect(heldWhileAsleep("clips.create")).toBe(true);
    expect(heldWhileAsleep("clips.createBatch")).toBe(true);
    for (const type of CLIP_COMMANDS) if (type !== "clips.create") expect(heldWhileAsleep(type)).toBe(false);
  });

  test("the classes are decided for exactly the commands the contract has", () => {
    expect(Object.keys(SLEEP_CLASS).sort()).toEqual([...COMMAND_TYPES].sort() satisfies CommandType[]);
  });
});

describe("EngineError.clipReason", () => {
  const VALIDATION_REASONS = ["not-a-gallery-photo", "age-unverified", "photo-unreadable", "not-vertical", "bold-off", "no-motion", "unknown-motion", "grok-not-offered", "download-expired", "not-ready", "not-exported", "file-damaged", "motions-full"];
  const IN_FLIGHT_REASONS = ["one-at-a-time", "job-running", "submitted", "in-use", "batch-running", "clip-busy", "motion-busy", "suggest-busy", "idea-busy"];

  test("the closed set is the fourteen of §5.2's table and the seven 5b.2 adds (file-damaged, in-use, batch-running, clip-busy, motion-busy, suggest-busy, idea-busy)", () => {
    const actual: string[] = [...CLIP_REASONS];
    expect(actual.sort()).toEqual([...VALIDATION_REASONS, ...IN_FLIGHT_REASONS].sort());
    expect(ClipReason.safeParse("one-at-a-time").success).toBe(true);
    expect(ClipReason.safeParse("reveal-unavailable").success).toBe(false);
  });

  test("every VALIDATION reason is accepted with VALIDATION, including not-vertical and photo-unreadable", () => {
    for (const clipReason of VALIDATION_REASONS) expect(EngineError.safeParse({ code: "VALIDATION", clipReason }).success).toBe(true);
  });

  test("every IN_FLIGHT reason is accepted with IN_FLIGHT", () => {
    for (const clipReason of IN_FLIGHT_REASONS) expect(EngineError.safeParse({ code: "IN_FLIGHT", clipReason }).success).toBe(true);
  });

  test("a VALIDATION reason is refused with IN_FLIGHT, and an IN_FLIGHT reason with VALIDATION", () => {
    for (const clipReason of VALIDATION_REASONS) expect(EngineError.safeParse({ code: "IN_FLIGHT", clipReason }).success).toBe(false);
    for (const clipReason of IN_FLIGHT_REASONS) expect(EngineError.safeParse({ code: "VALIDATION", clipReason }).success).toBe(false);
  });

  test("no other code carries a clip reason", () => {
    for (const code of ["NOT_FOUND", "INTERNAL", "PRICE_CHANGED", "BUDGET_EXCEEDED", "PRICE_UNAVAILABLE", "LIBRARY_UNAVAILABLE", "RECONCILE_REQUIRED"]) {
      expect(EngineError.safeParse({ code, clipReason: "not-vertical" }).success).toBe(false);
    }
  });

  test("an unknown reason is refused", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", clipReason: "too-long" }).success).toBe(false);
  });

  test("a refusal has one reason: a clip reason never appears beside a portrait, descriptor, launch, scene or category reason", () => {
    const others: Record<string, unknown>[] = [
      { portraitReason: "not-imported" },
      { descriptorReason: "empty" },
      { launchReason: LAUNCH_REASONS[0] },
      { sceneReason: "set-used" },
      { categoryReason: "limit" },
    ];
    for (const other of others) expect(EngineError.safeParse({ code: "VALIDATION", clipReason: "not-vertical", ...other }).success).toBe(false);
  });

  test("an error without a clip reason parses as before and gains no key", () => {
    const parsed = EngineError.parse({ code: "VALIDATION", portraitReason: "not-imported" });
    expect("clipReason" in parsed).toBe(false);
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason: "set-used" }).success).toBe(true);
  });

  test("the unsuitable reasons of clips.options are the six photo reasons", () => {
    expect([...CLIP_UNSUITABLE_REASONS].sort()).toEqual(["age-unverified", "bold-off", "no-motion", "not-a-gallery-photo", "not-vertical", "photo-unreadable"]);
    for (const reason of CLIP_UNSUITABLE_REASONS) expect(CLIP_REASONS).toContain(reason);
  });
});

describe("CLIP_REASONS_RU: one text per reason, verbatim from §5.2", () => {
  const TEXTS: Record<string, string> = {
    "no-motion": "Для этого кадра движение не подобрать: лица не видно.",
    "not-a-gallery-photo": "Оживить можно только кадр из галереи аватара — импортированное фото и варианты мастер-портрета не оживляются.",
    "age-unverified": "Этот кадр не прошёл проверку возраста — его не оживляем.",
    "photo-unreadable": "Файл этого фото не читается — проверьте папку библиотеки.",
    "not-vertical": "Кадр не вертикальный 9:16 — оживить нельзя.",
    "bold-off": "Кадры «Смелой» пока не оживляются.",
    "unknown-motion": "Это движение больше недоступно — откройте «Оживить» заново.",
    "grok-not-offered": "Grok сейчас не предлагается для этого клипа.",
    "download-expired": "Файл у OpenRouter больше недоступен — скачать снова нельзя.",
    "not-ready": "Клип ещё не готов.",
    "not-exported": "Сначала сохраните клип в папку.",
    "one-at-a-time": "Сейчас снимается другой клип — дождитесь его (обычно 1–3 минуты).",
    "job-running": "С этим клипом сейчас идёт работа — дождитесь её окончания.",
    submitted: "Клип уже отправлен — отменить нельзя.",
    // 5b.2 (S5.WA1), from mockups 44b and 57c.
    "file-damaged": "Файл клипа в Studio повреждён или не читается — для монтажа его не подготовить.",
    "in-use": "Клип сейчас в рендере — удалите его, когда рендер закончится.",
    // 5b.2 (S5.WB1), mockups 37e and the sheet's busy line (plan s5b2 §5.2.1).
    "batch-running": "Сейчас снимаются клипы пакета — дождитесь окончания или отмените оставшиеся.",
    "clip-busy": "Сейчас снимается клип — предложить или перевести движение можно после него.",
    // 5b.2 (S5.WC1), the owner's texts (plan s5b2 §5.3; mockups 62a, 59e).
    "motion-busy": "Подождите: идёт подбор движения или перевод.",
    "suggest-busy": "Движения для этого фото уже подбираются — дождитесь ответа.",
    "idea-busy": "Идея для этого фото уже переводится — дождитесь ответа.",
    "motions-full": "Для этого фото больше нельзя добавить движений — выберите другое фото.",
  };

  test("every reason has its text, word for word", () => {
    for (const reason of CLIP_REASONS) expect<string>(CLIP_REASONS_RU[reason]).toBe(TEXTS[reason] ?? "<missing from the test>");
  });

  test("the table has no text for a reason that is not in the set", () => {
    expect(Object.keys(CLIP_REASONS_RU).sort()).toEqual([...CLIP_REASONS].sort());
  });
});

describe("the export texts (owner Q-C: re-encoded 1080 × 1920, metadata cleaned)", () => {
  test("the line under a saved clip names the size, the frame rate and the cleaned metadata", () => {
    expect(clipExportLineRu("1080p30-interp")).toBe("1080 × 1920 · 30 к/с · метаданные очищены");
    expect(clipExportLineRu("1080p30-dup")).toBe("1080 × 1920 · 30 к/с · метаданные очищены");
  });

  test("the native 24 fps profile says 24, never 30", () => {
    expect(clipExportLineRu("1080p24")).toBe("1080 × 1920 · 24 к/с · метаданные очищены");
  });

  test("a failed export says the Studio file is intact", () => {
    expect(CLIP_EXPORT_FAILED_RU).toBe("Не удалось сохранить клип в папку — файл в Studio цел. Попробуйте ещё раз.");
  });

  // S5.V8 follow-up (additive): an export that stops on the library's own file — not the bytes its record names, or a file the walker or ffmpeg refuses — must not say «файл цел».
  test("an export stopped by the clip's own file in Studio is told apart by its detail and says the file is damaged, never that it is intact", () => {
    expect(CLIP_FILE_DAMAGED_DETAIL).toBe("the clip's file in Studio is damaged or unreadable: it is not the file its record names");
    expect(EngineError.parse({ code: "INTERNAL", detail: CLIP_FILE_DAMAGED_DETAIL }).detail).toBe(CLIP_FILE_DAMAGED_DETAIL);
    expect(CLIP_FILE_DAMAGED_RU).toBe("Файл клипа в Studio повреждён или не читается — сохранить его в папку нельзя.");
    expect(CLIP_FILE_DAMAGED_RU).not.toContain("цел");
  });

  test("no export text claims a device, a place or that the clip is not AI (I5.58)", () => {
    const texts = [clipExportLineRu("1080p30-interp"), clipExportLineRu("1080p24"), CLIP_EXPORT_FAILED_RU, CLIP_REASONS_RU["not-exported"], CLIP_REASONS_RU["not-ready"]].join("\n");
    expect(texts).not.toMatch(/iphone|apple|снято на|gps|не ии|не ai|not ai/i);
  });
});

describe("EngineError.priceScope", () => {
  test("`video` is accepted with PRICE_UNAVAILABLE", () => {
    expect(EngineError.parse({ code: "PRICE_UNAVAILABLE", priceScope: "video" }).priceScope).toBe("video");
  });

  test("`bold` behaves as before", () => {
    expect(EngineError.parse({ code: "PRICE_UNAVAILABLE", priceScope: "bold" }).priceScope).toBe("bold");
    expect(EngineError.safeParse({ code: "PRICE_CHANGED", priceScope: "bold" }).success).toBe(false);
  });

  test("`video` is refused with any other code", () => {
    for (const code of ["PRICE_CHANGED", "VALIDATION", "INTERNAL", "BUDGET_EXCEEDED"]) expect(EngineError.safeParse({ code, priceScope: "video" }).success).toBe(false);
  });

  test("a scope that is neither bold nor video is refused", () => {
    expect(EngineError.safeParse({ code: "PRICE_UNAVAILABLE", priceScope: "text" }).success).toBe(false);
  });

  test("an error with no scope has no `priceScope` key", () => {
    expect("priceScope" in EngineError.parse({ code: "PRICE_UNAVAILABLE" })).toBe(false);
  });

  test("the window's text for the video scope is verbatim from §5.2", () => {
    expect(PRICE_SCOPES_RU.video).toBe("Цены видео у OpenRouter сейчас не читаются — клип не запустить. Фото работают как обычно.");
  });

  test("the bold text is the one 5a.3 shipped", () => {
    expect(PRICE_SCOPES_RU.bold).toBe("Цена Seedream 2K сейчас недоступна — «Смелую» не запустить. Остальное работает как обычно.");
  });
});

describe("MoneyStatus.reconcileAvailableAt", () => {
  const open = { ledger: "open", month: "2026-10", monthlyBudgetMicros: 20_000_000, spentMicros: 0, unsettledMicros: 504_000, unsettledCount: 1, reconcileNeeded: true, reconcileReasons: ["open-reserves"], halt: null };
  const unavailable = { ledger: "unavailable", month: "2026-10", monthlyBudgetMicros: 20_000_000, reconcileNeeded: false, reconcileReasons: [], halt: { cause: "LEDGER_CORRUPT", detail: "x" } };

  test("an old status without it still parses and gains no key", () => {
    const parsed = MoneyStatus.parse(open);
    expect("reconcileAvailableAt" in parsed).toBe(false);
    expect(parsed).toEqual(open as never);
  });

  test("an open status may carry it, as a time", () => {
    const parsed = MoneyStatus.parse({ ...open, reconcileAvailableAt: "2026-10-13T10:20:00.000Z" });
    expect(parsed).toMatchObject({ ledger: "open", reconcileAvailableAt: "2026-10-13T10:20:00.000Z" });
  });

  test("it is refused on the unavailable variant", () => {
    expect(MoneyStatus.safeParse({ ...unavailable, reconcileAvailableAt: "2026-10-13T10:20:00.000Z" }).success).toBe(false);
    expect(MoneyStatus.safeParse(unavailable).success).toBe(true);
  });

  test("it is refused when it is not a time", () => {
    expect(MoneyStatus.safeParse({ ...open, reconcileAvailableAt: "soon" }).success).toBe(false);
    expect(MoneyStatus.safeParse({ ...open, reconcileAvailableAt: 1_760_000_000_000 }).success).toBe(false);
  });
});

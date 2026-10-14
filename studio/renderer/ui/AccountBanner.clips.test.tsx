import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { MoneyStatus, Settings } from "../../shared/engine";
import { CLIP_RESTART_BANNER, clipReconcileWaitText } from "../../shared/engine/clipRestartTexts";
import type { EngineView, JobView } from "../engine/store";
import { createNavigation, NavigationProvider } from "../navigation";
import { AccountBanner } from "./AccountBanner";

// Stage 5, 5b.1, S5.V8 (plan s5b1 §5.12, §6 46; README §S5.VD decision 6, review M6): while the reconcile cannot run yet — the quiet rule after a restart, or a clip that may still bill
// (I5.48) — the one banner «Нужна сверка расходов» says when, as the engine dates it (`MoneyStatus.reconcileAvailableAt`), and shows no «Перейти к сверке»: it would only meet «сверка через
// N мин». A clip that was in work when Studio closed says so for the restart's first minutes. A clip reserve that is merely held stops nothing, so it raises no banner of its own.

const MINUTE = 60_000;

const SETTINGS: Settings = {
  apiKey: { stored: true, last4: "3f2a", encryptionAvailable: true, rejected: false },
  musicKey: { stored: false, last4: null, rejected: false },
  monthlyBudgetMicros: 10_000_000,
  libraryPath: "/Users/studio/Studio/library",
  imageModel: "x-ai/grok-imagine-image-2.0",
  imageQuality: "low",
  textModel: "x-ai/grok-4.3",
  cameraRealism: false,
  concurrency: { network: 6 },
  imageAgeCheck: "off",
  exportPath: "/Users/studio/Studio/export",
  renderConcurrency: "auto",
};

function money(over: { reconcileNeeded: boolean; availableInMs?: number }): MoneyStatus {
  return {
    ledger: "open",
    month: "2026-10",
    monthlyBudgetMicros: 10_000_000,
    spentMicros: 1_000_000,
    unsettledMicros: over.reconcileNeeded ? 504_000 : 504_000,
    unsettledCount: 1,
    reconcileNeeded: over.reconcileNeeded,
    reconcileReasons: over.reconcileNeeded ? ["open-reserves"] : [],
    halt: null,
    ...(over.availableInMs === undefined ? {} : { reconcileAvailableAt: new Date(Date.now() + over.availableInMs).toISOString() }),
  };
}

const recoveryJob: JobView = {
  jobId: "job-00000001",
  kind: "clip",
  avatarId: "avatar-nini-0001",
  runId: null,
  montageId: null,
  videoId: null,
  status: "running",
  saving: false,
  done: 0,
  total: 4,
  result: null,
  error: null,
  clip: { clipId: "clip-00000001", phase: "recovering", model: null, submittedAt: null, proveUntil: null, recovery: true, export: false },
};

function view(m: MoneyStatus, jobs: readonly JobView[] = []): EngineView {
  return {
    phase: "ready",
    failure: null,
    bootId: "boot-1",
    lastSeq: 1,
    settings: SETTINGS,
    money: m,
    exportStatus: null,
    music: null,
    avatars: [],
    drafts: [],
    unreadableAvatars: [],
    unreadableTotal: 0,
    jobs,
    imports: [],
    renderBatch: new Set(),
    engineError: null,
    notices: [],
    autopilot: null,
    cancellingJobs: new Set(),
    paidInFlightAvatars: new Set(),
    avatarDeleteNotices: [],
  };
}

function show(v: EngineView): void {
  render(
    <NavigationProvider value={createNavigation(() => {})}>
      <AccountBanner view={v} />
    </NavigationProvider>,
  );
}

const goReconcile = () => screen.queryByRole("button", { name: "Перейти к сверке" });

describe("«Нужна сверка расходов» while the reconcile cannot run yet", () => {
  test("held by a clip that may still bill: «Сверка ждёт окончания клипа — до HH:MM.» and no «Перейти к сверке»", () => {
    const m = money({ reconcileNeeded: true, availableInMs: 30 * MINUTE });
    show(view(m));
    expect(screen.getByText("Нужна сверка расходов")).toBeDefined();
    expect(screen.getByText(clipReconcileWaitText(Date.parse(m.ledger === "open" ? (m.reconcileAvailableAt ?? "") : "")))).toBeDefined();
    expect(goReconcile()).toBeNull();
  });

  test("46: right after a restart with a clip in work, the restart's line, and no «Перейти к сверке»", () => {
    show(view(money({ reconcileNeeded: true, availableInMs: 4 * MINUTE }), [recoveryJob]));
    expect(screen.getByText(CLIP_RESTART_BANNER)).toBeDefined();
    expect(goReconcile()).toBeNull();
  });

  test("46 #held: the recovering clip may still bill past the restart's minutes: the time it waits for", () => {
    const m = money({ reconcileNeeded: true, availableInMs: 40 * MINUTE });
    show(view(m, [recoveryJob]));
    expect(screen.queryByText(CLIP_RESTART_BANNER)).toBeNull();
    expect(screen.getByText(/^Сверка ждёт окончания клипа — до \d\d:\d\d\.$/)).toBeDefined();
    expect(goReconcile()).toBeNull();
  });

  test("once the time has come the button is back and the clip's line goes", () => {
    show(view(money({ reconcileNeeded: true, availableInMs: -MINUTE }), [recoveryJob]));
    expect(goReconcile()).not.toBeNull();
    expect(screen.queryByText(CLIP_RESTART_BANNER)).toBeNull();
    expect(screen.queryByText(/Сверка ждёт окончания клипа/)).toBeNull();
  });

  test("with no date at all (nothing holds the reconcile) the banner is as before", () => {
    show(view(money({ reconcileNeeded: true })));
    expect(goReconcile()).not.toBeNull();
    expect(screen.getByText(/Платные запросы остановлены до сверки\./)).toBeDefined();
  });

  test("a clip reserve that is only held stops no paid work, so there is no banner (I5.48: not a reconcile reason)", () => {
    show(view(money({ reconcileNeeded: false, availableInMs: 30 * MINUTE })));
    expect(screen.queryByText("Нужна сверка расходов")).toBeNull();
  });
});

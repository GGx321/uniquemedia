import { useEffect, useId, useRef, useState } from "react";
import type { AvatarSummary, EngineError, LaunchView, SceneSetView } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import type { EngineView } from "../../engine/store";
import { countOf } from "../../lib/format";
import { formatUsdTiered } from "../../lib/money";
import { useNavigate } from "../../navigation";
import { Icon } from "../../ui/Icon";
import { ErrorNotice, Notice } from "../../ui/Notice";
import { bandText, launchGo, launchSetMeta, overPlanText, type LaunchLink } from "./launchSet";
import { about, useImagesPrice } from "./scenePaid";
import { setCategoryTags } from "./sceneReview";
import { modelSegments, setMetaText, Step } from "./SceneStrip";
import { MODELS_LINE_TITLE, priceSourceText, SCENES_CHANGED_APPROVE, stepScenes, stripAnglesText } from "./sceneText";
import { useMounted } from "./shared";

// S4.9b: the strip of a launch's scene set on «Фото» (PhotosS4.dc.html: review, review-paused, overplan, drawing; README decision 10). Over it, the launch's
// band «Набор запуска от 14:02 · в пределах запуска · до $Y» with «Открыть «Автопилот»». No «Сцены на проверку» switch (the launch has its own), no
// «Пересоставить…» and no «Мои категории»: the set is the launch's. The price column ends on «Предел до $Y — в пределах запуска, новых денег нет». The
// one button is «Продолжить запуск: M фото» (`autopilot.continueAfterReview` with the view's set and revision), or «Сцены принять» while the launch is
// paused; after it, «принято — ждёт «Продолжить»» or «в запуске автопилота».

const PHOTOS = ["фото", "фото", "фото"] as const;

export interface LaunchSetStripProps {
  readonly avatar: AvatarSummary;
  readonly view: EngineView;
  readonly set: SceneSetView;
  readonly link: LaunchLink;
  /** Opened from «Автопилот» for these scenes: the focus starts on the button (the design's keyboard table). */
  readonly focusGo: boolean;
}

export function LaunchSetStrip({ avatar, view, set, link, focusGo }: LaunchSetStripProps) {
  const { client } = useEngine();
  const navigate = useNavigate();
  const mounted = useMounted();
  const ids = useId();
  const goRef = useRef<HTMLButtonElement>(null);
  const acceptedRef = useRef<HTMLSpanElement>(null);
  const [sending, setSending] = useState<{ pending: boolean; over: LaunchView } | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [overPlan, setOverPlan] = useState(false);
  const [changed, setChanged] = useState(false);
  const [focusAccepted, setFocusAccepted] = useState(false);

  const { row, launch } = link;
  const go = launchGo(link);
  const band = bandText(link);
  const photos = go.kind === "continue" ? go.photos : (row.continuePhotos ?? row.photos.total);
  // The images' own estimate (free, the same as the set's «Отрисовать» would show): the price column's source and step 2 while the scenes wait.
  const images = useImagesPrice(avatar.avatarId, photos, view);

  // Opened from «Автопилот» («Открыть «Фото»»): the focus starts on the button, once.
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!focusGo || focusedOnce.current || go.kind !== "continue") return;
    focusedOnce.current = true;
    goRef.current?.focus();
  }, [focusGo, go.kind]);
  // «Сцены принять» recorded the approval: the button gives way to «принято — ждёт «Продолжить»», which takes the focus (README «Клавиатура и фокус»).
  useEffect(() => {
    if (!focusAccepted || go.kind !== "accepted") return;
    acceptedRef.current?.focus();
    setFocusAccepted(false);
  }, [focusAccepted, go.kind]);

  // An over-plan refusal holds until the set moves (a scene removed raises the revision the view names).
  const revision = row.setRevision;
  useEffect(() => setOverPlan(false), [revision]);
  const blocked = overPlan;
  // Round 1 M4: busy from the click until the engine's next word on the launch (the view the click was sent over is `sending.over`): an accepted click
  // never sends again from a view that does not know of it yet; a second click before React re-renders is stopped by the ref.
  const inFlight = useRef(false);
  const busy = sending !== null && (sending.pending || sending.over === launch);
  useEffect(() => {
    if (sending !== null && !sending.pending && sending.over !== launch) setSending(null);
  }, [sending, launch]);
  const canSend = go.kind === "continue" && !busy && !blocked && row.sceneSetId !== null && row.setRevision !== null;

  async function send(): Promise<void> {
    if (inFlight.current || !canSend || row.sceneSetId === null || row.setRevision === null) return;
    inFlight.current = true;
    const over = launch;
    setSending({ pending: true, over });
    setError(null);
    setChanged(false);
    const reply = await client.request("autopilot.continueAfterReview", { launchId: launch.launchId, avatarId: avatar.avatarId, sceneSetId: row.sceneSetId, revision: row.setRevision });
    inFlight.current = false;
    if (!mounted.current) return;
    setSending(reply.ok ? { pending: false, over } : null);
    if (reply.ok) {
      if (reply.result.draw === "waits-for-resume") setFocusAccepted(true);
      return;
    }
    if (reply.error.code === "SCENES_CHANGED") {
      // The set moved since the view's revision: the number on the button follows the engine's next word; the focus stays.
      setChanged(true);
      return;
    }
    if (reply.error.code === "VALIDATION" && reply.error.sceneReason === "over-plan") {
      setOverPlan(true);
      return;
    }
    setError(reply.error);
  }

  // ---------- the left block ----------

  const tags = setCategoryTags(set);
  const meta = launchSetMeta(setMetaText(set));
  const models = modelSegments(view, set.textModel);
  const step1 = stepScenes(set);
  const allocation = row.drawAllocationMicros;
  const drawing = go.kind === "in-launch" && row.photos.done > 0;
  const step2Value = drawing ? `${row.photos.done} из ${row.photos.total}` : images === null ? "≈ …" : about(images.expectedMicros);
  const step2State = drawing ? (row.photos.done >= row.photos.total ? "done" : "current") : go.kind === "continue" ? "current" : "next";
  const whyId = `${ids}-why`;
  const reason = overPlan ? overPlanText(row) : go.kind === "continue" ? go.why : null;

  return (
    <>
      <section className="card ap-launch-set" aria-label="Набор сцен запуска">
        <div className="ap-band" role="note">
          <Icon name="bolt" size={15} />
          <span className="ap-band-title">{band.title}</span>
          <span className="mono muted ap-band-meta">{band.meta}</span>
          <button type="button" className="lbtn ap-band-open" onClick={() => navigate({ name: "section", id: "autopilot" })}>
            Открыть «Автопилот»
            <Icon name="forward" size={12} strokeWidth={2.4} />
          </button>
        </div>

        <div className="photos-gen scene-strip ap-launch-strip">
          <div className="scene-strip-main">
            <div className="scene-strip-head">
              <span className="lbl nowrap">Набор сцен</span>
              <span className="mono faint scene-strip-meta">{meta}</span>
            </div>
            <div className="scene-strip-tags" role="list" aria-label="Категории набора">
              {tags.map((tag) => (
                <span key={tag.ref} role="listitem" className="tag scene-strip-tag" title={tag.label}>
                  <span className="scene-strip-tag-name">{tag.label}</span>
                  <span className="mono scene-strip-tag-n">{tag.count}</span>
                </span>
              ))}
            </div>
            <div className="scene-strip-foot">
              <p className="scene-strip-lock">
                <Icon name="lock" size={12} strokeWidth={2.4} />
                <span>
                  {stripAnglesText(set)}. Пока идёт запуск, набор не пересоставить и не удалить — вместо «Пересоставить…» <span className="ap-in ap-in-s">в запуске автопилота</span>
                </span>
              </p>
              {models.length > 0 && (
                <p className="faint scene-strip-models" title={MODELS_LINE_TITLE}>
                  {models.map((segment, i) => (
                    <span key={segment}>
                      <span className="nowrap">{segment}</span>
                      {i < models.length - 1 && " · "}
                    </span>
                  ))}
                </p>
              )}
            </div>
          </div>

          <div className="photos-gen-side scene-strip-prices">
            <div className="mono photos-cost-row">
              <span>Цены</span>
              <span className={images?.prices === "fallback" ? "warn-text" : "faint"}>{priceSourceText(images?.prices ?? null, images?.pricesAsOf ?? null)}</span>
            </div>
            <Step row={{ n: "1", state: step1.done ? "done" : "current", label: step1.label, value: step1.value }} />
            <Step row={{ n: "2", state: step2State, label: countOf(photos, PHOTOS), value: step2Value }} />
            <div className="mono photos-cost-row">
              <span>Проверка возраста</span>
              <span className={view.settings?.imageAgeCheck === "on" ? undefined : "faint"}>{view.settings?.imageAgeCheck === "on" ? "вкл." : "выкл."}</span>
            </div>
            <div className="mono photos-cost-row photos-cost-total">
              <span>Предел</span>
              <span>{allocation === null ? "—" : `до ${formatUsdTiered(allocation, "up")}`}</span>
            </div>
            <div className="mono faint scene-total-sub">в пределах запуска — новых денег нет</div>
          </div>

          <div className="photos-gen-side scene-strip-go ap-launch-go">
            {go.kind === "continue" && (
              <>
                <span className="faint ap-launch-help">{go.help}</span>
                <button
                  ref={goRef}
                  type="button"
                  className="btn btn-p btn-stack photos-go ap-launch-btn"
                  aria-disabled={canSend ? undefined : true}
                  aria-busy={busy || undefined}
                  aria-describedby={reason !== null ? whyId : undefined}
                  onClick={canSend ? () => void send() : undefined}
                >
                  <span className="btn-stack-line">
                    {busy && <span className="spin" aria-hidden="true" />}
                    {go.title}
                  </span>
                  {(overPlan || go.sub !== null) && (
                    <>
                      <span className="sr-only"> · </span>
                      <span className="mono">{overPlan ? `в плане ${row.photos.total}` : go.sub}</span>
                    </>
                  )}
                </button>
                {reason !== null && (
                  <p id={whyId} className={overPlan ? "ap-launch-why danger-text" : "faint ap-launch-why"}>
                    {reason}
                  </p>
                )}
              </>
            )}
            {go.kind === "accepted" && (
              <>
                <span ref={acceptedRef} className="ap-in ap-launch-accepted" tabIndex={-1}>
                  <Icon name="check" size={12} strokeWidth={2.6} />
                  принято — ждёт «Продолжить»
                </span>
                <span className="faint ap-launch-help">{go.text}</span>
              </>
            )}
            {(go.kind === "in-launch" || go.kind === "writing") && (
              <>
                <span className="ap-in ap-launch-mark" tabIndex={-1}>
                  <Icon name="bolt" size={12} />в запуске автопилота
                </span>
                <span className="faint ap-launch-help">{go.text}</span>
              </>
            )}
            {go.kind === "stopping" && (
              <>
                <span className="ap-in ap-launch-mark" tabIndex={-1}>
                  <span className="spin ap-btn-spin" aria-hidden="true" />
                  запуск останавливается
                </span>
                <span className="faint ap-launch-help">{go.text}</span>
              </>
            )}
          </div>
        </div>
      </section>
      {changed && (
        <Notice
          tone="warn"
          title="Набор изменился"
          actions={
            <button type="button" className="btn btn-s" onClick={() => setChanged(false)}>
              Понятно
            </button>
          }
        >
          {SCENES_CHANGED_APPROVE}
        </Notice>
      )}
      {error !== null && <ErrorNotice error={error} />}
    </>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import { AvatarName, type EngineError, type Estimate } from "../../shared/engine";
import { useEngine, useEngineView } from "../engine/react";
import { NBSP } from "../lib/format";
import { IMPORT_GOOD_SHORT_SIDE, isSmallImportPhoto } from "../lib/importPhoto";
import { formatUsd } from "../lib/money";
import { paidStop, restartStopText } from "../lib/paidStop";
import { useNavigate } from "../navigation";
import { AccountBanner } from "../ui/AccountBanner";
import { EngineOffline } from "../ui/EngineOffline";
import { Icon, Spin } from "../ui/Icon";
import { Notice } from "../ui/Notice";
import { ScreenTitle } from "../ui/ScreenTitle";
import { EstimateCard } from "./wizard/EstimateCard";

type Busy = "pick" | "import" | null;

/**
 * T6c review round 2, M4: the engine's own pixel cap on an imported photo
 * (studio/node/downscale.ts's MAX_SOURCE_PIXELS, enforced for free in
 * checkImportPhoto before anything is downscaled) — the renderer cannot
 * import that module (it is Node-only, not portable to this bundle), so this
 * is its own copy, expressed the friendly way a total pixel budget usually
 * is (a square of this side); AvatarImport.test.tsx cross-checks the number
 * itself against the real one.
 */
const MAX_IMPORT_PHOTO_SIDE = 4096; // 4096×4096 = 16_777_216px, MAX_SOURCE_PIXELS exactly

function nameIssue(name: string): string | null {
  const parsed = AvatarName.safeParse(name);
  if (parsed.success) return null;
  if (name.trim().length === 0) return "Введите имя.";
  if (name.length > 60) return "Не длиннее 60 символов.";
  return "Уберите невидимые и управляющие символы.";
}

/**
 * "Импортировать аватара" (T6c): the owner uploads one master photo he
 * already has, instead of generating one from a prompt. Flow: pick a photo
 * (main's own dialog — the renderer never sends a path or raw bytes, design
 * constraint 1) → see the estimate for that exact photo → enter a name →
 * confirm. Nothing is spent before the last click: the vision description
 * runs inside `avatars.importAvatar` itself. Owner decision 2026-10-05
 * (personal-use app): no age check and no AI-persona confirmation.
 */
export function AvatarImport() {
  const { client, store } = useEngine();
  const view = useEngineView();
  const navigate = useNavigate();
  const nameId = useId();
  const nameErrorId = useId();

  const [stagingId, setStagingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ width: number; height: number } | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [previousWorst, setPreviousWorst] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [showNameIssue, setShowNameIssue] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<EngineError | null>(null);
  // False once the user has left the screen: a paid step already under way must not set state on an unmounted component.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const key = view.settings?.apiKey;
  const keyUsable = key !== undefined && key.stored && !key.rejected;
  const stop = paidStop(view);
  const offline = view.phase === "offline";

  /** Design constraint 1: pick, then estimate for that exact staged photo — never the other way round. */
  async function pickPhoto(): Promise<void> {
    setBusy("pick");
    setError(null);
    const picked = await client.request("avatars.pickImportPhoto", {});
    if (!mounted.current) return;
    if (!picked.ok) {
      setBusy(null);
      setError(picked.error);
      return;
    }
    if (!picked.result.picked) {
      setBusy(null); // a plain cancel, never an error
      return;
    }
    setStagingId(picked.result.stagingId);
    setPreview({ width: picked.result.width, height: picked.result.height });
    setEstimate(null);
    setPreviousWorst(null);

    const priced = await client.request("avatars.estimateImport", { stagingId: picked.result.stagingId });
    if (!mounted.current) return;
    setBusy(null);
    if (priced.ok) setEstimate(priced.result);
    else setError(priced.error);
  }

  async function confirmImport(): Promise<void> {
    setShowNameIssue(true);
    if (stagingId === null || estimate === null || nameIssue(name) !== null) return;
    setBusy("import");
    setError(null);
    const reply = await client.request("avatars.importAvatar", {
      stagingId,
      name: name.trim(),
      acceptedWorstMicros: estimate.worstMicros,
    });
    if (!mounted.current) return;
    if (reply.ok) {
      setBusy(null);
      store.saveAvatar(reply.result.avatar);
      // S5.0d (owner's decision): the import ends on the new avatar's «Внешность», with the check the import ran itself (null: none came back).
      navigate({
        name: "photos",
        avatarId: reply.result.avatar.avatarId,
        tab: "look",
        landing: { kind: "imported", check: reply.result.descriptorCheck ?? null },
      });
      return;
    }
    if (reply.error.code === "PRICE_CHANGED") {
      const fresh = await client.request("avatars.estimateImport", { stagingId });
      if (!mounted.current) return;
      setBusy(null);
      if (fresh.ok) {
        setEstimate(fresh.result);
        setPreviousWorst(estimate.worstMicros);
        return;
      }
      setError(fresh.error);
      return;
    }
    // T6c review round 3, L4: never guess "consumed or not" from the error
    // code (BUDGET_EXCEEDED and, on a future code, others too, are raised
    // both by the free pre-check — before the stage is ever touched — and
    // from inside the paid job, after it is gone). Ask the engine itself,
    // with the one free command that already answers exactly this: NOT_FOUND
    // means the stage is gone, back to step 1; ok means it is still exactly
    // what it was, nothing here needs to change.
    const probe = await client.request("avatars.estimateImport", { stagingId });
    if (!mounted.current) return;
    setBusy(null);
    if (!probe.ok && probe.error.code === "NOT_FOUND") {
      setStagingId(null);
      setPreview(null);
      setEstimate(null);
      setPreviousWorst(null);
    }
    setError(reply.error);
  }

  let blockedReason: string | null = null;
  if (stop?.kind === "offline") blockedReason = "Нет связи с движком — дождитесь, пока он снова ответит.";
  else if (!keyUsable) blockedReason = "Нужен рабочий ключ OpenRouter — добавьте его в Настройках.";
  else if (stop?.kind === "reconcile") blockedReason = "Платные запросы остановлены до сверки расходов.";
  else if (stop?.kind === "restart") blockedReason = restartStopText(stop.code);

  const nameProblem = nameIssue(name);

  return (
    <div className="page page-bounded page-import">
      <header className="page-head">
        <div>
          <button type="button" className="back-link" onClick={() => navigate({ name: "avatars" })}>
            <Icon name="back" size={14} strokeWidth={2.2} />
            Аватары
          </button>
          <ScreenTitle>Импортировать аватара</ScreenTitle>
        </div>
      </header>

      {offline ? <EngineOffline view={view} /> : <AccountBanner view={view} />}

      <div className="wizard">
        <section className="card wizard-form" aria-labelledby="import-photo-title">
          <div className="wizard-form-head">
            <h2 id="import-photo-title" className="lbl">
              Фото
            </h2>
            {preview && (
              <span className="tag">
                выбрано · {preview.width}×{preview.height}{NBSP}px
              </span>
            )}
          </div>
          <p className="muted">
            Один кадр аватара, который у вас уже есть. PNG, JPEG или WebP, до 20{NBSP}МБ и не крупнее {MAX_IMPORT_PHOTO_SIDE}×
            {MAX_IMPORT_PHOTO_SIDE}
            {NBSP}px; анимированные файлы не подходят.
          </p>
          {/* The large-screen audit (H2): advice next to the picked size, never a refusal — the import goes ahead either way. */}
          {preview && isSmallImportPhoto(preview) && (
            <Notice tone="warn" role="status">
              Маленькое фото ({preview.width}×{preview.height}
              {NBSP}px) — портрет и сгенерированные фото будут нечёткими. Лучше от {IMPORT_GOOD_SHORT_SIDE}
              {NBSP}px по короткой стороне.
            </Notice>
          )}
          {/* S5.2d (mockup 04): what the paid click reads, said before it — the body only when the photo shows it, and then the owner's own choice. */}
          {preview && (
            <>
              <div className="import-reads-block">
                <p className="fl">Что прочитает Studio</p>
                <ul className="import-reads">
                  <li>
                    <Icon name="check" size={14} strokeWidth={2.4} />
                    лицо, волосы, глаза, приметы
                  </li>
                  <li className="import-reads-maybe">
                    <Icon name="info" size={14} strokeWidth={2} />
                    тело — только если оно в кадре
                  </li>
                  <li>
                    <Icon name="check" size={14} strokeWidth={2.4} />
                    сверит описание с фото
                  </li>
                </ul>
              </div>
              <Notice tone="info" title="По фото лица тело не определить" role="status">
                Если на фото только лицо и плечи, рост, грудь, фигуру, ноги и попу после импорта выберете сами — или оставите «не задано».
              </Notice>
            </>
          )}
          <div className="wizard-form-footer">
            <button
              type="button"
              className={stagingId ? "btn" : "btn btn-p"}
              onClick={() => void pickPhoto()}
              disabled={busy !== null}
              aria-busy={busy === "pick"}
            >
              {busy === "pick" ? (
                <>
                  <Spin />
                  Выбираем…
                </>
              ) : (
                <>
                  <Icon name="upload" size={16} strokeWidth={2.2} />
                  {stagingId ? "Выбрать другое фото" : "Выбрать фото"}
                </>
              )}
            </button>
          </div>
        </section>

        <div className="wizard-side">
          <EstimateCard
            estimate={estimate}
            previousWorst={previousWorst}
            estimating={busy === "pick"}
            action={null}
            blockedReason={null}
            error={error}
            repeat={false}
            variant="import"
          />

          {stagingId && estimate && (
            <section className="import-confirm" aria-labelledby="import-confirm-title">
              <h2 id="import-confirm-title" className="sr-only">
                Подтверждение
              </h2>
              <div className="save-bar">
                <div className="field">
                  <label className="fl" htmlFor={nameId}>
                    Имя <span className="faint">· в промпты не уходит</span>
                  </label>
                  <input
                    id={nameId}
                    className="in"
                    type="text"
                    value={name}
                    maxLength={80}
                    autoComplete="off"
                    placeholder="Mia"
                    aria-invalid={showNameIssue && nameProblem !== null}
                    aria-describedby={showNameIssue && nameProblem ? nameErrorId : undefined}
                    onChange={(e) => setName(e.currentTarget.value)}
                    onBlur={() => name !== "" && setShowNameIssue(true)}
                  />
                  {showNameIssue && nameProblem && (
                    <p id={nameErrorId} className="field-error" role="alert">
                      {nameProblem}
                    </p>
                  )}
                </div>
                <div className="save-action">
                  <button
                    type="button"
                    className="btn btn-p"
                    disabled={busy !== null || blockedReason !== null}
                    aria-busy={busy === "import"}
                    onClick={() => void confirmImport()}
                  >
                    {busy === "import" ? (
                      <>
                        <Spin />
                        Импортируем…
                      </>
                    ) : previousWorst !== null
                        ? `Подтвердить новую цену · до ${formatUsd(estimate.worstMicros, 2, "up")}`
                        : `Импортировать · до ${formatUsd(estimate.worstMicros, 2, "up")}`}
                  </button>
                  {blockedReason ? <p className="field-hint">{blockedReason}</p> : <p className="field-hint">Дальше — страница аватара: тело и итог сверки.</p>}
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

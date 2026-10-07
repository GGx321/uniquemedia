import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  CATEGORY_DESCRIPTION_MAX,
  CATEGORY_NAME_MAX,
  MAX_CUSTOM_CATEGORIES,
  POOL_OUTFITS_MIN,
  ScenePose,
  type CategoryInterrupted,
  type CategoryPoses,
  type CategorySummary,
  type CustomCategoryId,
  type EngineError,
  type Estimate,
} from "../../../shared/engine";
import type { CategoryLibrary, CategoryLibraryView } from "../../engine/categoryLibrary";
import { useCategoryLibrary, useEngineView } from "../../engine/react";
import { errorText } from "../../lib/errors";
import { formatUsdTiered } from "../../lib/money";
import { FocusEdge } from "../../ui/FocusEdge";
import { Icon, Spin } from "../../ui/Icon";
import { useConfirmFocus } from "../../ui/useConfirmFocus";
import { useBackdropClose, useModalDialog } from "../../ui/useModalDialog";
import { CARD_POSES, nextPoses, POSE_CHIP } from "./angles";
import { busyElsewhere, categoryPrice, EditablePlace, ShotShares, useSeconds, worstOf } from "./categoryParts";
import {
  ANGLES_CLEAR_TITLE,
  anglesHint,
  anglesLockedTitle,
  anglesSaveFailure,
  categoryMeta,
  deleteConfirmText,
  descriptionProblem,
  impliedChipTitle,
  interruptedText,
  libraryHeld,
  nameProblem,
  outfitsNote,
  overLimitNote,
  placesNote,
  poolCounts,
  REGEN_DONE_TEXT,
  REGEN_HINT,
  regenFailure,
  styleNote,
  unreadableNote,
} from "./categoryText";
import { InterruptedNotice } from "./CategoryNotices";
import type { CreateDialogStart } from "./CategoryCreateDialog";
import { paidBlockedReason } from "./runForm";
import { useMounted } from "./shared";

// CS.3: «Мои категории» (CatSheet, CatSheetRename, CatSheetRegen, CatSheetRegenBusy, CatSheetRegenFailed, CatSheetRegenDone,
// CatSheetDelete; the CategoryStates sheet: empty, limits, unreadable, regenerate failures, interrupted calls). A right-side panel over the
// window (760 px, 680 px under 1440): the list on the left, the selected category on the right — its label for the model, style and spend,
// its description, its pool read-only but for × on a place or an outfit (free, never below the pool's minimums), a rename (free), a
// regeneration with its price (paid, the same call as a create; any failure keeps the old pool and says what it cost), and a delete
// confirmed on the spot with the focus on «Отмена». Escape cancels what is open inside first, then closes the panel.

/** Something open inside the detail that Escape cancels before it closes the panel. */
interface DetailEscape {
  cancel(): boolean;
}

export function CategorySheet({
  onClose,
  onCreate,
  onRetryCreate,
  returnFocus,
  openSetScenes,
}: {
  onClose: () => void;
  /** CS.7 M1: how many scenes of the avatar's open scene set come from a category (0 with no open set). */
  openSetScenes: (categoryId: CustomCategoryId) => number;
  /** Where the focus goes when the panel closes: «Мои категории», which opened it. */
  returnFocus: () => HTMLElement | null;
  /** «Новая», «Создать категорию», an interrupted create's «Изменить описание»: the panel closes and the create dialog opens. */
  onCreate: (start: CreateDialogStart) => void;
  /** An interrupted create's «Создать снова»: a new request at `accepted`, shown in the create dialog. */
  onRetryCreate: (call: CategoryInterrupted, accepted: Estimate) => void;
}) {
  const { library, view } = useCategoryLibrary();
  const ids = useId();
  const titleId = `${ids}-title`;
  const list = view.list;
  const customs = list.status === "ready" ? list.categories : [];
  const [selected, setSelected] = useState<CustomCategoryId | null>(customs[0]?.categoryId ?? null);
  const current = customs.find((c) => c.categoryId === selected) ?? customs[0] ?? null;
  const listRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const emptyRef = useRef<HTMLButtonElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const detailEscape = useRef<DetailEscape | null>(null);

  // The focus goes to the selected category when the panel opens (the empty panel's invitation, or × while the list is still asked for).
  const initialFocus = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current(): HTMLElement | null {
        return listRef.current?.querySelector<HTMLElement>('[aria-current="true"]') ?? emptyRef.current ?? closeRef.current;
      },
    }),
    [],
  );
  const escape = (): void => {
    if (detailEscape.current?.cancel() === true) return;
    onClose();
  };
  // Closing to open the create dialog hands the focus to that dialog, not back to the row.
  const handingOver = useRef(false);
  useModalDialog({ dialog: dialogRef, initialFocus, onClose: escape, returnFocus: () => (handingOver.current ? null : returnFocus()) });
  const create = (start: CreateDialogStart): void => {
    handingOver.current = true;
    onCreate(start);
  };
  const retryCreate = (call: CategoryInterrupted, accepted: Estimate): void => {
    handingOver.current = true;
    onRetryCreate(call, accepted);
  };
  const backdrop = useBackdropClose(onClose, [scrimRef]);

  const focusRow = (categoryId: string | null): void => {
    const row = categoryId === null ? null : listRef.current?.querySelector<HTMLElement>(`[data-row="${categoryId}"]`);
    (row ?? emptyRef.current ?? closeRef.current)?.focus();
  };

  const interruptedCreates = list.status === "ready" ? list.interrupted.filter((c) => c.kind === "create") : [];
  const held = list.status === "ready" ? libraryHeld(list) : null;

  return createPortal(
    <div ref={scrimRef} className="cat-scrim" role="presentation" {...backdrop}>
      <aside ref={dialogRef} className="cat-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <FocusEdge edge="start" />
        <header className="cat-sheet-head">
          <div className="cat-sheet-titles">
            <h2 id={titleId} className="cat-sheet-title">
              Мои категории
            </h2>
            <p className="mono muted cat-sheet-sub">{held === null ? "общие для всех аватаров" : `${held} из ${MAX_CUSTOM_CATEGORIES} · общие для всех аватаров`}</p>
          </div>
          {customs.length > 0 && (
            <button type="button" className="btn btn-s cat-sheet-new" onClick={() => create({ name: "", description: "", focus: "name" })}>
              <Icon name="plus" size={14} strokeWidth={2.4} />
              Новая
            </button>
          )}
          <button ref={closeRef} type="button" className="ibtn" aria-label="Закрыть" onClick={onClose}>
            <Icon name="close" size={14} strokeWidth={2.2} />
          </button>
        </header>

        {interruptedCreates.length > 0 && (
          <div className="cat-sheet-alerts">
            {interruptedCreates.map((call) => (
              <InterruptedNotice
                key={call.jobId}
                call={call}
                library={library}
                slice={view}
                onRetry={(accepted) => retryCreate(call, accepted)}
                onEdit={() => create({ name: call.name, description: call.description, focus: "description" })}
              />
            ))}
          </div>
        )}

        {list.status === "loading" ? (
          <div className="cat-sheet-state" aria-busy="true">
            <Spin />
            <span className="muted">Открываем категории…</span>
          </div>
        ) : list.status === "failed" ? (
          <div className="cat-sheet-state">
            <p className="danger-text">Свои категории не открылись: {errorText(list.error)}</p>
            <button type="button" className="btn btn-s" onClick={() => library.reload()}>
              Повторить
            </button>
          </div>
        ) : customs.length === 0 ? (
          <div className="cat-sheet-empty">
            <span className="tile-icon" aria-hidden="true">
              <Icon name="plus" size={22} strokeWidth={2.2} />
            </span>
            <h3 className="cat-sheet-empty-title">Своих категорий пока нет</h3>
            <p className="muted cat-sheet-empty-text">
              Опишите тему своими словами — модель составит места, наряды и кадры. Категория общая для всех аватаров и встанет в ряд рядом со встроенными.
            </p>
            <button ref={emptyRef} type="button" className="btn btn-p" onClick={() => create({ name: "", description: "", focus: "name" })}>
              Создать категорию
            </button>
            {(list.unreadable > 0 || list.overLimit > 0) && <LibraryNotes unreadable={list.unreadable} overLimit={list.overLimit} />}
          </div>
        ) : (
          <div className="cat-sheet-body">
            <nav ref={listRef} className="cat-sheet-list" aria-label="Категории">
              <div className="cat-sheet-rows">
                {customs.map((c) => {
                  const on = c.categoryId === current?.categoryId;
                  return (
                    <button
                      key={c.categoryId}
                      type="button"
                      className={on ? "lrow lrow-on" : "lrow"}
                      data-row={c.categoryId}
                      aria-current={on}
                      onClick={() => setSelected(c.categoryId)}
                    >
                      <span className="lrow-name">{c.name}</span>
                      <span className="mono faint lrow-meta">{poolCounts(c.pool)}</span>
                    </button>
                  );
                })}
              </div>
              <LibraryNotes unreadable={list.unreadable} overLimit={list.overLimit} />
              <p className="faint cat-sheet-builtins">Встроенные пять — Дом, Путешествия, Фотосессия, Гламур 18+, Фитнес — здесь не показываются и не меняются.</p>
            </nav>
            {current !== null && (
              <CategoryDetail
                key={current.categoryId}
                category={current}
                library={library}
                slice={view}
                escapeRef={detailEscape}
                onDeleted={(index) => {
                  const rest = customs.filter((c) => c.categoryId !== current.categoryId);
                  const next = rest[Math.min(index, rest.length - 1)] ?? null;
                  setSelected(next?.categoryId ?? null);
                  return next?.categoryId ?? null;
                }}
                focusRow={focusRow}
                index={customs.findIndex((c) => c.categoryId === current.categoryId)}
                openSetScenes={openSetScenes(current.categoryId)}
              />
            )}
          </div>
        )}
        <FocusEdge edge="end" />
      </aside>
    </div>,
    document.body,
  );
}

function LibraryNotes({ unreadable, overLimit }: { unreadable: number; overLimit: number }) {
  if (unreadable === 0 && overLimit === 0) return null;
  return (
    <div className="cat-sheet-notes">
      {unreadable > 0 && (
        <p className="cat-sheet-note">
          <Icon name="alert" size={13} />
          {unreadableNote(unreadable)}
        </p>
      )}
      {overLimit > 0 && (
        <p className="cat-sheet-note">
          <Icon name="info" size={13} />
          {overLimitNote(overLimit)}
        </p>
      )}
    </div>
  );
}

function CategoryDetail({
  category,
  library,
  slice,
  escapeRef,
  onDeleted,
  focusRow,
  index,
  openSetScenes,
}: {
  category: CategorySummary;
  library: CategoryLibrary;
  slice: CategoryLibraryView;
  escapeRef: { current: DetailEscape | null };
  /** Gone: the panel selects the next category (or the one before) and answers its id. */
  onDeleted: (index: number) => string | null;
  focusRow: (categoryId: string | null) => void;
  index: number;
  /** CS.7 M1: how many scenes of the avatar's open set come from this category (its delete confirm says what happens to their ⟳). */
  openSetScenes: number;
}) {
  const engine = useEngineView();
  const ids = useId();
  const { categoryId } = category;
  const customs = slice.list.status === "ready" ? slice.list.categories : [];
  const others = customs.filter((c) => c.categoryId !== categoryId);
  const call = slice.call;
  const regenerating = call?.kind === "regenerate" && call.categoryId === categoryId ? call : null;
  const outcome = slice.outcomes.regenerate?.call.categoryId === categoryId ? slice.outcomes.regenerate : null;
  const interrupted = slice.list.status === "ready" ? (slice.list.interrupted.find((i) => i.kind === "regenerate" && i.categoryId === categoryId) ?? null) : null;
  const { estimate } = categoryPrice(engine, slice);
  const blocked = paidBlockedReason(engine);

  // ---------- rename ----------
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(category.name);
  const [renameError, setRenameError] = useState<EngineError | null>(null);
  const [savingName, setSavingName] = useState(false);
  const pencilRef = useRef<HTMLButtonElement>(null);
  const nameFieldRef = useRef<HTMLInputElement>(null);
  const nameProblemText = nameProblem(newName, others, true);

  // ---------- delete ----------
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<EngineError | null>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const confirm = useConfirmFocus();

  // ---------- regenerate ----------
  const [regenOpen, setRegenOpen] = useState(interrupted !== null || outcome?.ok === false || regenerating !== null);
  const [regenText, setRegenText] = useState(regenerating?.description ?? (outcome?.ok === false ? outcome.call.description : (interrupted?.description ?? category.description)));
  const regenFieldRef = useRef<HTMLTextAreaElement>(null);
  const regenLinkRef = useRef<HTMLButtonElement>(null);
  const regenNoticeRef = useRef<HTMLDivElement>(null);
  const seconds = useSeconds(regenerating?.startedAt ?? null);
  const regenFailed = outcome?.ok === false ? outcome : null;
  const regenDone = outcome?.ok === true ? outcome : null;
  const priceChanged = regenFailed !== null && regenFailed.error.code === "PRICE_CHANGED" && estimate !== null ? { was: regenFailed.previousWorstMicros ?? 0, now: estimate.worstMicros } : null;
  const failure = regenFailed !== null && priceChanged === null && regenFailed.error.code !== "PRICE_CHANGED" ? regenFailure(regenFailed.error) : null;
  const otherCall = call !== null && regenerating === null ? call.name : busyElsewhere(slice);
  const descProblem = descriptionProblem(regenText, true);
  const canRegen = regenerating === null && otherCall === null && estimate !== null && blocked === null && descProblem === null;
  const busy = regenerating !== null;

  // «Убрать» on an interrupted regeneration (free): an interrupted regenerate is first counted into the category; a ledger that cannot
  // tell its cost refuses it, and the record stays.
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<EngineError | null>(null);
  async function dismissInterrupted(jobId: string): Promise<void> {
    if (dismissing) return;
    setDismissing(true);
    setDismissError(null);
    const reply = await library.dismissInterrupted(jobId);
    setDismissing(false);
    if (!reply.ok) setDismissError(reply.error);
  }

  // ---------- remove an item ----------
  const [itemError, setItemError] = useState<EngineError | null>(null);
  const [removing, setRemoving] = useState(false);
  const [focusRemove, setFocusRemove] = useState<{ kind: "place" | "outfit"; index: number } | null>(null);
  const placesRef = useRef<HTMLUListElement>(null);
  const outfitsRef = useRef<HTMLDivElement>(null);

  // Escape: the open confirm, the rename, the regenerate box (not while it runs) — before the panel.
  const latest = useRef({ asking, renaming, regenOpen, busy });
  useLayoutEffect(() => {
    latest.current = { asking, renaming, regenOpen, busy };
  });
  useEffect(() => {
    escapeRef.current = {
      cancel: () => {
        const now = latest.current;
        if (now.asking) {
          setAsking(false);
          confirm.moveTo(() => deleteRef.current);
          return true;
        }
        if (now.renaming) {
          setRenaming(false);
          confirm.moveTo(() => pencilRef.current);
          return true;
        }
        if (now.regenOpen && !now.busy) {
          setRegenOpen(false);
          confirm.moveTo(() => regenLinkRef.current);
          return true;
        }
        return false;
      },
    };
    return () => {
      escapeRef.current = null;
    };
  }, [escapeRef, confirm]);

  // A regenerate that answered closes its box (the new pool shows below); one that failed takes the focus to its notice.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      if (regenDone !== null) {
        setRegenOpen(false);
        // «Пересоздать…» comes back with the closed box: the focus goes there once it is drawn.
        confirm.moveTo(() => regenLinkRef.current);
      } else regenNoticeRef.current?.focus();
    }
    wasBusy.current = busy;
  }, [busy, regenDone, confirm]);

  // The outcome was told here: once the owner leaves the category (or the panel), it is not told again.
  const shown = useRef({ outcome, busy });
  useLayoutEffect(() => {
    shown.current = { outcome, busy };
  });
  useEffect(
    () => () => {
      if (shown.current.outcome !== null && !shown.current.busy) library.clearOutcome("regenerate");
    },
    [library],
  );

  // After a × the row goes: the focus goes to the × of the next row (or the one before, if it was the last).
  useEffect(() => {
    if (focusRemove === null) return;
    const root = focusRemove.kind === "place" ? placesRef.current : outfitsRef.current;
    const buttons = Array.from(root?.querySelectorAll<HTMLElement>(`[data-remove="${focusRemove.kind}"]`) ?? []);
    buttons[Math.min(focusRemove.index, buttons.length - 1)]?.focus();
    setFocusRemove(null);
  }, [focusRemove, category]);

  async function saveName(): Promise<void> {
    if (nameProblemText !== null || savingName) return;
    if (newName.trim() === category.name) {
      setRenaming(false);
      confirm.moveTo(() => pencilRef.current);
      return;
    }
    setSavingName(true);
    setRenameError(null);
    const reply = await library.update(categoryId, { name: newName.trim() });
    setSavingName(false);
    if (!reply.ok) {
      setRenameError(reply.error);
      return;
    }
    setRenaming(false);
    confirm.moveTo(() => pencilRef.current);
  }

  async function removeItem(kind: "place" | "outfit", text: string, at: number): Promise<void> {
    if (removing) return;
    setRemoving(true);
    setItemError(null);
    const reply = await library.update(categoryId, kind === "place" ? { removeLocations: [text] } : { removeOutfits: [text] });
    setRemoving(false);
    if (!reply.ok) {
      setItemError(reply.error);
      return;
    }
    setFocusRemove({ kind, index: at });
  }

  // ---------- CS.8: the angles (free, saved at once, one save at a time) ----------
  // A press shows at once and is sent at once (`categories.update { poses }`); while it is on its way the group is busy and every press waits; a refusal
  // flips the chips back and the hint says why. The chips stay mounted, so the focus stays on the one pressed.
  const [anglesSaving, setAnglesSaving] = useState<{ readonly poses: CategoryPoses | null } | null>(null);
  const [anglesError, setAnglesError] = useState<EngineError | null>(null);
  const anglesSendingRef = useRef(false);
  const frontChipRef = useRef<HTMLButtonElement>(null);
  const mounted = useMounted();
  const shownPoses = anglesSaving !== null ? (anglesSaving.poses ?? undefined) : category.pool.poses;
  const anglesLocked = busy ? anglesLockedTitle("regenerate") : deleting ? anglesLockedTitle("delete") : null;
  const anglesWait = anglesLocked !== null || anglesSaving !== null;

  async function saveAngles(poses: CategoryPoses | null): Promise<void> {
    // Two presses in one batch: the second finds the first on its way (state would not show it yet).
    if (anglesSendingRef.current || anglesLocked !== null) return;
    anglesSendingRef.current = true;
    setAnglesSaving({ poses });
    setAnglesError(null);
    const reply = await library.update(categoryId, { poses });
    anglesSendingRef.current = false;
    if (!mounted.current) return;
    setAnglesSaving(null);
    if (!reply.ok) setAnglesError(reply.error);
  }

  async function remove(): Promise<void> {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    const reply = await library.remove(categoryId);
    if (!reply.ok) {
      setDeleting(false);
      setDeleteError(reply.error);
      return;
    }
    focusRow(onDeleted(index));
  }

  function openRegen(text: string): void {
    library.clearOutcome("regenerate");
    library.refreshPrice();
    setRegenText(text);
    setRegenOpen(true);
    confirm.moveTo(() => regenFieldRef.current);
  }

  const sendRegen = (accepted: Estimate | null): void => {
    if (!canRegen || accepted === null) return;
    void library.regenerate(categoryId, regenText, accepted);
  };

  const outfitsAtMin = category.pool.outfits.length <= POOL_OUTFITS_MIN;
  const state = slice.regenerated.get(categoryId) ?? "created";
  const regenLabel = busy ? "Пересоздаём…" : priceChanged !== null ? "Подтвердить новую цену" : interrupted !== null ? "Пересоздать снова" : "Пересоздать";
  const regenWorst = regenerating !== null ? `до ${formatUsdTiered(regenerating.acceptedWorstMicros, "up")}` : worstOf(estimate);
  const regenWhy = regenerating === null ? (blocked ?? (otherCall !== null ? `Сейчас составляется «${otherCall}». По одной категории за раз — дождитесь её.` : null)) : null;
  const regenWhyId = `${ids}-regen-why`;

  return (
    <div className="cat-detail">
      <div className="cat-detail-head">
        {renaming ? (
          <div className="cat-rename">
            <div className="cat-rename-row">
              <label htmlFor={`${ids}-rename`} className="sr-only">
                Название
              </label>
              <input
                ref={nameFieldRef}
                id={`${ids}-rename`}
                className="in cat-rename-in"
                type="text"
                autoComplete="off"
                value={newName}
                aria-invalid={nameProblemText !== null}
                aria-describedby={nameProblemText !== null || renameError !== null ? `${ids}-rename-error` : undefined}
                onChange={(e) => {
                  setNewName(e.target.value);
                  setRenameError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveName();
                  }
                }}
              />
              <span className={newName.trim().length > CATEGORY_NAME_MAX ? "mono danger-text" : "mono faint"}>
                {newName.length}/{CATEGORY_NAME_MAX}
              </span>
              <button
                type="button"
                className="btn btn-s"
                onClick={() => {
                  setRenaming(false);
                  confirm.moveTo(() => pencilRef.current);
                }}
              >
                Отмена
              </button>
              <button type="button" className="btn btn-p btn-s" disabled={nameProblemText !== null || savingName} aria-busy={savingName} onClick={() => void saveName()}>
                Сохранить
              </button>
            </div>
            {(nameProblemText !== null || renameError !== null) && (
              <p id={`${ids}-rename-error`} className="field-error">
                {nameProblemText ?? (renameError !== null ? errorText(renameError) : "")}
              </p>
            )}
          </div>
        ) : (
          <div className="cat-name-row">
            <h3 className="cat-name" title={category.name}>
              {category.name}
            </h3>
            <button
              ref={pencilRef}
              type="button"
              className="ibtn ibtn-s"
              aria-label="Переименовать"
              disabled={busy}
              onClick={() => {
                setNewName(category.name);
                setRenameError(null);
                setRenaming(true);
                confirm.moveTo(() => nameFieldRef.current);
              }}
            >
              <Icon name="pencil" size={13} />
            </button>
            <button
              ref={deleteRef}
              type="button"
              className="btn btn-s btn-d cat-delete"
              aria-expanded={asking}
              disabled={busy || asking}
              onClick={() => {
                setDeleteError(null);
                setAsking(true);
                confirm.opened();
              }}
            >
              Удалить
            </button>
          </div>
        )}
        <p className="mono muted cat-meta">
          {categoryMeta(category, state).map((part, i) => (
            <Fragment key={part}>
              {i > 0 && " · "}
              <span className="nowrap">{part}</span>
            </Fragment>
          ))}
        </p>
        {asking && (
          <div className="notice notice-danger cat-confirm" role="alertdialog" aria-labelledby={`${ids}-del-title`} aria-describedby={`${ids}-del-text`}>
            <div className="notice-text">
              <p id={`${ids}-del-title`} className="notice-title cat-confirm-title">
                Удалить «{category.name}»?
              </p>
              <p id={`${ids}-del-text`}>{deleteConfirmText(openSetScenes)}</p>
            </div>
            <div className="cat-confirm-actions">
              <button type="button" className="btn btn-s btn-d" disabled={deleting} aria-busy={deleting} onClick={() => void remove()}>
                Удалить категорию
              </button>
              <button
                ref={confirm.cancelRef}
                type="button"
                className="btn btn-s"
                disabled={deleting}
                onClick={() => {
                  setAsking(false);
                  confirm.moveTo(() => deleteRef.current);
                }}
              >
                Отмена
              </button>
            </div>
            {deleteError !== null && <p className="field-error">{errorText(deleteError)}</p>}
          </div>
        )}
      </div>

      {interrupted !== null && !regenOpen && (
        <InterruptedNotice
          call={interrupted}
          library={library}
          slice={slice}
          onRetry={(accepted) => {
            // A new request for the description the interrupted one was sent with; the box shows it as it runs.
            setRegenText(interrupted.description);
            setRegenOpen(true);
            void library.regenerate(categoryId, interrupted.description, accepted);
          }}
          onEdit={() => openRegen(interrupted.description)}
        />
      )}

      <div className="cat-block">
        <div className="cat-block-head cat-desc-head">
          <span className="lbl">Описание</span>
          {!regenOpen && (
            <button ref={regenLinkRef} type="button" className="lbtn" onClick={() => openRegen(category.description)}>
              <Icon name="reload" size={12} strokeWidth={2.2} />
              Пересоздать…
            </button>
          )}
        </div>
        {!regenOpen && <p className="muted cat-desc">{category.description}</p>}
        {regenDone !== null && !regenOpen && (
          <div className="notice notice-ok cat-regen-done" role="status">
            <span className="notice-icon">
              <Icon name="check" size={16} strokeWidth={2.4} />
            </span>
            <div className="notice-body">
              <p className="notice-title">
                Набор пересоздан · потрачено <span className="mono">{formatUsdTiered(regenDone.spentMicros, "nearest")}</span>
              </p>
              {/* CS.7 L3, CS.8: the open set keeps the scenes it has, but its ⟳ draws from the category as it is now, its angles too (README contract note 4). */}
              <div className="notice-text">{REGEN_DONE_TEXT}</div>
            </div>
          </div>
        )}
        {regenOpen && (
          <div className="cat-regen">
            <div className="field-row">
              <label className="fl" htmlFor={`${ids}-regen`}>
                Новое описание <span className="faint">· на любом языке</span>
              </label>
              <span className={regenText.length > CATEGORY_DESCRIPTION_MAX ? "mono danger-text" : "mono faint"}>
                {regenText.length}/{CATEGORY_DESCRIPTION_MAX}
              </span>
            </div>
            <textarea
              ref={regenFieldRef}
              id={`${ids}-regen`}
              className={busy ? "in cat-ta cat-ta-busy" : "in cat-ta"}
              rows={4}
              value={regenerating?.description ?? regenText}
              disabled={busy}
              aria-invalid={descProblem !== null}
              onChange={(e) => setRegenText(e.target.value)}
            />
            {descProblem !== null && !busy && <p className="field-error">{descProblem}</p>}
            {busy && (
              <div className="job-progress cat-progress cat-progress-s" role="status">
                <span className="spin cat-progress-spin" aria-hidden="true" />
                <p className="cat-progress-text">
                  <b className="job-progress-label">Пересоздаём набор · {seconds} с.</b> Пока идёт пересоздание, эту категорию не изменить; запуски с ней не ждут — у них своя
                  копия.
                </p>
              </div>
            )}
            {interrupted !== null && !busy && (
              <div className="notice notice-warn cat-regen-notice" role="alert">
                <span className="notice-icon">
                  <Icon name="alert" size={16} />
                </span>
                <div className="notice-body">
                  <p className="notice-title">{interruptedText(interrupted).title}</p>
                  <div className="notice-text">{interruptedText(interrupted).text}</div>
                  <div className="notice-actions">
                    <button type="button" className="btn btn-s" disabled={dismissing} aria-busy={dismissing} onClick={() => void dismissInterrupted(interrupted.jobId)}>
                      Убрать
                    </button>
                  </div>
                  {dismissError !== null && <p className="field-error">{errorText(dismissError)}</p>}
                </div>
              </div>
            )}
            {failure !== null && (
              <div ref={regenNoticeRef} className="notice notice-danger cat-regen-notice" role="alert" tabIndex={-1}>
                <span className="notice-icon">
                  <Icon name="alert" size={16} />
                </span>
                <div className="notice-body">
                  <p className="notice-title">
                    {failure.title}
                    {failure.spent !== null && (
                      <>
                        {" "}
                        · потрачено <span className="mono">{failure.spent}</span>
                      </>
                    )}
                  </p>
                  <div className="notice-text">{failure.text}</div>
                  {failure.code !== null && <p className="mono faint cat-code">{failure.code}</p>}
                </div>
              </div>
            )}
            {priceChanged !== null && (
              <div ref={regenNoticeRef} className="notice notice-warn cat-regen-notice" role="alert" tabIndex={-1}>
                <span className="notice-icon">
                  <Icon name="alert" size={16} />
                </span>
                <div className="notice-body">
                  <p className="notice-title">Старый набор остался · {priceChanged.now > priceChanged.was ? "цена выросла" : "цена изменилась"}</p>
                  <div className="notice-text">
                    Было не больше <span className="mono">{formatUsdTiered(priceChanged.was, "up")}</span>, теперь не больше{" "}
                    <span className="mono">{formatUsdTiered(priceChanged.now, "up")}</span>. Ничего не отправлено — подтвердите новую цену.
                  </div>
                </div>
              </div>
            )}
            {!busy && failure === null && priceChanged === null && interrupted === null && (
              <p className="field-hint">{REGEN_HINT}</p>
            )}
            <div className="cat-regen-actions">
              <span className="mono muted cat-regen-price">
                {estimate !== null ? (
                  <>
                    <span className="nowrap">≈ {formatUsdTiered(estimate.expectedMicros, "nearest")}</span> ·{" "}
                    <span className="nowrap">до {formatUsdTiered(estimate.worstMicros, "up")}</span>
                  </>
                ) : regenerating !== null ? (
                  <span className="nowrap">до {formatUsdTiered(regenerating.acceptedWorstMicros, "up")}</span>
                ) : (
                  "—"
                )}
              </span>
              <button
                type="button"
                className="btn btn-s"
                disabled={busy}
                onClick={() => {
                  setRegenOpen(false);
                  library.clearOutcome("regenerate");
                  confirm.moveTo(() => regenLinkRef.current);
                }}
              >
                Отмена
              </button>
              <button
                type="button"
                className="btn btn-p btn-s"
                disabled={!canRegen}
                aria-busy={busy}
                aria-describedby={regenWhy !== null ? regenWhyId : undefined}
                onClick={() => sendRegen(estimate)}
              >
                {busy && <Spin />}
                {regenLabel} · {regenWorst}
              </button>
            </div>
            {regenWhy !== null && (
              <p id={regenWhyId} className="faint cat-why cat-why-end">
                {regenWhy}
              </p>
            )}
          </div>
        )}
      </div>

      {itemError !== null && (
        <div className="notice notice-danger" role="alert">
          <span className="notice-icon">
            <Icon name="alert" size={16} />
          </span>
          <div className="notice-body">
            <div className="notice-text">{errorText(itemError)}</div>
          </div>
        </div>
      )}

      <div className={busy ? "cat-pool cat-pool-busy" : "cat-pool"}>
        <div className="cat-block cat-angles">
          <div className="cat-block-head cat-angles-head">
            <span className="cat-angles-label">
              <span id={`${ids}-angles`} className="lbl">
                Ракурсы
              </span>
              <span className="faint cat-angles-free">бесплатно, сохраняется сразу</span>
            </span>
            {anglesSaving !== null ? (
              <span className="mono faint cat-angles-saving">
                <Spin />
                сохраняем…
              </span>
            ) : (
              shownPoses !== undefined && (
                <button
                  type="button"
                  className="lbtn"
                  aria-disabled={anglesLocked !== null}
                  title={anglesLocked ?? ANGLES_CLEAR_TITLE}
                  onClick={() => {
                    if (anglesWait) return;
                    // The button goes with the own angles: the focus goes to «Анфас», the first chip.
                    confirm.moveTo(() => frontChipRef.current);
                    void saveAngles(null);
                  }}
                >
                  <Icon name="close" size={12} strokeWidth={2.4} />
                  Как в карточке
                </button>
              )
            )}
          </div>
          <div role="group" className="cat-angle-chips" aria-labelledby={`${ids}-angles`} aria-describedby={`${ids}-angles-hint`} aria-busy={anglesSaving !== null}>
            {ScenePose.options.map((pose) => {
              const implied = shownPoses === undefined && CARD_POSES.includes(pose);
              const on = shownPoses?.includes(pose) === true;
              return (
                <button
                  key={pose}
                  ref={pose === "front" ? frontChipRef : undefined}
                  type="button"
                  className={["chip", on || implied ? "chip-on" : "", implied ? "cat-angle-implied" : ""].filter(Boolean).join(" ")}
                  aria-pressed={on || implied}
                  aria-disabled={anglesWait}
                  title={anglesLocked ?? (implied && (pose === "front" || pose === "three-quarter") ? impliedChipTitle(pose) : undefined)}
                  onClick={() => {
                    if (!anglesWait) void saveAngles(nextPoses(shownPoses, pose));
                  }}
                >
                  {POSE_CHIP[pose]}
                </button>
              );
            })}
          </div>
          <p
            id={`${ids}-angles-hint`}
            className={anglesError !== null ? "cat-pool-note cat-angles-error" : "faint cat-pool-note"}
            role={anglesError !== null ? "alert" : undefined}
            aria-live={anglesError !== null ? "assertive" : "polite"}
          >
            {anglesError !== null ? anglesSaveFailure(anglesError) : anglesHint(shownPoses, category.pool.shotDeck, openSetScenes)}
          </p>
        </div>

        <div className="cat-block">
          <div className="cat-block-head">
            <span className="lbl">Места · {category.pool.locations.length}</span>
            <span className="mono faint cat-block-note">по-английски, как уходят в промпт</span>
          </div>
          <ul ref={placesRef} className="cat-places">
            {category.pool.locations.map((place, i) => (
              <EditablePlace key={place.name} pool={category.pool} index={i} busy={busy || removing} onRemove={(name) => void removeItem("place", name, i)} />
            ))}
          </ul>
          <p className="faint cat-pool-note">{placesNote(category.pool)}</p>
        </div>

        <div className="cat-block">
          <span className="lbl">Наряды · {category.pool.outfits.length}</span>
          <div ref={outfitsRef} className="cat-outfits">
            {category.pool.outfits.map((outfit, i) => (
              <span key={outfit} className="tag tag-o cat-outfit cat-outfit-edit">
                <span lang="en">{outfit}</span>
                <button
                  type="button"
                  className="xbtn"
                  data-remove="outfit"
                  aria-label={`Убрать наряд: ${outfit}`}
                  aria-disabled={outfitsAtMin || busy || removing}
                  title={outfitsAtMin ? `Нарядов уже ${POOL_OUTFITS_MIN} — меньше нельзя` : "Убрать наряд"}
                  onClick={() => {
                    if (!outfitsAtMin && !busy && !removing) void removeItem("outfit", outfit, i);
                  }}
                >
                  <Icon name="close" size={10} strokeWidth={2.8} />
                </button>
              </span>
            ))}
          </div>
          {outfitsNote(category.pool) !== null && <p className="faint cat-pool-note">{outfitsNote(category.pool)}</p>}
        </div>

        <ShotShares pool={category.pool} note={<span className="faint cat-pool-note">{styleNote(category.style)}</span>} />
      </div>
    </div>
  );
}

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { SCENE_TEXT_MAX, type SceneProblem, type SceneView } from "../../../shared/engine";
import { Icon, Spin } from "../../ui/Icon";
import { hasCyrillic, OWN_SCENE_LABEL, sceneCategoryLabel, sceneNumber, SHOT_LABEL } from "./sceneReview";
import { cyrillicHint, gaveUpText, ideaLine, problemText } from "./sceneText";

// CS.6: one scene of the «Сцены» column (the design's .photos-scene card): its number, its category and shot tags, its status, its free and paid actions
// (✎ edit, ⟳ another scene / rewrite, × remove; «Вернуть» when removed), its text whole — or a skeleton while it is written, or why it was given up on —
// and an own scene's idea under the text. The pencil opens the edit right in the card; the ⟳ price popover is drawn beside it by the column.

/** What the scene is going through now, which decides its flag and whether it shows its text. */
export type SceneWriting = "compose" | "rewrite" | null;

interface SceneCardProps {
  scene: SceneView;
  /** The number on the card: the scene's id, or a used set's slot. */
  number: number;
  /** A used set: text only, no action, no status. */
  readOnly: boolean;
  /** A write of the set runs: every action waits (the engine refuses them, IN_FLIGHT). */
  actionsOff: boolean;
  writing: SceneWriting;
  /** Replaced just now by this window's «Другая сцена». */
  fresh: boolean;
  popoverOpen: boolean;
  /** `text` is the scene's text when the pencil opened: the draft starts from it and «unchanged» is measured against it, whatever the scene says now. */
  editing: { readonly text: string | null; readonly problem: SceneProblem | null; readonly problemFor: string | null; readonly busy: boolean } | null;
  onEdit: () => void;
  onRedo: () => void;
  onRemove: () => void;
  onRestore: () => void;
  onSave: (text: string) => void;
  onCancelEdit: () => void;
  /** The ⟳ popover, drawn beside the card when open. */
  popover: ReactNode;
}

interface Flag {
  readonly text: string;
  readonly tone: "faint" | "accent" | "warn" | "ok";
  readonly spin?: boolean;
}

function flagOf(scene: SceneView, writing: SceneWriting, fresh: boolean): Flag | null {
  if (scene.removed) return { text: "убрана", tone: "faint" };
  if (writing === "rewrite") return { text: "пишется…", tone: "accent", spin: true };
  if (scene.unwritten === "pending") return writing === "compose" ? { text: "пишется", tone: "accent" } : { text: "ждёт", tone: "faint" };
  if (scene.rewriteInterrupted !== undefined) return { text: "замена прервана", tone: "warn" };
  if (scene.unwritten === "gave-up") return { text: "не составлена", tone: "warn" };
  if (scene.edited) return { text: "изменена", tone: "faint" };
  if (fresh) return { text: "новая", tone: "ok" };
  return null;
}

export function SceneCard({ scene, number, readOnly, actionsOff, writing, fresh, popoverOpen, editing, onEdit, onRedo, onRemove, onRestore, onSave, onCancelEdit, popover }: SceneCardProps) {
  const n = sceneNumber(number);
  const own = scene.origin === "own";
  const flag = readOnly ? null : flagOf(scene, writing, fresh);
  const pending = scene.unwritten === "pending" && !scene.removed;
  const showActions = !readOnly && !scene.removed && !pending && writing !== "rewrite" && editing === null;
  const label = sceneCategoryLabel(scene);
  const warn = !readOnly && !scene.removed && (scene.unwritten === "gave-up" || scene.rewriteInterrupted !== undefined);
  const classes = ["photos-scene", "scene-card", scene.removed ? "photos-scene-off" : "", warn ? "scene-card-warn" : "", popoverOpen ? "scene-card-active" : "", editing !== null ? "scene-card-editing" : ""].filter(Boolean).join(" ");
  const off = (handler: () => void) => () => {
    if (!actionsOff) handler();
  };

  return (
    <article className={classes} aria-label={`Сцена ${n}`} tabIndex={-1} data-scene={scene.sceneId}>
      <span className="mono faint photos-scene-n">{n}</span>
      <div className="photos-scene-main">
        <div className="scene-card-head">
          <span className="scene-card-tags">
            <span className="tag scene-tag-cat" title={label}>
              {own && <Icon name="pencil" size={10} strokeWidth={2.4} />}
              {own ? OWN_SCENE_LABEL : label}
            </span>
            {!(own && pending) && <span className="tag tag-o">{SHOT_LABEL[scene.shot]}</span>}
          </span>
          <span className="scene-card-gap" />
          {flag !== null && (
            <span className={`scene-flag scene-flag-${flag.tone}`}>
              {flag.spin === true && <Spin />}
              {flag.text}
            </span>
          )}
          {showActions && (
            <span className="scene-card-acts">
              <button type="button" className={actionsOff ? "ibtn ibtn-s ibtn-off" : "ibtn ibtn-s"} aria-label={`Изменить текст сцены ${n}`} aria-disabled={actionsOff} onClick={off(onEdit)}>
                <Icon name="pencil" size={13} strokeWidth={2} />
              </button>
              <button
                type="button"
                className={actionsOff ? "ibtn ibtn-s ibtn-off" : "ibtn ibtn-s"}
                aria-label={own ? `Переписать свою сцену ${n}` : `Другая сцена вместо ${n}`}
                title={own ? "Переписать — платно, цена перед отправкой" : "Другая сцена — платно, цена перед отправкой"}
                aria-haspopup="dialog"
                aria-expanded={popoverOpen}
                aria-disabled={actionsOff}
                onClick={off(onRedo)}
              >
                <Icon name="reload" size={13} strokeWidth={2} />
              </button>
              <button type="button" className={actionsOff ? "ibtn ibtn-s ibtn-off" : "ibtn ibtn-s"} aria-label={`Убрать сцену ${n}`} aria-disabled={actionsOff} onClick={off(onRemove)}>
                <Icon name="close" size={12} strokeWidth={2.4} />
              </button>
            </span>
          )}
          {!readOnly && scene.removed && (
            <button type="button" className={actionsOff ? "btn btn-s scene-restore btn-off" : "btn btn-s scene-restore"} aria-label={`Вернуть сцену ${n}`} aria-disabled={actionsOff} onClick={off(onRestore)}>
              Вернуть
            </button>
          )}
        </div>

        {editing !== null ? (
          <SceneEditForm scene={scene} number={n} editing={editing} onSave={onSave} onCancel={onCancelEdit} />
        ) : pending ? (
          <div className="scene-skeleton" aria-label={writing === "compose" ? "пишется" : "ждёт составления"}>
            {[96, 88, 52].map((width) => (
              <span key={width} className="skeleton-line" style={{ width: `${width}%` }}>
                {writing === "compose" && <span className="shim" />}
              </span>
            ))}
          </div>
        ) : scene.text !== null ? (
          <p className={writing === "rewrite" || scene.removed ? "photos-scene-text scene-text-dim" : "photos-scene-text"} lang="en">
            {scene.text}
          </p>
        ) : scene.gaveUpBy !== null && !scene.removed ? (
          <p className="photos-scene-text">{gaveUpText(scene.gaveUpBy)}</p>
        ) : (
          <p className="photos-scene-text scene-text-dim">без текста</p>
        )}
        {own && scene.idea !== null && editing === null && <span className="faint scene-idea">{ideaLine(scene.idea)}</span>}
      </div>
      {popover}
    </article>
  );
}

/** A placeholder of an own scene being written from an idea (ReviewIdeaWriting): at the end of the list, until its write ends. */
export function ScenePlaceholder({ number, idea }: { number: number; idea: string | null }) {
  const n = sceneNumber(number);
  return (
    <article className="photos-scene scene-card" aria-label={`Сцена ${n}`} tabIndex={-1} data-placeholder={number}>
      <span className="mono faint photos-scene-n">{n}</span>
      <div className="photos-scene-main">
        <div className="scene-card-head">
          <span className="scene-card-tags">
            <span className="tag scene-tag-cat">
              <Icon name="pencil" size={10} strokeWidth={2.4} />
              {OWN_SCENE_LABEL}
            </span>
          </span>
          <span className="scene-card-gap" />
          <span className="scene-flag scene-flag-accent">пишется</span>
        </div>
        {idea !== null && <span className="faint scene-idea">{ideaLine(idea)}</span>}
        <div className="scene-skeleton" aria-label="пишется">
          {[96, 88, 52].map((width) => (
            <span key={width} className="skeleton-line" style={{ width: `${width}%` }}>
              <span className="shim" />
            </span>
          ))}
        </div>
      </div>
    </article>
  );
}

/**
 * The pencil's edit (ReviewEdit): verbatim, free, checked at once by the engine with the assembler's own rule — a problem is shown in red and «Сохранить»
 * waits for another text. Enter saves (the text is one line), Escape cancels; a Russian text is not refused, only told where it goes.
 */
function SceneEditForm({
  scene,
  number,
  editing,
  onSave,
  onCancel,
}: {
  scene: SceneView;
  number: string;
  editing: { readonly text: string | null; readonly problem: SceneProblem | null; readonly problemFor: string | null; readonly busy: boolean };
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const ids = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(editing.text ?? "");
  useEffect(() => {
    field.current?.focus();
    const end = field.current?.value.length ?? 0;
    field.current?.setSelectionRange(end, end);
  }, []);
  const problem = editing.problem !== null && editing.problemFor === draft ? editing.problem : null;
  const trimmed = draft.trim();
  const tooLong = draft.length > SCENE_TEXT_MAX;
  const unchanged = trimmed === (editing.text ?? "") && editing.text !== null;
  const canSave = trimmed.length > 0 && !tooLong && !unchanged && problem === null && !editing.busy;
  const hint = hasCyrillic(draft) ? cyrillicHint(scene.origin) : null;
  const problemId = `${ids}-problem`;
  const hintId = `${ids}-hint`;

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      // One line: Enter saves, it never breaks the line.
      event.preventDefault();
      if (canSave) onSave(draft);
    }
  }

  return (
    <div className="scene-edit">
      <textarea
        ref={field}
        className={problem !== null ? "in scene-ta scene-edit-field scene-edit-bad" : "in scene-ta scene-edit-field"}
        lang="en"
        rows={3}
        aria-label={`Текст сцены ${number}`}
        aria-invalid={problem !== null}
        aria-describedby={[problem !== null ? problemId : null, hint !== null ? hintId : null].filter(Boolean).join(" ") || undefined}
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[\r\n]+/g, " "))}
        onKeyDown={onKey}
      />
      {problem !== null && (
        <p id={problemId} className="scene-edit-problem">
          <Icon name="alert" size={14} strokeWidth={2} />
          {problemText(problem)}
        </p>
      )}
      {hint !== null && problem === null && (
        <p id={hintId} className="scene-edit-hint">
          <Icon name="info" size={13} strokeWidth={2} />
          {hint}
        </p>
      )}
      <div className="scene-edit-foot">
        <span className={tooLong ? "mono danger-text scene-edit-count" : "mono faint scene-edit-count"}>
          {draft.length}/{SCENE_TEXT_MAX} · бесплатно
        </span>
        <button type="button" className="btn btn-s" onClick={onCancel}>
          Отмена
        </button>
        <button type="button" className="btn btn-p btn-s" aria-busy={editing.busy} disabled={!canSave} onClick={() => onSave(draft)}>
          {editing.busy && <Spin />}
          Сохранить
        </button>
      </div>
    </div>
  );
}

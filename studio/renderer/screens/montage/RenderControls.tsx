import { useId } from "react";
import { canCancel, type RenderControl } from "../../engine/renderJobs";
import { useNavigate } from "../../navigation";
import { Icon, PlayIcon, Spin } from "../../ui/Icon";
import { renderButtonLabel } from "./labels";
import type { RenderBlock } from "./renderBlock";

// The editor header's render area (3d.6), drawn from the render job model's `RenderControl`: «Рендер» and why it is disabled, the
// busy button with Cancel (queued, running, «Сохранение…»), «Готово» with «Открыть в папке», and a failed render with «Повторить
// рендер». The artboards draw ready, blocked, the no-folder variant, running and done; queued, saving and failed are not drawn, so
// they follow the same language (the busy button of «Рендер · 42 %», the green «Готово», and the same row in the danger tone).

function Why({ id, block }: { id: string; block: RenderBlock }) {
  const navigate = useNavigate();
  return (
    <span id={id} className="faint ed-render-why" title={block.text}>
      {block.text}
      {block.settings && (
        <>
          {" · "}
          <button type="button" className="ed-link" onClick={() => navigate({ name: "settings", focus: "export" })}>
            Настройки
          </button>
        </>
      )}
    </span>
  );
}

export function RenderControls({
  control,
  gone,
  revealing,
  onRender,
  onCancel,
  onReveal,
}: {
  control: RenderControl;
  /** The draft was deleted: nothing here can render it any more. */
  gone: boolean;
  /** «Открыть в папке» was asked and is not answered yet. */
  revealing: boolean;
  onRender: () => void;
  onCancel: () => void;
  onReveal: (videoId: string) => void;
}) {
  const whyId = useId();
  switch (control.kind) {
    case "submitting":
    case "queued":
    case "running":
    case "saving": {
      const saving = control.kind === "saving";
      return (
        <>
          <button type="button" className="btn btn-p ed-render-busy" aria-busy="true" aria-disabled="true">
            <Spin />
            {renderButtonLabel(control)}
          </button>
          {control.kind !== "submitting" && (
            <button
              type="button"
              className="ibtn ed-render-cancel"
              aria-label="Отменить рендер"
              title={saving ? "Отмена уже невозможна: видео сохраняется" : undefined}
              disabled={!canCancel(control)}
              onClick={onCancel}
            >
              <Icon name="close" size={14} strokeWidth={2.4} />
            </button>
          )}
        </>
      );
    }
    case "done":
      return (
        <>
          <span className="ed-render-state ed-render-done" role="status">
            <Icon name="check" size={14} strokeWidth={2.6} />
            Готово
          </span>
          <button type="button" className="btn" aria-busy={revealing} disabled={revealing || control.videoId === null} onClick={() => control.videoId !== null && onReveal(control.videoId)}>
            {revealing ? <Spin /> : <Icon name="folder" size={15} strokeWidth={1.9} />}
            Открыть в папке
          </button>
          {control.block !== null && <Why id={whyId} block={control.block} />}
          <button type="button" className="btn btn-p" disabled={gone || control.block !== null} aria-describedby={control.block !== null ? whyId : undefined} onClick={onRender}>
            <PlayIcon />
            Рендер
          </button>
        </>
      );
    case "failed":
      return (
        <>
          <span className="ed-render-state ed-render-failed" role="status">
            <Icon name="alert" size={14} strokeWidth={2.4} />
            Рендер не удался
          </span>
          {control.block !== null && <Why id={whyId} block={control.block} />}
          <button type="button" className="btn btn-p" disabled={gone || control.block !== null} aria-describedby={control.block !== null ? whyId : undefined} onClick={onRender}>
            <PlayIcon />
            Повторить рендер
          </button>
        </>
      );
    case "blocked":
      return (
        <>
          <Why id={whyId} block={control.block} />
          <button type="button" className="btn btn-p" disabled aria-describedby={whyId}>
            <PlayIcon />
            Рендер
          </button>
        </>
      );
    case "ready":
      return (
        <button type="button" className="btn btn-p" disabled={gone} onClick={onRender}>
          <PlayIcon />
          Рендер
        </button>
      );
  }
}

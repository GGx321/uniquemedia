import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EngineError } from "../../shared/engine";
import { errorSettingsFocus, errorText, settingsLinkLabel } from "../lib/errors";
import { useNavigate } from "../navigation";
import { Icon } from "./Icon";
import { useDockCard, useNoticeRole } from "./NoticeDock";

export type NoticeTone = "info" | "ok" | "warn" | "danger";

const ICON = { info: "info", ok: "check", warn: "alert", danger: "alert" } as const;

/**
 * Where the focus goes when a notice that held it goes (its «Понятно» or «Закрыть» was pressed, review r1 LOW-3): the first button of the next
 * notice beside it (or the one before), else the screen's title. Only when the focus really fell to the body: something that took it meanwhile
 * (a new screen's title) keeps it.
 */
function focusAfter(node: HTMLElement): void {
  const area = node.closest(".ed-dock, .content");
  const notices = area === null ? [] : [...area.querySelectorAll<HTMLElement>(".notice")];
  const at = notices.indexOf(node);
  const next = at < 0 ? [] : [...notices.slice(at + 1), ...notices.slice(0, at).reverse()];
  // After the commit that removed it (and drew the next card of a dock's stack in its place).
  queueMicrotask(() => {
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const button = next.filter((n) => n.isConnected && !n.hidden).map((n) => n.querySelector<HTMLElement>("button:not([disabled])")).find((b) => b !== null);
    (button ?? document.querySelector<HTMLElement>(".content .screen-title"))?.focus();
  });
}

/**
 * An inline message. `danger` and `warn` are announced as alerts; `role="status"` says a warning politely instead, for advice
 * where nothing went wrong (a small photo picked for import).
 *
 * `noticeKey` names its condition and code. In a screen's dock (the editor's, review r1 MEDIUM-2) the notice is one of its cards: the newest
 * shows, the others fold behind «Ещё N», and «Свернуть» folds it to a chip until its key changes. A window notice drawn again in another place is
 * said politely the second time (LOW-2).
 */
export function Notice({
  tone,
  title,
  children,
  actions,
  role: asked,
  noticeKey,
  summary,
}: {
  tone: NoticeTone;
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
  role?: "alert" | "status";
  noticeKey?: string;
  /** What its chip says when it has no title (a dock's card folded, MEDIUM-2). */
  summary?: string;
}) {
  const role = useNoticeRole(noticeKey, asked ?? (tone === "danger" || tone === "warn" ? "alert" : "status"));
  const card = useDockCard(noticeKey);
  const ref = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  /** Folded or unfolded by the owner just now: the focus follows to the chip, or back into the card. */
  const [moved, setMoved] = useState<"chip" | "card" | null>(null);
  useLayoutEffect(
    () => () => {
      // Read when it goes: its element is still in the page while its effects are cleaned up.
      const node = ref.current;
      if (node !== null && node.contains(document.activeElement)) focusAfter(node);
    },
    [],
  );
  useEffect(() => {
    if (moved === null) return;
    (moved === "chip" ? chip.current : ref.current?.querySelector<HTMLElement>("button"))?.focus();
    setMoved(null);
  }, [moved]);

  if (card?.state === "chip") {
    return (
      <button
        ref={chip}
        type="button"
        className={`notice-chip notice-chip-${tone}`}
        aria-label={`Развернуть уведомление: ${title ?? summary ?? "без заголовка"}`}
        title={title ?? summary}
        onClick={() => {
          card.restore();
          setMoved("card");
        }}
      >
        <Icon name={ICON[tone]} size={13} />
        <span className="notice-chip-text">{title ?? summary ?? children}</span>
      </button>
    );
  }
  return (
    <div ref={ref} className={card === null ? `notice notice-${tone}` : `notice notice-${tone} notice-card`} role={role} hidden={card?.state === "hidden"}>
      <span className="notice-icon">
        <Icon name={ICON[tone]} size={16} />
      </span>
      <div className="notice-body">
        {title && <p className="notice-title">{title}</p>}
        {children && <div className="notice-text">{children}</div>}
        {actions && <div className="notice-actions">{actions}</div>}
      </div>
      {card !== null && (
        <button
          type="button"
          className="notice-min"
          aria-label="Свернуть уведомление"
          title="Свернуть, пока не появится новое"
          onClick={() => {
            card.minimize();
            setMoved("chip");
          }}
        >
          <Icon name="minus" size={13} strokeWidth={2.4} />
        </button>
      )}
    </div>
  );
}

/** An engine error in Russian, with a link to the Settings card that fixes it. `noticeKey`: as `Notice`'s, its code by default. */
export function ErrorNotice({ error, actions, noticeKey }: { error: EngineError; actions?: ReactNode; noticeKey?: string }) {
  const navigate = useNavigate();
  const focus = errorSettingsFocus(error.code);
  const tone = error.code === "PRICE_CHANGED" || error.code === "RATE_LIMITED" ? "warn" : "danger";
  return (
    <Notice
      tone={tone}
      noticeKey={noticeKey}
      summary={errorText(error)}
      actions={
        focus || actions ? (
          <>
            {actions}
            {focus && (
              <button type="button" className="btn btn-s" onClick={() => navigate({ name: "settings", focus })}>
                {settingsLinkLabel(focus)}
              </button>
            )}
          </>
        ) : undefined
      }
    >
      {errorText(error)}
    </Notice>
  );
}

import type { ReactNode } from "react";
import type { EngineError } from "../../shared/engine";
import { errorSettingsFocus, errorText, settingsLinkLabel } from "../lib/errors";
import { useNavigate } from "../navigation";
import { Icon } from "./Icon";

export type NoticeTone = "info" | "ok" | "warn" | "danger";

const ICON = { info: "info", ok: "check", warn: "alert", danger: "alert" } as const;

/** An inline message. `danger` and `warn` are announced as alerts. */
export function Notice({
  tone,
  title,
  children,
  actions,
}: {
  tone: NoticeTone;
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const role = tone === "danger" || tone === "warn" ? "alert" : "status";
  return (
    <div className={`notice notice-${tone}`} role={role}>
      <span className="notice-icon">
        <Icon name={ICON[tone]} size={16} />
      </span>
      <div className="notice-body">
        {title && <p className="notice-title">{title}</p>}
        {children && <div className="notice-text">{children}</div>}
        {actions && <div className="notice-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** An engine error in Russian, with a link to the Settings card that fixes it. */
export function ErrorNotice({ error, actions }: { error: EngineError; actions?: ReactNode }) {
  const navigate = useNavigate();
  const focus = errorSettingsFocus(error.code);
  const tone = error.code === "PRICE_CHANGED" || error.code === "RATE_LIMITED" ? "warn" : "danger";
  return (
    <Notice
      tone={tone}
      actions={
        focus || actions ? (
          <>
            {actions}
            {focus && (
              <button type="button" className="btn btn-sm" onClick={() => navigate({ name: "settings", focus })}>
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

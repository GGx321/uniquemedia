import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { bodyPhrase, composedLength, DESCRIPTOR_MAX_CHARS, descriptorReasonRu, type AvatarBody, type AvatarSummary, type EngineError } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { BODY_FIELDS, buildInText, FIELD_LABEL, fieldValue, proposalHint, proposalSources, proposedBody, sameBody, tidyBody } from "../../lib/body";
import { errorText } from "../../lib/errors";
import { BUILDS } from "../../lib/traits";
import { Icon, Spin } from "../../ui/Icon";
import { useAnnouncer } from "../../ui/useAnnouncer";
import { BodyFields } from "../body/BodyFields";
import { useMounted } from "../photos/shared";
import { BODY_HELD_REASON } from "./lookModel";

// S5.2d: «Тело» on the avatar's «Внешность» (.omc/stage5/design 05–08). The summary says what is set; «Изменить тело» («Задать тело» for none)
// opens the fields in the card, two columns, while «Описание» beside it previews the change. Saved by the free `avatars.setBody`, which replaces the
// whole body: a field put back to «не задано» goes. After an import (S5.2b) the photo's reading waits as a proposal: the fields open with it, tagged
// «с фото» / «не видно на фото», and «Позже» keeps it, «Не нужно» drops it (`avatars.dismissBodyProposal`), «Сохранить тело» saves and clears it.
// «Телосложение» is read-only here (D1): the model wrote it into the description's text, and it is changed there.

/** The owner's words for a refused save or dismissal: the rule it broke, a busy avatar, or the engine's own text. */
function refusalText(error: EngineError, age: number): string {
  if (error.code === "VALIDATION" && error.descriptorReason !== undefined) return descriptorReasonRu(error.descriptorReason, error.descriptorWords, age);
  if (error.code === "IN_FLIGHT") return BODY_HELD_REASON;
  return errorText(error);
}

function Summary({ avatar }: { avatar: AvatarSummary }) {
  const body = avatar.body ?? {};
  const build = buildInText(avatar.descriptor.text);
  const buildLabel = build === null ? null : (BUILDS.find((b) => b.value === build)?.label ?? null);
  return (
    <dl className="body-sum">
      <div>
        <dt>Телосложение</dt>
        <dd className={buildLabel === null ? "unset" : undefined}>{buildLabel ?? "в «Описании»"}</dd>
      </div>
      {BODY_FIELDS.map((field) => {
        const value = fieldValue(body, field);
        return (
          <div key={field} className={field === "marks" ? "wide" : undefined}>
            <dt>{FIELD_LABEL[field]}</dt>
            <dd className={value === null ? "unset" : undefined}>{value ?? "не задано"}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function BodyCard({
  avatar,
  draft,
  onDraft,
  ready,
  held,
  runDrawing,
}: {
  avatar: AvatarSummary;
  /** The body being edited, or null for the summary: held by the tab, so «Описание» previews it. */
  draft: AvatarBody | null;
  onDraft: (draft: AvatarBody | null) => void;
  ready: boolean;
  /** This window's own check holds the avatar: a save now would be refused IN_FLIGHT. */
  held: boolean;
  /** A photo run of hers is drawing: a save is allowed, and that run finishes with the body it started with. */
  runDrawing: boolean;
}) {
  const { client, store } = useEngine();
  const mounted = useMounted();
  const [said, say] = useAnnouncer();
  const [busy, setBusy] = useState<"save" | "dismiss" | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const fields = useRef<HTMLFieldSetElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  /** Where the focus goes once the card has drawn its next mode: into the fields, or back to the button that opens them. */
  const [focusNext, setFocusNext] = useState<"fields" | "opener" | null>(null);
  const { avatarId } = avatar;
  const { text, age } = avatar.descriptor;
  const stored = avatar.body ?? {};
  const proposal = avatar.bodyProposal;
  const hasBody = bodyPhrase(stored) !== undefined;

  useEffect(() => {
    if (focusNext === "fields") fields.current?.querySelector<HTMLInputElement>("input:checked:not(:disabled)")?.focus();
    else if (focusNext === "opener") opener.current?.focus();
    if (focusNext !== null) setFocusNext(null);
  }, [focusNext]);

  function open(from: AvatarBody): void {
    setError(null);
    onDraft(from);
    setFocusNext("fields");
  }

  function close(): void {
    setError(null);
    onDraft(null);
    setFocusNext("opener");
  }

  async function save(body: AvatarBody): Promise<void> {
    setBusy("save");
    setError(null);
    const reply = await client.request("avatars.setBody", { avatarId, body: tidyBody(body) });
    if (!mounted.current) return;
    setBusy(null);
    if (!reply.ok) {
      setError(reply.error);
      return;
    }
    store.saveAvatar(reply.result.avatar);
    onDraft(null);
    setFocusNext("opener");
    say("Тело сохранено");
  }

  async function dismiss(): Promise<void> {
    setBusy("dismiss");
    setError(null);
    const reply = await client.request("avatars.dismissBodyProposal", { avatarId });
    if (!mounted.current) return;
    setBusy(null);
    if (!reply.ok) {
      setError(reply.error);
      return;
    }
    store.saveAvatar(reply.result.avatar);
    onDraft(null);
    setFocusNext("opener");
    say("Тело с фото не сохранено");
  }

  const live = (
    <p className="sr-only" role="status">
      {said}
    </p>
  );

  if (draft !== null) {
    const phrase = bodyPhrase(draft);
    // The engine refuses a body whose phrase does not fit beside the description; said before the click, not after it.
    const tooLong = composedLength(text, phrase) > DESCRIPTOR_MAX_CHARS;
    const changed = proposal !== undefined || !sameBody(draft, stored);
    const canSave = ready && !held && busy === null && !tooLong && changed;
    const onKey = (event: KeyboardEvent<HTMLElement>): void => {
      if (event.key !== "Escape" || busy !== null) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    return (
      <section className="card look-body look-body-edit" aria-label="Тело" onKeyDown={onKey}>
        {/* First in both modes, so a save that closes the fields keeps the same live region and is announced (review M3). */}
        {live}
        <div className="card-head">
          <div className="look-desc-title">
            <h2 className="card-title">Тело</h2>
            {proposal !== undefined ? (
              <span className="look-body-hint">
                <Icon name="info" size={14} strokeWidth={2} />
                {proposalHint(proposal)}
              </span>
            ) : (
              <span className="muted">изменения — только в новых фото и клипах; готовые не меняются</span>
            )}
          </div>
        </div>
        <fieldset ref={fields} className="lock" disabled={busy !== null}>
          <legend className="sr-only">Тело</legend>
          <BodyFields
            body={draft}
            onChange={(next) => {
              setError(null);
              onDraft(next);
            }}
            build={{ editable: false, value: buildInText(text) }}
            layout="columns"
            sources={proposal === undefined ? null : proposalSources(proposal)}
          />
        </fieldset>
        {tooLong ? (
          <p className="look-edit-problem" role="alert">
            <Icon name="alert" size={14} strokeWidth={2} />
            <span>{descriptorReasonRu("too-long-with-body")}</span>
          </p>
        ) : (
          error !== null && (
            <p className="look-edit-problem" role="alert">
              <Icon name="alert" size={14} strokeWidth={2} />
              <span>{refusalText(error, age)}</span>
            </p>
          )
        )}
        {runDrawing && (
          <p className="look-legend">
            <Icon name="info" size={13} strokeWidth={2} />
            Съёмка, которая идёт сейчас, закончит со старым телом — новое возьмут следующие фото.
          </p>
        )}
        {held && (
          <p className="look-legend">
            <Icon name="info" size={13} strokeWidth={2} />
            {BODY_HELD_REASON}.
          </p>
        )}
        <div className="look-body-actions">
          <button type="button" className="btn btn-p" aria-busy={busy === "save"} disabled={!canSave} onClick={() => void save(draft)}>
            {busy === "save" && <Spin />}
            Сохранить тело
          </button>
          {proposal !== undefined ? (
            <>
              <button type="button" className="btn" disabled={busy !== null} onClick={close}>
                Позже
              </button>
              <button type="button" className="btn" aria-busy={busy === "dismiss"} disabled={!ready || held || busy !== null} onClick={() => void dismiss()}>
                {busy === "dismiss" && <Spin />}
                Не нужно
              </button>
            </>
          ) : (
            <button type="button" className="btn" disabled={busy !== null} onClick={close}>
              Отмена
            </button>
          )}
          <p className="field-hint">Бесплатно — описание меняется без запроса к модели.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="card look-body" aria-label="Тело">
      {live}
      <div className="card-head">
        <div className="look-desc-title">
          <h2 className="card-title">Тело</h2>
          <span className="muted">одно и то же в каждом фото и клипе</span>
        </div>
        {hasBody && proposal === undefined && (
          <button ref={opener} type="button" className="btn btn-s" disabled={!ready} onClick={() => open(stored)}>
            <Icon name="pencil" size={14} strokeWidth={2} />
            Изменить тело
          </button>
        )}
      </div>
      <Summary avatar={avatar} />
      {proposal !== undefined ? (
        // «Позже» kept the photo's reading: it waits here until it is saved or dropped.
        <div className="body-nudge body-nudge-info">
          <p>
            <b>Тело с фото ждёт решения.</b> Импорт прочитал его с фото — сохраните, поправьте или откажитесь.
          </p>
          <button ref={opener} type="button" className="btn btn-p" disabled={!ready} onClick={() => open(proposedBody(avatar.body, proposal))}>
            Посмотреть
          </button>
        </div>
      ) : (
        !hasBody && (
          <div className="body-nudge">
            <p>
              <b>Тело не задано.</b> Модель каждый раз рисует его по-своему — от фото к фото фигура разная. Достаточно двух-трёх полей.
            </p>
            <button ref={opener} type="button" className="btn btn-p" disabled={!ready} onClick={() => open(stored)}>
              Задать тело
            </button>
          </div>
        )
      )}
    </section>
  );
}

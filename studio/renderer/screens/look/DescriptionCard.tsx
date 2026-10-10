import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { bodyPhrase, DESCRIPTOR_MAX_CHARS, descriptorReasonRu, type AvatarBody, type AvatarSummary, type DescriptorCheck, type EngineError } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { bodyPhraseDiff, descriptorHead, textLimit } from "../../lib/body";
import { errorText } from "../../lib/errors";
import { plural } from "../../lib/format";
import { Icon, Spin } from "../../ui/Icon";
import { useAnnouncer } from "../../ui/useAnnouncer";
import { useMounted } from "../photos/shared";
import { EDIT_HELD_REASON, proposalReason, wordDiff, type DiffPart } from "./lookModel";
import type { LookCheck } from "./useLookCheck";

// S5.0d: «Описание» (.omc/stage5/design 07, 10): the stored English text that goes into every prompt, the owner's own edit of it, and a check's
// proposal shown as an edit with «Исправить описание» / «Оставить». Every write is the free `avatars.editDescriptor`, against the text it was made
// from (`expectedText`): the text the engine answered last — the stored one, or the one the check judged — never what the owner typed, which the
// engine normalises before it stores it.

/** The owner's words for a refused edit: the rule it broke (with her age in the anchor example), a busy avatar, or the engine's own text. */
function editProblem(error: EngineError, age: number): string {
  if (error.code === "VALIDATION" && error.descriptorReason !== undefined) return descriptorReasonRu(error.descriptorReason, error.descriptorWords, age);
  if (error.code === "IN_FLIGHT") return EDIT_HELD_REASON;
  return errorText(error);
}

const isStale = (error: EngineError): boolean => error.code === "VALIDATION" && error.descriptorReason === "stale";

function Title() {
  return (
    <div className="look-desc-title">
      <h2 className="card-title">Описание</h2>
      <span className="muted">уходит в каждый промпт как якорь внешности</span>
    </div>
  );
}

type Edit = {
  /** What the owner types. */
  readonly draft: string;
  /** The stored text the edit is made against: the engine refuses a save once the description is another. */
  readonly base: string;
  /** After a stale refusal: the text the description holds now, re-read, to compare before saving again. */
  readonly current: string | null;
  /** The draft a rule refused: its reason shows, and «Сохранить» waits, until the text is another. */
  readonly refused: string | null;
};

/** A refusal of the text itself (a rule it breaks), as opposed to a busy avatar or a description that moved meanwhile. */
const ruleRefusal = (error: EngineError): boolean => error.code === "VALIDATION" && error.descriptorReason !== undefined && error.descriptorReason !== "stale";

/** An edit as runs of kept, struck-out and inserted text (a check's proposal, or a body phrase while «Изменить тело» is open). */
function Diff({ parts }: { parts: readonly DiffPart[] }) {
  return (
    <>
      {parts.map((part, i) =>
        part.kind === "same" ? (
          <span key={i}>{part.text}</span>
        ) : part.kind === "del" ? (
          <del key={i} className="dx">
            <span className="sr-only">убрать: </span>
            {part.text}
          </del>
        ) : (
          <ins key={i} className="dx">
            <span className="sr-only">вставить: </span>
            {part.text}
          </ins>
        ),
      )}
    </>
  );
}

/** The swatch legend under the text: where the marked phrase at its end comes from. */
function BodyLegend({ children }: { children: ReactNode }) {
  return (
    <p className="look-legend">
      <span className="look-legend-sw" aria-hidden="true" />
      {children}
    </p>
  );
}

export function DescriptionCard({
  avatar,
  look,
  proposal,
  ready,
  editHeld,
  runDrawing,
  fresh,
  bodyDraft,
}: {
  avatar: AvatarSummary;
  look: LookCheck;
  /** The check whose proposal waits in this card, or null. */
  proposal: DescriptorCheck | null;
  ready: boolean;
  /** This window's own check holds the avatar: an edit now would be refused IN_FLIGHT. */
  editHeld: boolean;
  /** A photo run of hers is drawing: an edit is allowed, and that run finishes with the text it started with. */
  runDrawing: boolean;
  /** Read from the photo at import and not edited since: «прочитано с фото». */
  fresh: boolean;
  /** S5.2d: the body «Изменить тело» is editing, or null: the text then previews the body phrase it would end with (mockup 08). */
  bodyDraft: AvatarBody | null;
}) {
  const { client, store } = useEngine();
  const mounted = useMounted();
  const ids = useId();
  const [said, say] = useAnnouncer();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [busy, setBusy] = useState<"save" | "apply" | null>(null);
  /** Why the owner's own edit was refused: it lives with the open editor. */
  const [editError, setEditError] = useState<EngineError | null>(null);
  /** Why a proposal could not be applied: it lives until the next check starts or ends. */
  const [applyError, setApplyError] = useState<EngineError | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  /** Where the focus goes once the card has drawn its next mode: into the field, or back to «Изменить текст». */
  const [focusNext, setFocusNext] = useState<"field" | "edit" | null>(null);
  const { avatarId } = avatar;
  const { text, age } = avatar.descriptor;
  // S5.2d: the body phrase that closes the descriptor in every prompt (the code writes it; it is never in the stored text). While «Изменить тело» is
  // open, the phrase it would write instead. The text may be as long as 600 less «; » and the phrase (L10).
  const storedPhrase = avatar.body === undefined ? undefined : bodyPhrase(avatar.body);
  const nextPhrase = bodyDraft === null ? storedPhrase : bodyPhrase(bodyDraft);
  const hasTail = storedPhrase !== undefined || nextPhrase !== undefined;
  // A preview only says something when there is a phrase before or after (an import's face-only proposal, untouched, has none: 05).
  const previewing = bodyDraft !== null && hasTail;
  /**
   * «; <the phrase>» after the text, as `promptSubject` joins them (the closing period is the display's own), the change struck out and inserted slot by
   * slot while it is previewed. A body cleared to nothing strikes out its «; » and period too: the text then ends the descriptor.
   */
  const tail: ReactNode = !hasTail ? null : bodyDraft !== null && nextPhrase === undefined ? (
    <span className="desc-body">
      <del className="dx">
        <span className="sr-only">убрать: </span>; {storedPhrase}.
      </del>
    </span>
  ) : (
    <>
      {"; "}
      <span className="desc-body">
        {bodyDraft !== null && storedPhrase !== nextPhrase ? <Diff parts={bodyPhraseDiff(avatar.body ?? {}, bodyDraft)} /> : nextPhrase}
      </span>
      .
    </>
  );
  /** The card itself, for the focus when the button it would go back to is not drawn (the preview of «Изменить тело» has none). */
  const card = useRef<HTMLElement>(null);

  // A check started or ended is about the description as it is now: the refusal of an earlier proposal (a stale text, say) goes with it.
  useEffect(() => {
    setApplyError(null);
  }, [look.phase]);

  useEffect(() => {
    if (focusNext === "field") {
      const node = field.current;
      node?.focus();
      node?.setSelectionRange(node.value.length, node.value.length);
    } else if (focusNext === "edit") (editButton.current ?? card.current)?.focus();
    if (focusNext !== null) setFocusNext(null);
  }, [focusNext]);

  /** The description as the engine holds it now (after a stale refusal): into the window's view, and back to the caller. */
  async function reread(): Promise<string | null> {
    const reply = await client.request("avatars.list", {});
    if (!reply.ok) return null;
    const found = reply.result.avatars.find((a) => a.avatarId === avatarId);
    if (found === undefined) return null;
    store.saveAvatar(found);
    return found.descriptor.text;
  }

  function open(): void {
    setEditError(null);
    setApplyError(null);
    setEdit({ draft: text, base: text, current: null, refused: null });
    setFocusNext("field");
  }

  function close(): void {
    setEdit(null);
    setEditError(null);
    setFocusNext("edit");
  }

  async function save(current: Edit): Promise<void> {
    setBusy("save");
    setEditError(null);
    const reply = await client.request("avatars.editDescriptor", { avatarId, text: current.draft, expectedText: current.base });
    if (!mounted.current) return;
    if (reply.ok) {
      setBusy(null);
      store.saveAvatar(reply.result.avatar);
      setEdit(null);
      setFocusNext("edit");
      say("Описание сохранено");
      return;
    }
    if (isStale(reply.error)) {
      // Someone changed the description since this edit opened: show what it holds now, and make the next save against it — the owner has seen it.
      const now = await reread();
      if (!mounted.current) return;
      if (now !== null) setEdit((e) => (e === null ? e : { ...e, base: now, current: now }));
    } else if (ruleRefusal(reply.error)) setEdit((e) => (e === null ? e : { ...e, refused: current.draft }));
    setBusy(null);
    setEditError(reply.error);
  }

  async function apply(check: DescriptorCheck, fix: string): Promise<void> {
    setBusy("apply");
    setApplyError(null);
    const reply = await client.request("avatars.editDescriptor", { avatarId, text: fix, expectedText: check.checkedText });
    if (!mounted.current) return;
    if (reply.ok) {
      setBusy(null);
      store.saveAvatar(reply.result.avatar);
      look.settle("applied");
      setFocusNext("edit");
      say("Описание исправлено");
      return;
    }
    if (isStale(reply.error)) {
      // The proposal was made for a text that is gone: it goes, and the card shows the description as it is now.
      await reread();
      if (!mounted.current) return;
      setBusy(null);
      look.settle("stale");
      setApplyError(reply.error);
      setFocusNext("edit");
      return;
    }
    setBusy(null);
    setApplyError(reply.error);
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>, current: Edit): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      // One line: Enter saves, it never breaks the line.
      event.preventDefault();
      if (canSave(current)) void save(current);
    }
  }

  // Not while this window's own check holds the avatar: the engine would refuse the save IN_FLIGHT.
  const canSave = (current: Edit): boolean =>
    ready && !editHeld && busy === null && current.draft.trim() !== "" && current.draft !== current.base && current.draft !== current.refused;
  const live = (
    <p className="sr-only" role="status">
      {said}
    </p>
  );
  const problemId = `${ids}-problem`;

  if (edit !== null) {
    // The engine judges the text beside her stored body phrase (`checkDescriptorEdit` with the body): that is the limit the owner types against.
    const limit = textLimit(storedPhrase);
    const over = edit.draft.length > limit;
    // A rule's reason is about the text it refused: once the owner types on, it goes until the next save says otherwise.
    const problem = editError !== null && (!ruleRefusal(editError) || edit.draft === edit.refused) ? editError : null;
    return (
      <section ref={card} tabIndex={-1} className="card look-desc look-desc-edit" aria-label="Описание">
        {live}
        <div className="card-head">
          <Title />
          <div className="look-desc-meta">
            <span className="tag tag-info">правка</span>
            <span className={over ? "mono danger-text" : "mono faint"}>
              {edit.draft.length} / {limit}
            </span>
          </div>
        </div>
        <textarea
          ref={field}
          className="in look-ta"
          lang="en"
          rows={4}
          aria-label="Текст описания"
          aria-invalid={problem !== null && !isStale(problem)}
          aria-describedby={problem !== null ? problemId : undefined}
          value={edit.draft}
          readOnly={busy !== null}
          onChange={(e) => {
            const draft = e.target.value.replace(/[\r\n]+/g, " ");
            setEdit((now) => (now === null ? now : { ...now, draft }));
          }}
          onKeyDown={(e) => onKey(e, edit)}
        />
        {problem !== null && (
          <p id={problemId} className="look-edit-problem" role="alert">
            <Icon name="alert" size={14} strokeWidth={2} />
            <span>{editProblem(problem, age)}</span>
          </p>
        )}
        {edit.current !== null && problem !== null && isStale(problem) && (
          <div className="look-current">
            <p className="muted">Сейчас в описании:</p>
            <p className="descriptor-text mono" lang="en">
              {edit.current}
            </p>
            <button type="button" className="btn btn-s" onClick={() => setEdit((e) => (e === null || e.current === null ? e : { ...e, draft: e.current }))}>
              Взять этот текст
            </button>
          </div>
        )}
        {storedPhrase !== undefined && (
          <BodyLegend>
            Ещё {2 + storedPhrase.length} {plural(2 + storedPhrase.length, ["знак", "знака", "знаков"])} занимает фраза о теле — на текст остаётся {limit} из{" "}
            {DESCRIPTOR_MAX_CHARS}.
          </BodyLegend>
        )}
        {runDrawing && (
          <p className="look-legend">
            <Icon name="info" size={13} strokeWidth={2} />
            Съёмка, которая идёт сейчас, закончит со старым описанием — новое возьмут следующие фото.
          </p>
        )}
        {editHeld && (
          <p className="look-legend">
            <Icon name="info" size={13} strokeWidth={2} />
            {EDIT_HELD_REASON}.
          </p>
        )}
        <div className="look-desc-actions">
          <button type="button" className="btn btn-p" aria-busy={busy === "save"} disabled={!canSave(edit)} onClick={() => void save(edit)}>
            {busy === "save" && <Spin />}
            Сохранить
          </button>
          <button type="button" className="btn" disabled={busy !== null} onClick={close}>
            Отмена
          </button>
          <p className="field-hint">Бесплатно — без запроса к модели. Английскими словами; текст проходит ту же проверку, что и любое описание.</p>
        </div>
      </section>
    );
  }

  if (proposal !== null && proposal.proposal !== null) {
    const fix = proposal.proposal;
    // «Исправить описание» is judged beside her STORED body phrase, whatever «Изменить тело» is previewing: that is the limit the fix must meet.
    const limit = textLimit(storedPhrase);
    return (
      <section ref={card} tabIndex={-1} className="card look-desc look-desc-proposal" aria-label="Описание">
        {live}
        <div className="card-head">
          <Title />
          <div className="look-desc-meta">
            <span className="tag tag-warn">предложение сверки</span>
            <span className={fix.length > limit ? "mono danger-text" : "mono faint"}>
              {fix.length} / {limit}
            </span>
          </div>
        </div>
        <p className="descriptor-text mono" lang="en">
          {hasTail ? (
            <>
              <Diff parts={wordDiff(descriptorHead(proposal.checkedText), descriptorHead(fix))} />
              {tail}
            </>
          ) : (
            <Diff parts={wordDiff(proposal.checkedText, fix)} />
          )}
        </p>
        {applyError !== null && (
          <p className="look-edit-problem" role="alert">
            <Icon name="alert" size={14} strokeWidth={2} />
            <span>{editProblem(applyError, age)}</span>
          </p>
        )}
        <div className="look-desc-actions">
          <button type="button" className="btn btn-p" aria-busy={busy === "apply"} disabled={!ready || busy !== null || editHeld} onClick={() => void apply(proposal, fix)}>
            {busy === "apply" ? <Spin /> : <Icon name="check" size={16} strokeWidth={2.4} />}
            Исправить описание
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => {
              setApplyError(null);
              look.settle("kept");
              setFocusNext("edit");
            }}
          >
            Оставить
          </button>
          <p className="field-hint">{proposalReason(proposal)} Бесплатно: без запроса к модели; новый текст проходит ту же проверку, что и любое описание.</p>
        </div>
      </section>
    );
  }

  const limit = textLimit(nextPhrase);
  return (
    <section ref={card} tabIndex={-1} className={previewing ? "card look-desc look-desc-live" : "card look-desc"} aria-label="Описание">
      {live}
      <div className="card-head">
        <Title />
        <div className="look-desc-meta">
          {previewing ? <span className="tag tag-info">предпросмотр</span> : fresh && <span className="tag">прочитано с фото</span>}
          <span className={text.length > limit ? "mono danger-text" : "mono faint"}>
            {text.length} / {limit}
          </span>
          {/* While «Изменить тело» changes the phrase, the card is its preview (mockup 08) and offers no text edit; with no phrase either side (an
              untouched face-only proposal, 05) the text stays editable. Every save is judged by the engine against the stored state. */}
          {!previewing && (
            <button ref={editButton} type="button" className="btn btn-s" disabled={!ready || editHeld} onClick={open}>
              <Icon name="pencil" size={14} strokeWidth={2} />
              Изменить текст
            </button>
          )}
        </div>
      </div>
      <p className="descriptor-text mono" lang="en">
        {hasTail ? (
          <>
            {descriptorHead(text)}
            {tail}
          </>
        ) : (
          text
        )}
      </p>
      {previewing ? (
        <BodyLegend>меняется только фраза о теле — остальной текст не трогается</BodyLegend>
      ) : storedPhrase !== undefined ? (
        <BodyLegend>фраза о теле — её пишет блок «Тело», не модель</BodyLegend>
      ) : (
        <BodyLegend>фразы о теле пока нет — она появится, когда вы зададите тело</BodyLegend>
      )}
      {applyError !== null && isStale(applyError) && (
        <p className="look-edit-problem" role="alert">
          <Icon name="alert" size={14} strokeWidth={2} />
          <span>{editProblem(applyError, age)}</span>
        </p>
      )}
      {editHeld && (
        <p className="look-legend">
          <Icon name="info" size={13} strokeWidth={2} />
          {EDIT_HELD_REASON}.
        </p>
      )}
    </section>
  );
}

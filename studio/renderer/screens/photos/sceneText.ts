import {
  SCENE_TEXT_MAX,
  type Estimate,
  type SceneGaveUpBy,
  type SceneInterruptedIdea,
  type SceneLiveWrite,
  type SceneOrigin,
  type SceneProblem,
  type SceneSetView,
  type SceneStoppedBy,
  type SceneView,
} from "../../../shared/engine";
import { errorText } from "../../lib/errors";
import { countOf, plural } from "../../lib/format";
import { formatUsdTiered } from "../../lib/money";
import { modelName } from "./runForm";
import { type ApproveBlock, type InterruptedRewrite, sceneNumber, tallyScenes } from "./sceneReview";

// CS.6: what the review UI says, in the CS.0 artboards' words (PhotosCS.dc.html, ReviewStates.dc.html), built from the engine's scene set view. A sentence
// says only what the view (or what this window saw of it) can back: where the design names something the contract does not carry — how many requests a set
// cost, which scenes the model replaced before this window opened — the line leaves it out rather than guess.

const SCENE_ACC = ["сцену", "сцены", "сцен"] as const;
const SCENE_NOM = ["сцена", "сцены", "сцен"] as const;
const PHOTO = ["фото", "фото", "фото"] as const;

const usd = (micros: number, rounding: "up" | "nearest"): string => formatUsdTiered(micros, rounding);

// ---------- buttons ----------

/** «Составить 20 сцен»; with no scenes asked for, the free empty set. */
export function composeTitle(count: number): string {
  return count === 0 ? "Начать пустой набор" : `Составить ${countOf(count, SCENE_ACC)}`;
}

export function continueTitle(scenes: number): string {
  return `Дописать ${countOf(scenes, SCENE_ACC)}`;
}

export function approveTitle(photos: number): string {
  return `Отрисовать ${countOf(photos, PHOTO)}`;
}

/** The idea form's paid button. */
export function ideaTitle(count: number): string {
  return `Написать ${countOf(count, SCENE_ACC)}`;
}

/** «Убрать 35 пустых»: every active scene with no text, in one free edit. */
export function emptyButton(scenes: number): string {
  return `Убрать ${countOf(scenes, ["пустую", "пустые", "пустых"])}`;
}

/** «Другие сцены для 5»: a redraw of the first five given up on (one request). */
export function otherScenesButton(scenes: number): string {
  return scenes === 1 ? "Другая сцена" : `Другие сцены для ${scenes}`;
}

// ---------- the price column ----------

/** What the set cost so far: its closed attempts and its open reserves not in flight (an open one at its ceiling, «до»). */
function spentText(set: Pick<SceneSetView, "spentMicros" | "openReserveMicros">): string {
  if (set.spentMicros === null) return "—";
  if (set.openReserveMicros !== null && set.openReserveMicros > 0) return `до ${usd(set.spentMicros, "up")}`;
  return set.spentMicros === 0 ? "бесплатно" : usd(set.spentMicros, "nearest");
}

/** Anything spent or reserved so far: the total line is «Весь запуск» only for a set that cost nothing yet, then it is «Дальше». */
function hasSpent(set: Pick<SceneSetView, "spentMicros" | "openReserveMicros">): boolean {
  return (set.spentMicros ?? 0) > 0 || (set.openReserveMicros ?? 0) > 0;
}

/**
 * Step 1 («Сцены»): done once the set is written (ticked, with what it cost); while a compose writes, «пишутся»; a stopped set, how many are written
 * («25 из 60», the board's own) and, on a line under it, what it cost so far (README decision 20: the money already spent shows on step 1, stopped too).
 */
export function stepScenes(set: SceneSetView): { label: string; value: string; done: boolean; spent: string | null } {
  const write = set.write;
  // A write of the set running: its own request is not spent yet, but what the earlier ones cost is (README «Деньги на экране»).
  if (write !== null && (write.kind === "compose" || write.kind === "unwritten")) {
    return { label: "Сцены", value: "пишутся", done: false, spent: hasSpent(set) ? `потрачено ${spentText(set)}` : null };
  }
  const tally = tallyScenes(set.scenes);
  if (tally.pending > 0) return { label: "Сцены", value: `${tally.withText} из ${tally.active}`, done: false, spent: `потрачено ${spentText(set)}` };
  return { label: "Сцены", value: spentText(set), done: true, spent: null };
}

// ---------- the column header ----------

export interface CountPart {
  readonly text: string;
  /** The problem counter: a button to the first scene with no text. */
  readonly problem?: { readonly first: number; readonly aria: string };
}

/** The open set's counts under the column title (decision 15): active · removed · problems; or how far a compose got; or what became of a used set. */
export function headerCounts(set: SceneSetView, run: "active" | "ended" | null): CountPart[] {
  const tally = tallyScenes(set.scenes);
  if (set.status === "used") return [{ text: String(tally.withText) }, { text: run === "active" ? "набор в запуске" : "набор стал запуском" }];
  const write = set.write;
  if (write !== null && (write.kind === "compose" || write.kind === "unwritten")) return [{ text: `${tally.withText} из ${tally.active}` }];
  if (tally.pending > 0) return [{ text: `${tally.withText} из ${tally.active} ${plural(tally.withText, ["составлена", "составлены", "составлены"])}` }];
  if (tally.total === 0 && write === null) return [{ text: "0" }, { text: "пустой набор" }];
  const parts: CountPart[] = [{ text: String(tally.active) }];
  if (tally.removed > 0) parts.push({ text: countOf(tally.removed, ["убрана", "убраны", "убрано"]) });
  const blank = set.scenes.filter((s) => !s.removed && s.unwritten === "gave-up");
  const [first] = blank;
  if (first !== undefined) {
    const n = blank.length;
    const aria = n === 1 ? `${countOf(1, SCENE_NOM)} не составлена — перейти к сцене ${sceneNumber(first.sceneId)}` : `${countOf(n, SCENE_NOM)} не составлены — перейти к первой, сцене ${sceneNumber(first.sceneId)}`;
    parts.push({ text: countOf(n, ["не составлена", "не составлены", "не составлены"]), problem: { first: first.sceneId, aria } });
  }
  if (write !== null && write.kind === "idea") parts.push({ text: countOf(write.count, ["пишется", "пишутся", "пишутся"]) });
  return parts;
}

// ---------- why «Отрисовать» waits ----------

export interface Reason {
  readonly pre: string;
  /** A scene named in the reason: a link that scrolls to it and takes the focus there. */
  readonly link: { readonly text: string; readonly sceneId: number } | null;
  readonly post: string;
}

/** The reason under a disabled «Отрисовать»; `firstPlaceholder` names where an idea write's placeholders begin. */
export function approveReason(block: ApproveBlock, firstPlaceholder = 0): Reason {
  switch (block.kind) {
    case "writing": {
      const write = block.write;
      if (write.kind === "idea") return { pre: "Модель пишет ", link: { text: countOf(write.count, ["свою сцену", "своих сцены", "своих сцен"]), sceneId: firstPlaceholder }, post: " — отрисовать можно, когда она закончит." };
      const ids = write.sceneIds ?? [];
      const [first] = ids;
      const text = ids.length === 1 && first !== undefined ? `сцену ${sceneNumber(first)}` : "другие сцены";
      return { pre: "Модель пишет ", link: first === undefined ? null : { text, sceneId: first }, post: " — отрисовать можно, когда она закончит." };
    }
    case "no-text":
      return block.others === 0
        ? { pre: "", link: { text: `Сцена ${sceneNumber(block.first)}`, sceneId: block.first }, post: " без текста — напишите её, попросите другую или уберите." }
        : { pre: "", link: { text: `Сцена ${sceneNumber(block.first)}`, sceneId: block.first }, post: ` и ещё ${block.others} без текста — уберите их, попросите другие или напишите сами.` };
    case "empty":
      return { pre: "Добавьте хотя бы одну сцену.", link: null, post: "" };
    case "too-many":
      return { pre: "Больше 100 сцен в одном запуске нельзя — уберите лишние.", link: null, post: "" };
  }
}

// ---------- a scene card ----------

/** A scene given up on («не составлена»), by why. */
export function gaveUpText(by: SceneGaveUpBy): string {
  switch (by) {
    case "rejected":
      return "Отброшена при проверке: модель дважды вернула неподходящий текст. Напишите сами, попросите другую или уберите — без текста набор не отрисовать.";
    case "refused":
      return "Модель отказалась писать эту сцену (отказ провайдера) — тот же запрос откажут снова. Напишите сами, попросите другую или уберите.";
    case "no-attempts":
      return "У её запроса не осталось попыток. Напишите сами, попросите другую или уберите.";
  }
}

/** `text` cut to `max` chars, with «…»: whole clauses (up to a comma) while they fit, else whole words. */
function cut(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const fit = (parts: readonly string[], sep: string): string => {
    let out = "";
    for (const part of parts) {
      const next = out === "" ? part : `${out}${sep}${part}`;
      if (next.length > max) break;
      out = next;
    }
    return out;
  };
  const head = fit(trimmed.split(/,\s*/), ", ") || fit(trimmed.split(/\s+/), " ") || trimmed.slice(0, max);
  return `${head.replace(/[\s,.;:—-]+$/u, "")}…`;
}

/** The line under an own scene's text: the idea it was written from. */
export function ideaLine(idea: string): string {
  return `по описанию: «${cut(idea, 48)}»`;
}

const quoted = (words: readonly string[]): string => words.map((w) => `«${w}»`).join(", ");

/** Why an edit did not go through (the assembler's own rule, checked for free): nothing changed. */
export function problemText(problem: SceneProblem): string {
  const many = problem.words.length > 1;
  const word = many ? `Слова ${quoted(problem.words)} не пройдут в промпт — замените их` : `Слово ${quoted(problem.words)} не пройдёт в промпт — замените его`;
  switch (problem.reason) {
    case "revealing-word":
      return `${word}. Откровенных нарядов нет ни в одной категории.`;
    case "youth-word":
      return `${word}: в сценах только взрослый человек.`;
    case "empty":
      return "Пустой текст не сохранить — напишите сцену или уберите её.";
    case "too-long":
      return `Не больше ${SCENE_TEXT_MAX} знаков.`;
    case "not-one-line":
      return "Текст сцены — одна строка: уберите переносы.";
    case "control-char":
      return "В тексте есть невидимые служебные символы — уберите их.";
  }
}

/** A Russian text goes into the prompt as it is: the way to an English one, by where the scene came from (owner decision 2). */
export function cyrillicHint(origin: SceneOrigin): string {
  return origin === "own"
    ? "Текст на русском уйдёт в промпт без перевода. ⟳ «Переписать» напишет текст по-английски заново — по идее этой сцены, а не по правке; другую идею добавьте через «+ Своя сцена»."
    : "Текст на русском уйдёт в промпт без перевода. Написать его по-английски модель может только как новую сцену: «+ Своя сцена» напишет её по этому описанию, а эту тогда уберите — правка здесь её не переведёт.";
}

// ---------- the ⟳ price popover ----------

/** ⟳ «Другая сцена» on a planned scene redraws all of it (owner decision 3): the copy names every part that changes. */
export function redrawText(category: string, sceneId: number): string {
  return `Новое место, наряд, действие и время дня из «${category}» и новый текст. Сцена ${sceneNumber(sceneId)} заменится, когда новая будет готова; если не выйдет — останется как есть.`;
}

/** ⟳ «Переписать» on an own scene: from its stored idea, shot and pose kept. */
export function ownRewriteText(idea: string): string {
  return `Новый текст по вашему описанию «${cut(idea, 25)}». Кадр и ракурс те же.`;
}

/** A redraw of a scene whose custom category was deleted: refused for free. */
export function redrawGoneText(category: string): string {
  return `Категории «${category}» больше нет — новое место из неё не взять. Перепишите текст карандашом или уберите сцену.`;
}

/** The small print under a popover's text: what one request may cost at most. */
export function writeCapLine(worstMicros: number): string {
  return `до ${usd(worstMicros, "up")} — предел одного запроса к модели (2 попытки); обычно уходит меньше цента`;
}

/** A scene whose earlier rewrite was cut off: ⟳ offers to carry that one on, or to start another (which takes the scene over from it). */
export function interruptedChoiceText(origin: SceneOrigin): string {
  return origin === "own"
    ? "Прошлый новый текст этой сцены не дописан. «Повторить» допишет его; «Переписать» начнёт заново — и прерванный больше не повторить."
    : "Прошлая замена этой сцены прервана. «Повторить» допишет её — с тем же новым местом; «Заменить» начнёт другую — и прерванную больше не повторить.";
}

// ---------- column notices ----------

/** What the window knows of a request a stop left behind: still reserved at its worst, closed by a reconcile it saw, or neither (nothing to say). */
export type ReserveState = "open" | "reconciled" | "none";

function tallyLine(set: SceneSetView): { written: number; total: number } {
  const tally = tallyScenes(set.scenes.filter((s) => s.origin === "planned"));
  return set.lastCompose === null ? { written: tally.withText, total: tally.active } : { written: set.lastCompose.written, total: set.lastCompose.total };
}

/** The scenes of the request the stop cut off, when the view says which: the one waiting chunk left a single attempt. */
function cutOffScenes(set: SceneSetView): number | null {
  const waiting = set.chunks.filter((c) => c.attemptsLeft === 1 && set.scenes.some((s) => c.sceneIds.includes(s.sceneId) && !s.removed && s.unwritten === "pending"));
  const [chunk] = waiting;
  if (waiting.length !== 1 || chunk === undefined) return null;
  return set.scenes.filter((s) => chunk.sceneIds.includes(s.sceneId) && !s.removed && s.unwritten === "pending").length;
}

const CONTINUE_LATER = "Допишите остальные кнопкой «Дописать» или уберите пустые.";

/** The reserve a stop left, told by `reconciledMicros`: what this window saw open before a reconcile closed it (null when it saw none). */
function reconciledLine(subject: string, reconciledMicros: number | null, set: SceneSetView): string {
  const amount = reconciledMicros === null ? "" : ` — ${usd(reconciledMicros, "up")} —`;
  const scenes = cutOffScenes(set);
  const left = scenes === null ? "" : `: у его ${countOf(scenes, SCENE_NOM)} осталась одна`;
  return `${subject} закрыт при сверке по худшей цене${amount} и считается попыткой${left}.`;
}

/**
 * A compose or «Дописать» that stopped (`stoppedBy`, ReviewStates E 1–4). An open reserve is «учтён по худшей цене до сверки»; one this window saw open
 * and then closed is «закрыт при сверке»; a window that never saw it open says nothing of it.
 */
export function stoppedNotice(set: SceneSetView, reconciledMicros: number | null): { title: string; text: string } {
  const { written, total } = tallyLine(set);
  const by: SceneStoppedBy = set.stoppedBy ?? "closed";
  const title = `${by === "closed" ? "Составление прервано" : "Составление остановлено"} · готово ${written} из ${total}`;
  const open = set.openReserveMicros !== null && set.openReserveMicros > 0;
  const reconciled = !open && reconciledMicros !== null;
  switch (by) {
    case "closed":
      return {
        title,
        text: open
          ? "Studio закрылась, пока модель писала сцены. Готовые сохранены. Прерванный запрос до сверки расходов учтён по худшей цене — дописать остальные можно после неё. Отрисовать можно только сцены с текстом: пустые допишите или уберите."
          : reconciled
            ? `Studio закрылась, пока модель писала сцены. Готовые сохранены; ${reconciledLine("прерванный запрос", reconciledMicros, set).slice(0, -1)}. ${CONTINUE_LATER}`
            : `Studio закрылась, пока модель писала сцены. Готовые сохранены. ${CONTINUE_LATER}`,
      };
    case "cancelled":
      return {
        title,
        text: open
          ? "Вы отменили составление. Готовые сцены сохранены. Оборванный запрос до сверки расходов учтён по худшей цене — дописать остальные можно после неё."
          : reconciled
            ? `Вы отменили составление. Готовые сцены сохранены. ${reconciledLine("Оборванный запрос", reconciledMicros, set)} ${CONTINUE_LATER}`
            : `Вы отменили составление. Готовые сцены сохранены. ${CONTINUE_LATER}`,
      };
    case "rate-limited":
      return { title, text: "OpenRouter ответил 429 — слишком много запросов. Готовые сцены сохранены; ответ с ошибкой не списывается. Допишите остальные, когда он снова ответит, или уберите пустые." };
    case "provider-error":
      return { title, text: "OpenRouter не отвечает. Готовые сцены сохранены; ответ с ошибкой не списывается. Допишите остальные, когда он снова ответит, или уберите пустые." };
    case "network":
    case "timeout": {
      const lead = by === "network" ? "Связь с OpenRouter оборвалась." : "OpenRouter не ответил вовремя.";
      return {
        title,
        text: open
          ? `${lead} Готовые сцены сохранены. Запрос мог дойти — до сверки расходов он учтён по худшей цене; дописать остальные можно после неё.`
          : reconciled
            ? `${lead} Готовые сцены сохранены. ${reconciledLine("Запрос", reconciledMicros, set)} ${CONTINUE_LATER}`
            : `${lead} Готовые сцены сохранены. ${CONTINUE_LATER}`,
      };
    }
    case "failed":
      return { title, text: `${set.stoppedError === null ? "Составление остановилось." : errorText(set.stoppedError)} Готовые сцены сохранены. ${CONTINUE_LATER}` };
  }
}

/** A compose that ended with whole requests given up on (ReviewGaveUp): how many of how many, and why, by the reason most of them share. */
export function gaveUpNotice(set: SceneSetView): { title: string; text: string } {
  const blank = set.scenes.filter((s) => !s.removed && s.unwritten === "gave-up");
  const tally = set.lastCompose ?? { total: tallyScenes(set.scenes).active, written: tallyScenes(set.scenes).withText, gaveUp: blank.length };
  const title = `Готово ${tally.written} из ${tally.total} · ${countOf(tally.gaveUp, ["не составлена", "не составлены", "не составлены"])}`;
  const by = (reason: SceneGaveUpBy): number => blank.filter((s) => s.gaveUpBy === reason).length;
  if (by("refused") > by("rejected") && by("refused") >= by("no-attempts")) {
    return { title, text: "Модель отказалась писать их — отказ провайдера, тот же запрос откажут снова. Уберите их, попросите другие (новое место) или напишите сами." };
  }
  if (by("no-attempts") > by("rejected")) return { title, text: "У их запроса не осталось попыток. Уберите их, попросите другие или напишите сами." };
  return { title, text: "Отброшены при проверке: модель дважды вернула для них неподходящий текст. Уберите их, попросите другие или напишите сами." };
}

/** «сцены 02», «сцен 26, 27». */
function scenesOf(ids: readonly number[]): string {
  return ids.length === 1 ? `сцены ${sceneNumber(ids[0] ?? 0)}` : `сцен ${ids.map(sceneNumber).join(", ")}`;
}

/** A rewrite cut short (ReviewRewriteInterrupted, ReviewStates E): the scene stayed as it was; the text by why, the reserve by what the window knows. */
export function rewriteNotice(group: InterruptedRewrite, origin: SceneOrigin, reserve: ReserveState): { title: string; text: string } {
  const one = group.sceneIds.length === 1;
  const numbers = group.sceneIds.map(sceneNumber).join(", ");
  const subject = one ? `Сцена ${numbers} осталась как была` : `Сцены ${numbers} остались как были`;
  const stayed = one ? "сцена осталась как была" : "сцены остались как были";
  const verdict = group.stoppedBy === "cancelled" ? "отменена" : group.stoppedBy === "rate-limited" || group.stoppedBy === "provider-error" || group.stoppedBy === "failed" ? "не удалась" : "прервана";
  const title = `Замена ${scenesOf(group.sceneIds)} ${verdict}`;
  const what = origin === "own" ? `переписывала ${one ? "сцену" : "сцены"} ${numbers}` : `писала ${one ? "другую сцену" : "другие сцены"} ${numbers}`;
  let text: string;
  switch (group.stoppedBy) {
    case "closed":
      text = `Studio закрылась, пока модель ${what}, — ${stayed}. ${reserve === "reconciled" ? "Прерванный запрос закрыт при сверке по худшей цене." : "Остальной набор в порядке."}`;
      break;
    case "cancelled":
      text = `Вы отменили замену ${scenesOf(group.sceneIds)} посреди запроса — ${stayed}.${reserve === "open" ? " Оборванный запрос до сверки расходов учтён по худшей цене." : reserve === "reconciled" ? " Оборванный запрос закрыт при сверке по худшей цене." : ""}`;
      break;
    case "rate-limited":
      text = `OpenRouter ответил 429 — слишком много запросов. ${subject}; ответ с ошибкой не списывается.`;
      break;
    case "provider-error":
      text = `OpenRouter не отвечает. ${subject}; ответ с ошибкой не списывается.`;
      break;
    case "network":
    case "timeout":
      text = `${group.stoppedBy === "network" ? "Связь с OpenRouter оборвалась." : "OpenRouter не ответил вовремя."} ${subject}.${reserve === "open" ? " Запрос мог дойти — до сверки расходов он учтён по худшей цене." : reserve === "reconciled" ? " Запрос закрыт при сверке по худшей цене." : ""}`;
      break;
    case "failed":
      text = `Запрос к модели не удался. ${subject}.`;
      break;
  }
  if (group.removed.length > 0) {
    const removed = group.removed.map(sceneNumber).join(", ");
    text += group.removed.length === 1 ? ` Сцена ${removed} убрана — верните её, чтобы повторить.` : ` Сцены ${removed} убраны — верните их, чтобы повторить.`;
  }
  return { title, text };
}

/** An idea write cut short: none of its scenes was added; the idea is kept for «Повторить» and «Открыть идею». */
export function ideaNotice(idea: SceneInterruptedIdea, reserve: ReserveState): { title: string; text: string } {
  const one = idea.count === 1;
  const title = one ? "Своя сцена не написана" : "Свои сцены не написаны";
  const notAdded = one ? "она не добавлена" : "они не добавлены";
  const scenes = countOf(idea.count, SCENE_ACC);
  let lead: string;
  switch (idea.stoppedBy) {
    case "closed":
      lead = `Studio закрылась, пока модель писала ${scenes} по вашему описанию, — ${notAdded}.`;
      break;
    case "cancelled":
      lead = `Вы отменили запись ${countOf(idea.count, ["сцены", "сцен", "сцен"])} по вашему описанию — ${notAdded}.${reserve === "open" ? " Оборванный запрос до сверки расходов учтён по худшей цене." : reserve === "reconciled" ? " Оборванный запрос закрыт при сверке по худшей цене." : ""}`;
      break;
    case "rate-limited":
      lead = `OpenRouter ответил 429 — слишком много запросов. ${one ? "Сцена не добавлена" : "Сцены не добавлены"}; ответ с ошибкой не списывается.`;
      break;
    case "provider-error":
      lead = `OpenRouter не отвечает. ${one ? "Сцена не добавлена" : "Сцены не добавлены"}; ответ с ошибкой не списывается.`;
      break;
    case "network":
    case "timeout":
      lead = `${idea.stoppedBy === "network" ? "Связь с OpenRouter оборвалась." : "OpenRouter не ответил вовремя."} ${one ? "Сцена не добавлена" : "Сцены не добавлены"}.${reserve === "open" ? " Запрос мог дойти — до сверки расходов он учтён по худшей цене." : reserve === "reconciled" ? " Запрос закрыт при сверке по худшей цене." : ""}`;
      break;
    case "failed":
      lead = `Запрос к модели не удался — ${notAdded}.`;
      break;
  }
  return { title, text: `${lead} Текст идеи сохранён.` };
}

/** The ok notice once a set's run is drawn (ReviewStates F). */
export function runDoneText(photos: number): string {
  return `В галерее ${countOf(photos, PHOTO)} этого набора. Новый набор — кнопкой «Составить» в карточке.`;
}

/** Review off with a set open (ReviewOff): the set is kept, and how to come back to it. «с вашими правками» only when there are some. */
export function offNoteSet(set: SceneSetView): string {
  const tally = tallyScenes(set.scenes);
  const touched = tally.removed > 0 || tally.own > 0 || set.scenes.some((s: SceneView) => s.edited);
  // CS.7 M3: a write of the set running (another window's: this one keeps the switch on meanwhile) — the set is being written, not saved yet.
  return `Открытый набор — ${countOf(tally.active, SCENE_NOM)}${touched ? " с вашими правками" : ""} — ${set.write !== null ? "пишется" : "сохранён"}. Включите проверку, чтобы вернуться к нему.`;
}

// ---------- the task line ----------

/** The scenes job's label (aria-live), by what it writes. `scenes` finds whether a rewritten scene is an own one. */
export function progressLabel(write: SceneLiveWrite, done: number, total: number, scenes: readonly SceneView[]): string {
  switch (write.kind) {
    case "compose":
      return `Составляем сцены: ${done} из ${total}`;
    case "unwritten":
      // CS.7 L2: in the words of its button, «Дописываем…».
      return `Дописываем сцены: ${done} из ${total}`;
    case "idea":
      return `Пишем ${countOf(write.count, ["свою сцену", "своих сцены", "своих сцен"])} по описанию`;
    case "rewrite": {
      const ids = write.sceneIds ?? [];
      const [first] = ids;
      if (ids.length === 1 && first !== undefined) {
        const own = scenes.find((s) => s.sceneId === first)?.origin === "own";
        return own ? `Переписываем сцену ${sceneNumber(first)}` : `Пишем другую сцену вместо ${sceneNumber(first)}`;
      }
      return `Пишем другие сцены вместо ${ids.map(sceneNumber).join(", ")}`;
    }
  }
}

/** Scenes in one writer request (the contract's `SCENE_CHUNK_SIZE`). */
const PER_REQUEST = 25;

/** The line under the bar: a compose's requests and model, or what the request in flight may cost (this window's accepted price, when it sent it). */
export function progressNote(write: SceneLiveWrite, done: number, total: number, textModel: string, price: Estimate | null): string {
  if (write.kind === "compose" || write.kind === "unwritten") {
    const requests = Math.max(1, Math.ceil(total / PER_REQUEST));
    if (requests === 1) return `${modelName(textModel)} · до ${PER_REQUEST} сцен за запрос · обычно 10–20 с`;
    return `запрос ${Math.min(requests, Math.floor(done / PER_REQUEST) + 1)} из ${requests} · ${modelName(textModel)} · по ${PER_REQUEST} сцен за запрос`;
  }
  const after = write.kind === "rewrite" && (write.sceneIds?.length ?? 1) === 1 ? "правки набора — после неё" : "правки набора — после них";
  return price === null ? after : `≈ ${usd(price.expectedMicros, "nearest")} · до ${usd(price.worstMicros, "up")} · ${after}`;
}

// ---------- «Пересоставить сцены?» ----------

/**
 * What goes with the set: its own scenes (paid for), the scenes the model replaced (only those this window saw replaced: the view keeps no such mark),
 * the hand edits and the removals. Empty when there is nothing of the owner's to lose.
 */
export function recomposeLosses(set: SceneSetView, replaced: number): string[] {
  const tally = tallyScenes(set.scenes);
  const edited = set.scenes.filter((s) => s.edited).length;
  const lines: string[] = [];
  if (tally.own > 0) lines.push(`${countOf(tally.own, ["своя сцена", "свои сцены", "своих сцен"])} — ${tally.own === 1 ? "написана" : "написаны"} по описанию, за ${tally.own === 1 ? "неё" : "них"} заплачено;`);
  if (replaced > 0) lines.push(`${countOf(replaced, ["сцена, заменённая", "сцены, заменённые", "сцен, заменённых"])} моделью («Другая сцена»);`);
  const touched = [edited > 0 ? countOf(edited, ["правка текста", "правки текста", "правок текста"]) : null, tally.removed > 0 ? countOf(tally.removed, ["убранная сцена", "убранные сцены", "убранных сцен"]) : null].filter((t): t is string => t !== null);
  if (touched.length > 0) lines.push(`${touched.join(" и ")};`);
  const last = lines.at(-1);
  if (last !== undefined) lines[lines.length - 1] = `${last.slice(0, -1)}.`;
  return lines;
}

/**
 * What the set already cost (its `spentMicros`; an open reserve at its ceiling), or null when it cost nothing: the amount apart from the words around
 * it, for the dialog to set it in mono (CS.7 V5, «Деньги на экране»).
 */
export function recomposeSpent(set: SceneSetView): { before: string; amount: string; after: string } | null {
  if (set.spentMicros === null || set.spentMicros === 0) return null;
  const open = set.openReserveMicros !== null && set.openReserveMicros > 0;
  return {
    before: open ? "Набор уже стоил до " : "Набор уже стоил ",
    amount: usd(set.spentMicros, open ? "up" : "nearest"),
    after: ". Эти деньги потрачены и не вернутся.",
  };
}

/** After the discard: the card opens for settings again, with its own price on «Составить». */
export function recomposeAfter(count: number): string {
  return `Потом карточка снова откроется для настроек и предложит «${composeTitle(count)}» — со своей ценой на кнопке.`;
}

// ---------- fixed lines ----------

// ---------- the price column and the models line ----------

const PRICE_DAY = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
const PRICE_DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * «OpenRouter · 24 сент.» for live prices, «резервные · 24 сент.» for the dated fallback table — the generate card's and the strip's «Цены» line. The year
 * only when it is not this one (CS.7 V1: with it the line wrapped at both widths; the design draws «OpenRouter · 5 окт.»); an old table keeps it.
 */
export function priceSourceText(prices: "live" | "fallback" | null, asOf: string | null, now: Date = new Date()): string {
  if (prices === null || asOf === null) return "—";
  const at = Date.parse(`${asOf}T00:00:00Z`);
  const date = (new Date(at).getUTCFullYear() === now.getFullYear() ? PRICE_DAY : PRICE_DATE).format(at);
  return prices === "live" ? `OpenRouter · ${date}` : `резервные · ${date}`;
}

/** The strip's models line, hovered: the image side is today's Settings, the text model is the set's own (CS.7). */
export const MODELS_LINE_TITLE =
  "Картинки — по текущим Настройкам: модель и качество можно сменить до «Отрисовать», цена пересчитается. Текст — модель этого набора: ею написаны его сцены.";

/** CS.7 M3: why «Сцены на проверку» cannot be turned off now — off would hide the running write and its «Отменить». */
export const SWITCH_WAITS = "Пока модель пишет сцены, проверку не выключить — дождитесь конца или отмените запись.";
export const CANCEL_HINT ="Отмена посреди запроса остановит платные действия до сверки расходов.";
export const CANCELLING_NOTE = "отмена отправлена · ждём конца запроса";
export const SCENES_CHANGED_EDIT = "Набор изменился в другом окне — ваша правка не сохранена. Показана свежая версия; повторите правку.";
export const SCENES_CHANGED_APPROVE = "Пока считалась цена, набор изменился — проверьте сцены и нажмите снова.";
export const WRITE_CAP_TEXT = "Слишком много правок в этом наборе — пересоставьте его.";
export const IDEA_HINT = "Модель напишет сцены по-английски по своим правилам: в селфи телефон в одной руке, поза совпадает с ракурсом. Ракурсы — как в карточке, «Авто» не берёт зеркало.";
export const EMPTY_SET_LINE = "В наборе пока нет сцен. Опишите идею выше — сцены по ней напишет модель. Отрисовать можно, когда будет хотя бы одна.";
export const OFF_NOTE = "Сцены составятся и отрисуются за один запуск, как раньше: «Сгенерировать» платит сразу за всё.";

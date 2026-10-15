import { CLIP_REASONS_RU, type ClipUse, type EngineError } from "../../../shared/engine";
import { countOf, NBSP } from "../../lib/format";

// 5b.2 part A (S5.WA4; plan §6 41e, 44b; mockups 41e and 44b, README §S5.WAD «Тексты», WAD re-review N4): what the avatar's «Клипы» screen says of a ready
// clip's use (`ClipSummary.use`, Q-F = 1). A finished video holds the clip's frame either through the clip itself (`inVideo: "clip"`) or through its photo or
// a sibling clip (`"photo"`): the tile's badge «в видео» is one for both, its title tells them apart. «Удалить клип?» says the finished video keeps its
// picture only when it holds THIS clip, and names the draft holding the clip's copy (one by name and kadr, several by number). A render holding the copy is
// not part of `use`: «Удалить» is refused `in-use`, and only then does the dialog say so.

/** A no-break space before a dash, so a wrapped line never starts with «—» (README L3). */
const nbDash = (text: string): string => text.replace(/ — /g, `${NBSP}— `);

const USED_TITLES: Record<NonNullable<ClipUse["inVideo"]>, string> = {
  clip: "Этот клип уже в готовом видео — второй раз не ставится",
  photo: "Фото этого клипа или другой клип из него уже в готовом видео — второй раз не ставится",
};

/** 41e: the tile's «в видео», with the title of the way the video holds the frame; null when no finished video does. */
export function clipUsedBadge(use: ClipUse | undefined): { label: string; title: string } | null {
  const how = use?.inVideo;
  return how === undefined ? null : { label: "в видео", title: USED_TITLES[how] };
}

const DRAFT_FORMS = ["черновике", "черновиках", "черновиках"] as const;

/** 44b: the dialog's lines under 44's text: a finished video that holds this clip (info), the drafts that hold its copy (a warning). */
export function deleteUseLines(use: ClipUse | undefined): { video: string | null; draft: string | null } {
  const video = use?.inVideo === "clip" ? nbDash("Клип есть в готовом видео — видео не изменится.") : null;
  const drafts = use?.inDrafts;
  if (drafts === undefined) return { video, draft: null };
  const { count, first } = drafts;
  if (count === 1 && first !== undefined) {
    // The drafts screen calls a draft with no name «без названия», unquoted.
    const name = first.name === null ? "без названия" : `«${first.name}»`;
    return { video, draft: nbDash(`В черновике ${name} он в кадре ${first.frame} — кадр будет помечен, пока его не замените.`) };
  }
  if (count === 1) return { video, draft: nbDash("В одном черновике он стоит кадром — кадр будет помечен, пока его не замените.") };
  return { video, draft: nbDash(`В ${countOf(count, DRAFT_FORMS)} он стоит кадром — кадры будут помечены, пока их не замените.`) };
}

/** 44b `#in-render`: the line «Удалить» brings back when a render holds the clip's copy (the contract's `in-use`). */
export const IN_RENDER_LINE = nbDash(CLIP_REASONS_RU["in-use"]);

/** What became of «Удалить»: the clip is gone; a render holds its copy (the dialog stays and says so, a try after the render is harmless); another refusal. */
export function deleteOutcome(reply: { ok: true } | { ok: false; error: EngineError }): { kind: "deleted" } | { kind: "in-render" } | { kind: "refused"; error: EngineError } {
  if (reply.ok) return { kind: "deleted" };
  if (reply.error.code === "IN_FLIGHT" && reply.error.clipReason === "in-use") return { kind: "in-render" };
  return { kind: "refused", error: reply.error };
}

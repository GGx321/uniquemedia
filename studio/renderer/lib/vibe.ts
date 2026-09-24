import { adultTextProblems, ageMentions, ageUpperBounds, youthWords } from "../../shared/engine";
import { VIBE_MAX } from "./traits";

/** The contract's hidden characters (avatar.ts NO_HIDDEN_CHARS): control, format, lone surrogates, line and paragraph separators. */
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

function quoted(items: readonly string[]): string {
  return [...new Set(items.map((s) => s.toLowerCase()))].map((s) => `«${s}»`).join(", ");
}

/**
 * Why the vibe cannot be sent, in Russian, one message per problem; empty when
 * it is fine. Runs the same `ageText` rules as the contract's `AvatarTraits`
 * (vibe scope: hard markers of a minor only, so "girl next door" passes).
 */
export function vibeIssues(vibe: string, age: number): string[] {
  const issues: string[] = [];
  if (vibe.length > VIBE_MAX) issues.push(`Не длиннее ${VIBE_MAX} символов — сейчас ${vibe.length}.`);
  if (HIDDEN_CHARS.test(vibe)) issues.push("Уберите невидимые и управляющие символы.");

  for (const problem of adultTextProblems(vibe, age, "vibe")) {
    switch (problem) {
      case "youth-word":
        issues.push(
          `Слова о несовершеннолетних недопустимы: ${quoted(youthWords(vibe, "vibe"))}. Все аватары — взрослые, от 21 года.`,
        );
        break;
      case "other-age": {
        const other = ageMentions(vibe).filter((n) => n !== age);
        issues.push(`В вайбе указан другой возраст (${other.join(", ")}). Возраст задаётся ползунком — уберите его из текста.`);
        break;
      }
      case "under-21-bound":
        issues.push(`Уберите ограничение возраста (${ageUpperBounds(vibe).join(", ")}): все аватары старше 21 года.`);
        break;
      case "script":
        issues.push("Пишите латиницей или кириллицей и не смешивайте алфавиты внутри одного слова.");
        break;
      case "non-ascii-digits":
        issues.push("Используйте обычные цифры 0–9.");
        break;
    }
  }
  return issues;
}

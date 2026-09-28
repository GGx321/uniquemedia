/** A no-break space: Russian typography keeps a number on the same line as its unit ("25 лет", "40 с", "20 МБ"). */
export const NBSP = "\u00a0";

/** Russian plural form: plural(21, ["аватар", "аватара", "аватаров"]) → "аватар". */
export function plural(n: number, forms: readonly [one: string, few: string, many: string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

/** "4 варианта", the number bound to its word by a no-break space. */
export function countOf(n: number, forms: readonly [string, string, string]): string {
  return `${n}${NBSP}${plural(n, forms)}`;
}

export function yearsOld(age: number): string {
  return countOf(age, ["год", "года", "лет"]);
}

const GROUPING = new Intl.NumberFormat("ru-RU", { useGrouping: true, maximumFractionDigits: 0 });

/** A whole number with Russian digit grouping: 1248 → "1 248" (a no-break space, never split across lines). */
export function groupNumber(n: number): string {
  return GROUPING.format(n).replace(/\s/g, NBSP);
}

const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

/** "2026-09" → "Сентябрь". */
export function monthName(yearMonth: string): string {
  const name = MONTHS[Number(yearMonth.split("-")[1]) - 1];
  if (!name) return yearMonth;
  return `${name[0]?.toUpperCase()}${name.slice(1)}`;
}

const DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** An ISO date-time as "24 сент. 2026 г.". */
export function dateLabel(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : DATE.format(time);
}

/** A wait as "1 мин 35 с" or "40 с", rounded up to whole seconds; each number stays with its unit. */
export function waitLabel(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest}${NBSP}с`;
  return rest === 0 ? `${minutes}${NBSP}мин` : `${minutes}${NBSP}мин ${rest}${NBSP}с`;
}

/**
 * A sentence placed after a colon starts lowercase in Russian ("…получить: модель отказалась…").
 * A first word with a capital inside it (OpenRouter, API) is a name and is left as it is.
 */
export function afterColon(sentence: string): string {
  const first = sentence.split(/\s/, 1)[0] ?? "";
  if (first.length === 0 || /\p{Lu}/u.test(first.slice(1))) return sentence;
  return `${first[0]?.toLowerCase()}${sentence.slice(1)}`;
}

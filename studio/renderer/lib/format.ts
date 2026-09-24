/** Russian plural form: plural(21, ["аватар", "аватара", "аватаров"]) → "аватар". */
export function plural(n: number, forms: readonly [one: string, few: string, many: string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

export function countOf(n: number, forms: readonly [string, string, string]): string {
  return `${n} ${plural(n, forms)}`;
}

export function yearsOld(age: number): string {
  return countOf(age, ["год", "года", "лет"]);
}

const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

/** "2026-09" → "Сентябрь 2026". */
export function monthLabel(yearMonth: string): string {
  const [year, month] = yearMonth.split("-");
  const name = MONTHS[Number(month) - 1];
  if (!year || !name) return yearMonth;
  return `${name[0]?.toUpperCase()}${name.slice(1)} ${year}`;
}

const DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** An ISO date-time as "24 сент. 2026 г.". */
export function dateLabel(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : DATE.format(time);
}

/** A wait as "1 мин 35 с" or "40 с", rounded up to whole seconds. */
export function waitLabel(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} с`;
  return rest === 0 ? `${minutes} мин` : `${minutes} мин ${rest} с`;
}

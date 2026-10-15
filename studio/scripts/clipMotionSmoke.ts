// What the E2E smoke (smoke-engine.ts) checks of part C «свои движения», as functions with no Electron in them: they are held by clipMotionSmoke.test.ts, and the engine's own run against the mock OpenRouter's chat
// route by clipMotionSmoke.engine.test.ts; the smoke only has to call them with what its mock and the app reported. Stage 5, 5b.2, S5.WC4.

/** A place the owner's idea must not be in: its name, and everything it holds as text. */
export interface Haystack {
  where: string;
  text: string;
}

/** The label of an own idea is his words cut to 40 characters, so a fragment longer than that is not a label. */
const FRAGMENT = 41;

/** `\uXXXX` for every non-ASCII code unit, in the case asked for. */
function asciiEscaped(text: string, upper: boolean): string {
  return text.replace(/[^\x20-\x7e]/g, (c) => {
    const hex = c.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${upper ? hex.toUpperCase() : hex}`;
  });
}

/**
 * I5.67, the canary: the owner's full text lives only in the translator's chat request (and in memory while the call runs). It is never persisted, logged, put in an event or sent to the video provider. A place
 * "holds a fragment" when any 41 characters in a row of the idea (as typed, JSON-escaped, or `\u`-escaped in either case: the forms in which a raw body could echo it) are found in it. The label, his first 40
 * characters, is allowed: 40 characters are not a fragment. Empty when no place holds one; otherwise one line per place that does.
 */
export function canaryProblems(idea: string, places: readonly Haystack[], marker?: string): string[] {
  if (idea.length <= FRAGMENT - 1) return ["the idea is not longer than 40 characters, so a fragment of it cannot be told from its label"];
  const json = JSON.stringify(idea).slice(1, -1);
  const forms = [idea, json, asciiEscaped(json, false), asciiEscaped(json, true)];
  const problems: string[] = [];
  for (const place of places) {
    const found = forms.flatMap((form) => {
      for (let i = 0; i + FRAGMENT <= form.length; i++) if (place.text.includes(form.slice(i, i + FRAGMENT))) return [i];
      return [];
    })[0];
    if (found !== undefined) problems.push(`${place.where} holds a fragment of the idea (${FRAGMENT} characters from character ${found})`);
    // The literal marker the idea carries: an echo too short for a fragment is still his words.
    else if (marker !== undefined && place.text.includes(marker)) problems.push(`${place.where} holds the literal marker ${marker}`);
  }
  return problems;
}

/** A ledger line as the smoke reads it. */
export interface MotionLedgerLine {
  type: string;
  attemptId: string;
}

const MOTION_ATTEMPT = /^.+:(motion|idea)#\d+$/;

/**
 * I5.68: a part C call reserves its attempt before it sends it and settles it when the answer comes: `<job>:motion#1` for a suggestion, `<job>:idea#1` for a translation. The ledger holds, in order, exactly the
 * calls the story made, each reserved once and settled; nothing is open. Empty when it is right; otherwise one line per fault.
 */
export function motionLedgerProblems(lines: readonly MotionLedgerLine[], expected: readonly ("motion" | "idea")[]): string[] {
  const mine = lines.filter((line) => MOTION_ATTEMPT.test(line.attemptId));
  const reserved = mine.filter((line) => line.type === "reserve");
  const problems: string[] = [];
  if (reserved.length !== expected.length) problems.push(`${expected.length} part C calls were expected, ${reserved.length} reserved`);
  reserved.forEach((line, i) => {
    const kind = MOTION_ATTEMPT.exec(line.attemptId)?.[1];
    const want = expected[i];
    if (want !== undefined && kind !== want) problems.push(`call ${i + 1} was "${String(kind)}", expected "${want}"`);
    if (!mine.some((other) => other.type === "settle" && other.attemptId === line.attemptId)) problems.push(`${line.attemptId} was reserved and never settled`);
  });
  return problems;
}

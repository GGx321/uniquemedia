import { posix, win32 } from "node:path";
import { STDERR_ERROR_TAIL } from "../../node/runFfmpeg";

// The error scrubber (tasks 3a.6 and 3a.8b.0). An ffmpeg error may reach the
// UI in `EngineError.detail`, and ffmpeg prints every path it was given. So
// the paths of the job's own files are replaced by labels that name no user
// folder: the temp root `<tmp>`, the export folder `<export>`, each input
// `<photo>` / `<overlay>` / `<audio>`, and the folder of an input `<dir>`.
//
// What is matched, for every registered path:
// - every spelling ffmpeg may print: as given, normalised the way the argv was
//   built (`path.join`/`normalize`), with `/`, `\`, mixed or doubled
//   separators, with a `\\?\` (or `\\?\UNC\`) prefix, which goes too, and in
//   either Unicode normalisation form;
// - in any letter case. Windows and default macOS volumes ignore case, so one
//   rule for all: it masks more and never less;
// - as a whole path only. A folder ends at a separator, the end of the text
//   or punctuation, never at a plain space or a name character, so `/a/Studio`
//   does not eat `/a/Studio Exports`. A file ends at whitespace too;
// - the longest path first, so a photo inside the export folder is `<photo>`.
//
// Only the matched path is rewritten. The rest of a masked FOLDER path
// (`<tmp>\job-1\clip.mkv`) reads with slashes; text glued on after a colon,
// a quote or a space keeps its own backslashes.

export interface ScrubInput {
  /** Absolute path of a file the job hands to ffmpeg. */
  readonly path: string;
  /** What replaces it: `<photo>`, `<overlay>`, `<audio>`. It must name no folder. */
  readonly label: string;
}

interface Target {
  readonly path: string;
  readonly label: string;
  /** A folder also matches the rest of the path below it; a file is matched whole. */
  readonly kind: "dir" | "file";
}

const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/g;
const escape = (text: string): string => text.replace(REGEX_SYNTAX, "\\$&");

/** `\\?\C:\x` and `//?/C:/x` name `C:\x`; `\\?\UNC\srv\share` names `\\srv\share`. */
const EXTENDED_PREFIX = /^[\\/]{2}\?[\\/](UNC[\\/])?/i;
function stripExtendedPrefix(path: string): string {
  const match = EXTENDED_PREFIX.exec(path);
  if (match === null) return path;
  return (match[1] === undefined ? "" : "\\\\") + path.slice(match[0].length);
}

/** A Windows path by its shape, whatever platform the engine runs on: the tests, and a log line read anywhere. */
const isWindowsShaped = (path: string): boolean => /^[A-Za-z]:(?:[\\/]|$)/.test(path) || /^[\\/]{2}/.test(path) || (path.includes("\\") && !path.startsWith("/"));

interface Spelling {
  readonly windows: boolean;
  readonly source: string;
  /** How many characters of names it holds: the sort key for "longest first". */
  readonly weight: number;
}

const WIN_SEP = "[\\\\/]+";
const PREFIX = "(?:[\\\\/]{2}\\?[\\\\/])?";
const UNC_LEAD = "(?:[\\\\/]{2}\\?[\\\\/]UNC[\\\\/]|[\\\\/]{2})";

function spellingOf(path: string): Spelling | undefined {
  const windows = isWindowsShaped(path);
  const separators = windows ? /[\\/]+/ : /\/+/;
  const segments = path.split(separators).filter((segment) => segment !== "");
  const drive = windows && /^[A-Za-z]:$/.test(segments[0] ?? "");
  // A bare root (`/`, `C:\`) would mask half the log.
  if (segments.length < (drive ? 2 : 1)) return undefined;
  let lead = "";
  if (windows) {
    if (drive) lead = PREFIX;
    else if (/^[\\/]{2}/.test(path)) lead = UNC_LEAD;
    else if (/^[\\/]/.test(path)) lead = "[\\\\/]+";
  } else if (path.startsWith("/")) lead = "/+";
  const source = lead + segments.map(escape).join(windows ? WIN_SEP : "/+");
  return { windows, source, weight: segments.reduce((sum, segment) => sum + segment.length, 0) };
}

/** Every text a path may be printed as: as given, normalised, and in both Unicode forms of each. */
function spellings(raw: string): Spelling[] {
  const stripped = stripExtendedPrefix(raw);
  const flavour = isWindowsShaped(stripped) ? win32 : posix;
  const bases = [stripped, flavour.normalize(stripped)];
  const texts = new Set(bases.flatMap((text) => [text, text.normalize("NFC"), text.normalize("NFD")]));
  const seen = new Set<string>();
  const out: Spelling[] = [];
  for (const text of texts) {
    const spelling = spellingOf(text);
    if (spelling === undefined || seen.has(spelling.source)) continue;
    seen.add(spelling.source);
    out.push(spelling);
  }
  return out;
}

function dirnameOf(path: string): string {
  const stripped = stripExtendedPrefix(path);
  return isWindowsShaped(stripped) ? win32.dirname(win32.normalize(stripped)) : posix.dirname(posix.normalize(stripped));
}

// After a folder: a separator, the end, punctuation, a line break, or a full stop that ends a sentence. Not a plain space.
const DIR_END = "(?=$|[\\\\/]|[:;,)\\]}\"'<>|\\r\\n\\t]|\\.(?:\\s|$))";
// After a file: the same, and whitespace.
const FILE_END = "(?=$|\\s|[\\\\/:;,)\\]}\"'<>|]|\\.(?:\\s|$))";
// What belongs to a path below a masked folder.
const BELOW = "((?:[\\\\/]+[^\\\\/\\s\"'<>|:*?]+)*)";

/**
 * Builds the function that masks `tmpRoot`, `exportDir` and every input path,
 * and the folder of every input, in text that may reach the UI.
 */
export function scrubber(tmpRoot: string, exportDir: string, inputs: readonly ScrubInput[] = []): (text: string) => string {
  const targets: Target[] = [
    { path: tmpRoot, label: "<tmp>", kind: "dir" },
    { path: exportDir, label: "<export>", kind: "dir" },
    ...inputs.flatMap((input): Target[] => [
      { path: input.path, label: input.label, kind: "file" },
      { path: dirnameOf(input.path), label: "<dir>", kind: "dir" },
    ]),
  ];

  interface Alternative {
    readonly source: string;
    readonly weight: number;
    readonly label: string;
  }
  const alternatives: Alternative[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (target.path === "") continue;
    for (const spelling of spellings(target.path)) {
      const source = target.kind === "dir" ? `(${spelling.source})${DIR_END}${BELOW}` : `(${spelling.source})${FILE_END}()`;
      // The same text under two targets keeps the first (the more specific: registered before the folders).
      if (seen.has(source)) continue;
      seen.add(source);
      alternatives.push({ source, weight: spelling.weight, label: target.label });
    }
  }
  if (alternatives.length === 0) return (text) => text;
  // Stable sort: on equal length the earlier target stays first. Longest first, since the leftmost alternative that fits wins.
  alternatives.sort((a, b) => b.weight - a.weight);
  const pattern = new RegExp(alternatives.map((a) => `(?:${a.source})`).join("|"), "giu");

  return (text) =>
    text.replace(pattern, (...args: unknown[]) => {
      for (let i = 0; i < alternatives.length; i++) {
        const below = args[2 + i * 2];
        if (args[1 + i * 2] === undefined) continue;
        return (alternatives[i]?.label ?? "") + (typeof below === "string" ? below.replace(/[\\/]+/g, "/") : "");
      }
      return "";
    });
}

/**
 * Scrubs the tail of ffmpeg's stderr. The tail is cut at a fixed length before
 * it gets here, so it may begin inside a path, and a fragment of a path is
 * not something the scrubber can recognise. A tail that reached the limit
 * therefore loses its first, partial line (ffmpeg's messages are line by line,
 * and a path is on one line) before the rest is scrubbed. A tail that is one
 * unbroken line loses everything: its message is still in `FfmpegError.message`.
 */
export function scrubStderrTail(scrub: (text: string) => string, tail: string): string {
  if (tail.length < STDERR_ERROR_TAIL) return scrub(tail);
  const lineBreak = tail.search(/[\r\n]/);
  return lineBreak === -1 ? "" : scrub(tail.slice(lineBreak + 1));
}

import { describe, expect, test } from "bun:test";
import { maskHome, scrubber, scrubStderrTail } from "./scrubber";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// The error scrubber: what may reach the UI from an ffmpeg error must hold no
// folder or file name of the user's. Examples first, then a seeded property
// run over random paths in realistic ffmpeg lines.

const TMP = "C:\\Users\\mia\\AppData\\Local\\Temp\\render-tmp";
const EXPORT = "D:\\Videos\\Reels";

describe("scrubber: input paths", () => {
  const scrub = scrubber("/tmp/render-tmp", "/a/Studio", [
    { path: "/Users/mia/Pictures/Mia Photos/beach.jpg", label: "<photo>" },
    { path: "/Users/mia/Stickers/star.png", label: "<overlay>" },
    { path: "/Users/mia/Music/song.mp3", label: "<audio>" },
  ]);

  test("a library photo's path becomes <photo>, with no user folder left", () => {
    expect(scrub("Error opening input file /Users/mia/Pictures/Mia Photos/beach.jpg: No such file or directory")).toBe("Error opening input file <photo>: No such file or directory");
  });

  test("an overlay's path becomes <overlay> and an audio path <audio>", () => {
    expect(scrub("open /Users/mia/Stickers/star.png then /Users/mia/Music/song.mp3.")).toBe("open <overlay> then <audio>.");
  });

  test("the folder of an input is masked too when ffmpeg names only the folder", () => {
    expect(scrub("/Users/mia/Pictures/Mia Photos: Is a directory")).toBe("<dir>: Is a directory");
  });

  test("text that names none of the paths is unchanged", () => {
    expect(scrub("Invalid data found when processing input")).toBe("Invalid data found when processing input");
  });
});

describe("scrubber: spellings of one path", () => {
  const photo = { path: "C:/Users//mia/./Pictures/../Pictures/a b.jpg", label: "<photo>" };
  const scrub = scrubber(TMP, EXPORT, [photo]);

  test.each([
    ["the argv's normalised spelling", "C:\\Users\\mia\\Pictures\\a b.jpg"],
    ["forward slashes", "C:/Users/mia/Pictures/a b.jpg"],
    ["mixed slashes", "C:\\Users/mia\\Pictures/a b.jpg"],
    ["doubled backslashes", "C:\\\\Users\\\\mia\\\\Pictures\\\\a b.jpg"],
    ["the path as it was given", "C:/Users//mia/./Pictures/../Pictures/a b.jpg"],
    ["another letter case", "c:\\USERS\\Mia\\pictures\\A B.JPG"],
    ["a \\\\?\\ prefix (the prefix goes too)", "\\\\?\\C:\\Users\\mia\\Pictures\\a b.jpg"],
    ["a //?/ prefix", "//?/C:/Users/mia/Pictures/a b.jpg"],
  ])("masks %s", (_name, spelled) => {
    expect(scrub(`Error opening input file ${spelled}: No such file`)).toBe("Error opening input file <photo>: No such file");
  });

  test("masks a UNC path, with or without the \\\\?\\UNC\\ prefix", () => {
    const unc = scrubber(TMP, EXPORT, [{ path: "\\\\nas\\photos\\Mia\\x.jpg", label: "<photo>" }]);
    expect(unc("a \\\\nas\\photos\\Mia\\x.jpg b")).toBe("a <photo> b");
    expect(unc("a \\\\?\\UNC\\nas\\photos\\Mia\\x.jpg b")).toBe("a <photo> b");
  });

  test("masks a Cyrillic path spelled in the other Unicode normalisation form and the other case", () => {
    const cyr = scrubber(TMP, EXPORT, [{ path: "/Users/мия/Фото Й/кот.jpg", label: "<photo>" }]);
    const nfd = "/Users/мия/Фото Й/кот.jpg".normalize("NFD").toUpperCase();
    expect(cyr(`Error opening ${nfd}.`)).toBe("Error opening <photo>.");
  });

  test("the temp root and the export folder are masked in any case and spelling", () => {
    expect(scrub("c:/users/MIA/appdata/local/temp/render-tmp/job-1/clip-00.mkv")).toBe("<tmp>/job-1/clip-00.mkv");
    expect(scrub("\\\\?\\D:\\Videos\\Reels\\.studio-part-job-1.mp4")).toBe("<export>/.studio-part-job-1.mp4");
  });
});

describe("scrubber: where a path ends", () => {
  test("a folder is not matched inside a longer folder name: /a/Studio leaves /a/Studio Exports alone", () => {
    const scrub = scrubber("/tmp/render-tmp", "/a/Studio");
    expect(scrub("write /a/Studio Exports/x.mp4 failed")).toBe("write /a/Studio Exports/x.mp4 failed");
    expect(scrub("write /a/StudioExports/x.mp4 failed")).toBe("write /a/StudioExports/x.mp4 failed");
    expect(scrub("write /a/Studio.old/x.mp4 failed")).toBe("write /a/Studio.old/x.mp4 failed");
  });

  test("a folder is matched at a separator, at the end of the text and before punctuation", () => {
    const scrub = scrubber("/tmp/render-tmp", "/a/Studio");
    expect(scrub("write /a/Studio/x.mp4")).toBe("write <export>/x.mp4");
    expect(scrub("cwd /a/Studio")).toBe("cwd <export>");
    expect(scrub("/a/Studio: Permission denied")).toBe("<export>: Permission denied");
    expect(scrub("into '/a/Studio'.")).toBe("into '<export>'.");
    expect(scrub("into /a/Studio.")).toBe("into <export>.");
  });

  test("the longest registered path wins: a photo inside the export folder is <photo>, not <dir> or <export>", () => {
    const scrub = scrubber("/tmp/render-tmp", "/a/Studio", [{ path: "/a/Studio/lib/x.jpg", label: "<photo>" }]);
    expect(scrub("open /a/Studio/lib/x.jpg and /a/Studio/lib/y.jpg")).toBe("open <photo> and <dir>/y.jpg");
  });

  test("a file input is not matched as the prefix of a longer file name", () => {
    const scrub = scrubber("/tmp/render-tmp", "/a/Studio", [{ path: "/p/a.jpg", label: "<photo>" }]);
    expect(scrub("open /p/a.jpg.bak")).not.toContain("<photo>");
  });
});

describe("scrubber: the user's home", () => {
  const HOME = "/Users/Mia Secret";

  test("anything under the home becomes ~/..., whatever it is", () => {
    const scrub = scrubber("/tmp/render-tmp", "/a/Studio", [], HOME);
    expect(scrub("spawn /Users/Mia Secret/AppData/Programs/studio/ffmpeg ENOENT")).toBe("spawn ~/AppData/Programs/studio/ffmpeg ENOENT");
  });

  test("the specific labels win over the home: a photo, the export folder and the temp root keep theirs", () => {
    const scrub = scrubber(`${HOME}/tmp`, `${HOME}/Reels`, [{ path: `${HOME}/Pictures/a.jpg`, label: "<photo>" }], HOME);
    expect(scrub(`${HOME}/Pictures/a.jpg ${HOME}/Reels/x.mp4 ${HOME}/tmp/job-1/c.mkv ${HOME}/Other/y`)).toBe("<photo> <export>/x.mp4 <tmp>/job-1/c.mkv ~/Other/y");
  });

  test("a Windows home is masked in any spelling and case", () => {
    const scrub = scrubber("C:\\t", "C:\\e", [], "C:\\Users\\Mia");
    expect(scrub("open c:/users/MIA/AppData/x.exe.")).toBe("open ~/AppData/x.exe.");
  });

  test("maskHome masks a raw message with the home it is given", () => {
    expect(maskHome("ENOENT: open '/Users/Mia Secret/Reels/x.mp4'", HOME)).toBe("ENOENT: open '~/Reels/x.mp4'");
  });

  test("a home that is only a root masks nothing", () => {
    expect(maskHome("open /etc/hosts", "/")).toBe("open /etc/hosts");
  });
});

describe("scrubber: characters that are regex syntax", () => {
  const path = "/Users/mia/Photos (1)/[old] a+b/$x.{2}/a|b^c*d?.jpg";
  const scrub = scrubber("/tmp/render-tmp", "/a/Studio", [{ path, label: "<photo>" }], "/nowhere");

  test("a path made of them is masked as a whole", () => {
    expect(scrub(`Error opening ${path}: no`)).toBe("Error opening <photo>: no");
  });

  test("they are literal: a dot is not any character, a plus is not a repeat, a bracket is not a class", () => {
    const one = scrubber("/tmp/render-tmp", "/a/b.c", [{ path: "/p/x+y/[z]/f.jpg", label: "<photo>" }], "/nowhere");
    expect(one("/a/bXc/f /p/xxy/z/f.jpg /p/x+y/[z]/f.jpgg")).toBe("/a/bXc/f /p/xxy/z/f.jpg <dir>/f.jpgg");
    expect(one("/a/b.c/f /p/x+y/[z]/f.jpg")).toBe("<export>/f <photo>");
  });
});

describe("scrubber: Unicode forms and speed", () => {
  test("a path whose segments are in different Unicode forms is masked (the text is normalised before matching)", () => {
    const scrub = scrubber("/tmp/t", "/e", [{ path: "/Users/мой/Й/кот.jpg", label: "<photo>" }], "/nowhere");
    const mixed = "/Users/" + "мой".normalize("NFD") + "/" + "Й".normalize("NFC") + "/" + "кот".normalize("NFD") + ".jpg";
    expect(scrub(`open ${mixed}.`)).toBe("open <photo>.");
  });

  test("a long run of separators with many registered inputs is scrubbed in linear time", () => {
    const inputs = Array.from({ length: 200 }, (_, i) => ({ path: `/Users/mia/Pictures/album-${i}/photo-${i}.jpg`, label: "<photo>" }));
    const scrub = scrubber("/tmp/render-tmp", "/a/Studio", inputs, "/Users/mia");
    for (const line of [`${"/".repeat(2000)} x`, `C:${"\\".repeat(1000)}`, `${"/a".repeat(1000)}`]) {
      const started = performance.now();
      scrub(line);
      expect(performance.now() - started).toBeLessThan(100);
    }
  });
});

describe("scrubber: only the path part is rewritten", () => {
  const scrub = scrubber(TMP, EXPORT);

  test("the rest of a masked folder path reads with slashes", () => {
    expect(scrub("C:\\Users\\mia\\AppData\\Local\\Temp\\render-tmp\\job-1\\clip-00.mkv: no")).toBe("<tmp>/job-1/clip-00.mkv: no");
  });

  test("text glued to a path after a colon keeps its backslashes", () => {
    expect(scrub("C:\\Users\\mia\\AppData\\Local\\Temp\\render-tmp\\a.mkv:C:\\other\\thing")).toBe("<tmp>/a.mkv:C:\\other\\thing");
  });

  test("a masked file path's neighbours keep their backslashes", () => {
    const one = scrubber(TMP, EXPORT, [{ path: "C:\\Users\\mia\\a.jpg", label: "<photo>" }]);
    expect(one("C:\\Users\\mia\\a.jpg and x\\y")).toBe("<photo> and x\\y");
  });

  test("a folder name glued on without a separator is not touched", () => {
    expect(scrub("C:\\Users\\mia\\AppData\\Local\\Temp\\render-tmpX\\a")).toBe("C:\\Users\\mia\\AppData\\Local\\Temp\\render-tmpX\\a");
  });
});

describe("scrubStderrTail: the cut at the 2000-character tail", () => {
  const photo = "/Users/mia/Pictures/Mia Photos/beach.jpg";
  const scrub = scrubber("/tmp/render-tmp", "/a/Studio", [{ path: photo, label: "<photo>" }]);

  test("a path split by the cut leaves no fragment: the partial first line goes", () => {
    // The tail starts in the middle of the folder name, as runFfmpeg's 2000-character slice can leave it.
    const head = `${photo.slice(15)}: No such file\n`;
    const tail = `${head}${"n".repeat(2000 - head.length - 1)}\n`;
    expect(tail).toHaveLength(2000);

    const out = scrubStderrTail(scrub, tail);

    expect(out).not.toContain("ures");
    expect(out).not.toContain("Mia Photos");
    expect(out).not.toContain("beach");
  });

  test("a tail that was not cut keeps its first line", () => {
    expect(scrubStderrTail(scrub, `Error opening ${photo}\nConversion failed!\n`)).toBe("Error opening <photo>\nConversion failed!\n");
  });
});

// ---- property run ----------------------------------------------------------

/** A small seeded PRNG: a failing run repeats. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASES = ["Photos (1)", "[old] a+b", "$x.{2}", "Mia", "Мия", "Фото", "Мои Фотографии", "O'Brien", "my pics", "Ёлка", "Йод и Ёж", 'say "hi"', "a b  c", "日本語"];
const TAG_LETTERS = "QXZJKW";

interface Sample {
  readonly given: string;
  readonly text: string;
  readonly secrets: readonly string[];
  readonly folderOnly: string;
}

function makeSample(rand: () => number): Sample {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const tag = (): string => `${pick([...TAG_LETTERS])}${pick([...TAG_LETTERS])}${Math.floor(rand() * 900 + 100)}`;
  const windows = rand() < 0.5;
  const segment = (): { name: string; tag: string } => {
    const t = tag();
    let base = pick(BASES);
    // Windows forbids a double quote in a name.
    if (windows) base = base.replaceAll('"', "");
    return { name: `${base} ${t}`, tag: t };
  };
  const user = segment();
  const album = segment();
  const file = segment();
  const parts = windows ? ["C:", "Users", user.name, "Pictures", album.name, `${file.name}.jpg`] : ["", "Users", user.name, "Pictures", album.name, `${file.name}.jpg`];
  const secrets = [user, album, file].flatMap((s) => [s.name, s.tag]);

  const render = (sep: () => string, prefix: string): string => prefix + parts.map((p, i) => (i === 0 ? p : sep() + p)).join("");
  let text: string;
  let given: string;
  if (windows) {
    const style = pick(["back", "fwd", "mixed", "doubled"] as const);
    const sep = (): string => (style === "back" ? "\\" : style === "fwd" ? "/" : style === "doubled" ? "\\\\" : rand() < 0.5 ? "\\" : "/");
    text = render(sep, rand() < 0.3 ? "\\\\?\\" : "");
    // The given path is sometimes untidy: a doubled separator and a `.` segment, as `join` would have tidied.
    given = rand() < 0.5 ? parts.join("\\") : parts.join("/").replace("/Users/", "/Users//./");
  } else {
    text = render(() => "/", "");
    given = rand() < 0.5 ? parts.join("/") : parts.join("/").replace("/Users/", "/Users//./");
  }
  const caseMode = pick(["same", "upper", "lower", "nfd"] as const);
  if (caseMode === "upper") text = text.toUpperCase();
  else if (caseMode === "lower") text = text.toLowerCase();
  else if (caseMode === "nfd") text = text.normalize("NFD");

  const folder = windows ? parts.slice(0, -1).join("\\") : parts.slice(0, -1).join("/");
  const folderText = caseMode === "same" ? folder : caseMode === "upper" ? folder.toUpperCase() : caseMode === "lower" ? folder.toLowerCase() : folder.normalize("NFD");
  return { given, text, secrets, folderOnly: folderText };
}

const LINE_TEMPLATES: readonly ((p: string) => string)[] = [
  (p) => `Error opening input file ${p}.`,
  (p) => `[image2 @ 0x600003a1c000] Could not open file : ${p}`,
  (p) => `${p}: No such file or directory`,
  (p) => `[AVIOContext @ 0x6000] Error opening '${p}': Permission denied`,
  (p) => `[mjpeg @ 0x1400] Invalid data found when processing input (${p})`,
  (p) => `Input #0, image2, from '${p}':`,
];
const NOISE = [
  "frame=  120 fps= 30 q=28.0 size=    512kB time=00:00:04.00 bitrate=1048.6kbits/s speed=1.2x",
  "[libx264 @ 0x1234] using cpu capabilities: ARMv8 NEON",
  "  Stream #0:0: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 1080x1920, 25 tbr, 25 tbn",
  "Press [q] to stop, [?] for help",
];

describe("scrubber: property run over random paths in ffmpeg lines", () => {
  const RUNS = 400;

  test(`no fragment of a registered path survives in ${RUNS} random tails, cut or not`, () => {
    const rand = mulberry32(20260929);
    let cutRuns = 0;
    for (let i = 0; i < RUNS; i++) {
      const s = makeSample(rand);
      const scrub = scrubber("C:\\Users\\zz\\Temp\\render-tmp", "D:\\Videos\\Reels", [{ path: s.given, label: "<photo>" }]);
      const template = LINE_TEMPLATES[Math.floor(rand() * LINE_TEMPLATES.length)] as (p: string) => string;
      const useFolder = rand() < 0.2;
      const line = useFolder ? `${s.folderOnly}: Is a directory` : template(s.text);
      const before = Array.from({ length: Math.floor(rand() * 40) }, () => NOISE[Math.floor(rand() * NOISE.length)] as string).join("\n");
      const after = Array.from({ length: Math.floor(rand() * 4) }, () => NOISE[Math.floor(rand() * NOISE.length)] as string).join("\n");
      const full = `${before}\n${line}\n${after}\nConversion failed!\n`;
      const tail = full.slice(-2000); // what runFfmpeg hands over
      if (full.length > 2000) cutRuns++;

      const out = scrubStderrTail(scrub, tail).normalize("NFC").toLowerCase();

      for (const secret of s.secrets) {
        const needle = secret.normalize("NFC").toLowerCase();
        if (out.includes(needle)) throw new Error(`run ${i}: "${secret}" survived in:\n${out}\n--- input line: ${line}\n--- given: ${s.given}`);
      }
      if (full.length <= 2000 && !useFolder && !out.includes("<photo>")) throw new Error(`run ${i}: the path was not masked in:\n${out}`);
    }
    // The property means little if no run was ever cut.
    expect(cutRuns).toBeGreaterThan(RUNS / 10);
  });
});

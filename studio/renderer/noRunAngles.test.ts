import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// S5.7c (plan s5a2 §6.4: «no «Ракурсы» left (static test)»): the run's «Ракурсы» are gone — the angle comes from the scene (I5.26). A static guard over the
// renderer's sources (tests and the mock engine's files left out): no «Ракурсы» control, line or reference anywhere a run is set up or shown — the generate card, the
// scene set's strip, «Автопилот» and its history — no poses sent from a form, and none of their CSS. What stays, and is allowed by name below, is a custom
// category's OWN angles in «Мои категории» (owner, Q-H; mockup 35): its section is still labelled «Ракурсы». The screen tests check the same on the DOM
// (PhotosLevel, PhotosSceneLevel, AutopilotLevel). Comments are taken out first: they may tell the history.

const RENDERER = join(import.meta.dir);

/** The files where «Ракурсы» may still be a label: the custom category's own angles (the sheet, and the create dialog's «готово» row). */
const OWN_ANGLES_FILES = new Set(["screens/photos/CategorySheet.tsx", "screens/photos/categoryParts.tsx"]);

/** The form and request modules that must not hold or send poses any more. */
const FORM_FILES = new Set(["screens/photos/runForm.ts", "screens/autopilot/launchForm.ts", "screens/autopilot/useLaunchPlan.ts", "screens/photos/GenerateCard.tsx", "screens/autopilot/SettingsColumn.tsx"]);

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"`])\/\/.*$/gm, "$1");
}

/** What of the run's «Ракурсы» `source` (at `file`, relative to the renderer) still holds. */
export function runAngles(file: string, source: string): string[] {
  const code = withoutComments(source);
  const found: string[] = [];
  // A reference to the card's control: «Ракурсы» карточки, «Ракурсов» карточки…
  for (const match of code.matchAll(/«Ракурс[а-яё]*»/g)) found.push(match[0]);
  // The strip's and the history's old lines: «Ракурсы: анфас, три четверти», «анфас и три четверти — всегда».
  for (const match of code.matchAll(/Ракурсы:|анфас и три четверти — всегда|профиль и со спины — (только если разрешите|без проверки сходства)/g)) found.push(match[0]);
  // «Ракурсы» as a label, outside a custom category's own angles.
  if (!OWN_ANGLES_FILES.has(file)) for (const match of code.matchAll(/(?<![«а-яё])Ракурсы(?![а-яё])/g)) found.push(match[0]);
  // A form that still holds or sends the toggles (a custom category's own `pool.poses` is not one).
  if (FORM_FILES.has(file)) for (const match of code.matchAll(/\b(?:form|request|composeRequest|settings)\.poses\b|\bposes:\s*\{\s*profile/g)) found.push(match[0]);
  // Their CSS.
  for (const match of code.matchAll(/\.(photos-angles[\w-]*|ap-angles|photos-chip-fixed)\b/g)) found.push(match[0]);
  return found;
}

async function sources(): Promise<{ file: string; text: string }[]> {
  // The glob answers with the platform's separator; the lists name files with "/", so a Windows path is normalised first.
  const files = Array.from(new Bun.Glob("**/*.{ts,tsx,css}").scanSync({ cwd: RENDERER }))
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !/\.test\.tsx?$/.test(f) && !/(^|\/)engine\/mock[^/]*$/.test(f) && !/[Kk]it\.tsx?$/.test(f) && !f.endsWith("testing.tsx"));
  return Promise.all(files.sort().map(async (file) => ({ file, text: await Bun.file(join(RENDERER, file)).text() })));
}

describe("the detector", () => {
  test("sees the card's old «Ракурсы» block: the label, the toggles in the form, the hint", () => {
    const card = `<span id={anglesLabel} className="lbl">Ракурсы</span>
      {(["profile", "back"] as const).map((pose) => { const on = form.poses[pose]; })}
      <span className="faint photos-note photos-angles-hint">профиль и со спины — только если разрешите, без проверки сходства</span>`;
    expect(runAngles("screens/photos/GenerateCard.tsx", card)).toEqual(["профиль и со спины — только если разрешите", "Ракурсы", "form.poses"]);
  });

  test("sees the strip's line, a reference to the card's control and the CSS", () => {
    expect(runAngles("screens/photos/sceneText.ts", "lead: `Ракурсы: ${posesText(poses)}`")).toEqual(["Ракурсы:", "Ракурсы"]);
    expect(runAngles("screens/photos/categoryText.ts", "«Ракурсы» карточки их не касаются; из «Ракурсов» карточки")).toEqual(["«Ракурсы»", "«Ракурсов»"]);
    expect(runAngles("ui.css", ".photos-angles-own { margin: 0; }\n.ap-angles .x {}")).toEqual([".photos-angles-own", ".ap-angles"]);
  });

  test("lets a custom category's own angles keep their label, and comments tell the history", () => {
    expect(runAngles("screens/photos/CategorySheet.tsx", '<span className="lbl">Ракурсы</span>')).toEqual([]);
    expect(runAngles("screens/photos/GenerateCard.tsx", "// S5.7c: «Подача» where «Ракурсы» was\n/* the old «Ракурсы» */ const level = 1;")).toEqual([]);
    // The scene's own angle tag and the new note are not the run's «Ракурсы».
    expect(runAngles("screens/photos/SceneCard.tsx", "ракурс: со спины; Ракурс берётся из сцены; Ракурс — из сцены; свои ракурсы")).toEqual([]);
  });
});

describe("the renderer", () => {
  test("holds none of the run's «Ракурсы»", async () => {
    const found = (await sources()).flatMap(({ file, text }) => runAngles(file, text).map((hit) => `${file}: ${hit}`));
    expect(found).toEqual([]);
  });

  test("still shows a custom category's own angles where the owner sets them (Q-H)", async () => {
    const sheet = await Bun.file(join(RENDERER, "screens/photos/CategorySheet.tsx")).text();
    expect(withoutComments(sheet)).toMatch(/>\s*Ракурсы\s*</);
  });
});

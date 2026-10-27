import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA5, plan s5a4 §5.1.4, I5.73, I5.74; BA3 review L-3): the sites test. «Смелая» has ONE marker (the route), one predicate (`isBoldFrame`), one lookup (`bankPlaceOf` /
// `poolOfSlot`) and one origin door (`planForAvatar`), so the old shortcuts may live only where the plan names them:
// - `isBoldCategory` (a «Смелая» CATEGORY, not a frame) in the named allow-list below, each file with its exact count and why;
// - a direct index into the pools and banks (`POOLS[…]`, `BANKS[…]` and their «Смелая» registries) in the modules that own them;
// - every engine plan through `planForAvatar`, every redraw with the avatar's `impliedNudity`;
// - every call that writes a «Смелая» sentence with the avatar's origin, read by the engine at the named paths (`studioCreated`).
// Production source only (no tests, test kits or `testing/` folders). An entry marked `until` belongs to a later task of 5a.4, which removes it when it moves the site to the marker.

const STUDIO = resolve(import.meta.dir, "../..");
const SOURCE = /\.[cm]?[jt]sx?$/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path);
    return [path];
  });
}

/** Studio's production source, by its path from `studio/` with `/` separators (the same on Windows). */
const FILES: { file: string; source: ts.SourceFile }[] = walk(STUDIO)
  .filter((path) => SOURCE.test(path) && !path.endsWith(".d.ts") && !/\.(test|testkit)\.[cm]?[jt]sx?$/.test(path) && !/[\\/]testing[\\/]/.test(path))
  .map((path) => {
    const file = relative(STUDIO, path).split(/[\\/]/).join("/");
    return { file, source: ts.createSourceFile(file, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS) };
  });

function nodesOf(source: ts.SourceFile, keep: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (keep(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Each file's count of what `keep` finds, the files with none left out. */
function countsOf(keep: (node: ts.Node) => boolean): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { file, source } of FILES) {
    const n = nodesOf(source, keep).length;
    if (n > 0) counts[file] = n;
  }
  return counts;
}

/** A use of `name`: a reference to it, not its declaration, an import or an export of it. */
function isUseOf(name: string): (node: ts.Node) => boolean {
  return (node) => {
    if (!ts.isIdentifier(node) || node.text !== name) return false;
    const parent = node.parent;
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)) return false;
    if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
    return true;
  };
}

interface Allowed {
  file: string;
  count: number;
  why: string;
  /** The 5a.4 task that moves this site to the marker (and removes the entry). */
  until?: string;
}

/** The named allow-list of `isBoldCategory` (plan s5a4 §5.1.4). */
const BOLD_CATEGORY_SITES: Allowed[] = [
  { file: "shared/engine/categories.ts", count: 2, why: "`isBoldFrame` itself, and the `bold-level-needed` refusal (`boldLevelNeeded`)" },
  { file: "engine/scenes/pools.ts", count: 1, why: "pool validation: the two «Смелая» categories' pools are held to their own schema" },
  { file: "shared/scenes/banks/index.ts", count: 1, why: "bank validation: the two «Смелая» categories' banks are held to the bold rules" },
  { file: "renderer/screens/photos/CategoryRow.tsx", count: 1, why: "the chip gating: the two «Смелая» chips are shown only at «Смелая»" },
  { file: "renderer/screens/photos/runForm.ts", count: 1, why: "the chip gating: `categoriesAt` drops the two «Смелая» categories below «Смелая»" },
  { file: "renderer/screens/autopilot/SettingsColumn.tsx", count: 2, why: "the chip gating (:157), kept; the option-B line (:84) leaves with S5.BA8 (`optionB = boldOn`), which brings the count to 1", until: "S5.BA8" },
  { file: "renderer/screens/photos/level.ts", count: 2, why: "the caption's category words (`BOLD_WORD`, :52) and `launchLevelCaption` (:161, S5.BA8 counts every category)", until: "S5.BA8" },
  { file: "renderer/engine/mockBoldRoute.ts", count: 2, why: "the mock's price rule (`isBoldLook`, `requestBoldPhotos`), mirrored by S5.BA7", until: "S5.BA7" },
  { file: "renderer/engine/mockSceneSets.ts", count: 1, why: "the mock's five-at-«Смелая» relabel stub (:328), S5.BA7", until: "S5.BA7" },
];

/** The pools and the banks, and their «Смелая» registries: indexed only where a slot's pool or bank place is decided. */
const REGISTRIES = new Set(["POOLS", "BANKS", "BOLD_POOLS", "CUSTOM_BOLD_POOLS", "BOLD_COMPANIONS", "CUSTOM_BOLD_BANKS"]);
const INDEX_SITES: Allowed[] = [
  { file: "engine/scenes/poolAt.ts", count: 4, why: "`poolAt` and `poolOfSlot`: the pool a new or a stored slot is drawn from" },
  { file: "shared/scenes/bankLookup.ts", count: 2, why: "`bankPlaceOf`: a slot's bank place and moment" },
  { file: "shared/scenes/banks/companions/index.ts", count: 1, why: "the companions' registry checks its banks against the shipped ones" },
  { file: "renderer/engine/mockBankScenes.ts", count: 2, why: "the mock's bank lookups (:46, :106), moved to the marker by S5.BA7", until: "S5.BA7" },
];

/**
 * The calls that write a sentence a «Смелая» frame may end with a coverage in (the template, the plain sentence, a writer chunk's template side, the coverage itself). Each names
 * the avatar's origin (`impliedNudity`), except the named sites that only COUNT what the template can write, whose answer is the same whatever the origin. `roomPlaceOf` and
 * `slotLookOf` are not here: the room phrase, the lamp and the mirror-back line are a place's and a moment's, never the origin's.
 */
const RENDERERS = new Set(["templateSentence", "plainSentence", "localSentences", "setLocal", "localOf", "slotCoverageOf", "coverageOfWorn", "coverageOf", "plannedWriterConfig", "boldReader"]);
/** A render call that names the origin only to say false (`impliedNudity: false`): on a production path that is an origin dropped, unless the site only counts (the allow-list). */
const FALSE_ORIGIN = /\bimpliedNudity\s*[:=]\s*false\b/;
const COUNTING_SITES: Allowed[] = [
  { file: "engine/runs/remaining.ts", count: 1, why: "a resume counts the slots the template cannot write (the writer's chunks still to ask, their mode)" },
  { file: "engine/sceneSets/reviewPlan.ts", count: 1, why: "the m1 probe: whether the template can write a rewrite's scenes at all" },
  { file: "engine/sceneSets/chunks.ts", count: 1, why: "`pendingChunks`: which chunks of a set the template writes whole (`setLocal(set, 0, false)`)" },
  { file: "engine/sceneSets/estimate.ts", count: 1, why: "«Дописать»'s price: each chunk's scenes for the model and their mode (`setLocal(set, 0, false)`)" },
  { file: "engine/sceneSets/reviewWriteJob.ts", count: 2, why: "a rewrite's price: `modelScenesOf` and `writeModeOf` (`localOf(…, false)`); the job's own call names the origin" },
  { file: "renderer/engine/mockBankScenes.ts", count: 2, why: "the mock's template and plain sentences, given the origin by S5.BA7", until: "S5.BA7" },
];
/** Where the engine reads the avatar's origin (`studioCreated`): every path that plans, redraws or writes a «Смелая» frame, and the summary. A new path is named here. */
const ORIGIN_SOURCES: Allowed[] = [
  { file: "engine/engine.ts", count: 2, why: "a run's plan (`planForAvatar`) and its job's sentences (`impliedNudityOf`)" },
  { file: "engine/sceneSets/service.ts", count: 4, why: "a compose's plan, «Другая сцена», and the two write jobs' sentences" },
  { file: "engine/avatars/records.ts", count: 1, why: "`AvatarSummary.origin`" },
];

function expected(list: readonly Allowed[]): Record<string, number> {
  return Object.fromEntries(list.filter((a) => a.count > 0).map((a) => [a.file, a.count]));
}

describe("the «Смелая» sites (plan s5a4 §5.1.4)", () => {
  test("the scan reads the production source (it is not vacuous)", () => {
    expect(FILES.length).toBeGreaterThan(300);
    expect(FILES.some((f) => f.file === "engine/scenes/planner.ts")).toBe(true);
  });

  test("isBoldCategory is used only at the named sites, each as many times as the allow-list says", () => {
    expect(countsOf(isUseOf("isBoldCategory"))).toEqual(expected(BOLD_CATEGORY_SITES));
  });

  test("the pools and the banks are indexed directly only by the modules that own the lookup", () => {
    const indexes = countsOf((node) => ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && REGISTRIES.has(node.expression.text));
    expect(indexes).toEqual(expected(INDEX_SITES));
  });

  test("every engine plan goes through planForAvatar: planWithPools is called by the planner alone", () => {
    const calls = countsOf((node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "planWithPools");
    // `plan` (no origin: the planner's default, false) and `planForAvatar` (the required flag) are the two wrappers; nothing else calls it.
    expect(calls).toEqual({ "engine/scenes/planner.ts": 2 });
  });

  test("every redraw names the avatar's origin", () => {
    const redraws = FILES.flatMap(({ file, source }) =>
      nodesOf(source, (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "redrawSlot").map((node) => ({ file, text: node.getText() })),
    );
    expect(redraws.length).toBeGreaterThan(0);
    expect(redraws.filter((r) => !/\bimpliedNudity\b/.test(r.text))).toEqual([]);
  });

  test("every call that writes a «Смелая» sentence names the avatar's origin, never a literal false, but for the named counting sites", () => {
    const silent = countsOf(
      (node) =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        RENDERERS.has(node.expression.text) &&
        !ts.isFunctionDeclaration(node.parent) &&
        (!/\bimpliedNudity\b/.test(node.getText()) || FALSE_ORIGIN.test(node.getText())),
    );
    expect(silent).toEqual(expected(COUNTING_SITES));
  });

  test("the rule sees a literal false and a missing origin (it is not vacuous)", () => {
    const flagged = (code: string): number =>
      nodesOf(ts.createSourceFile("probe.ts", code, ts.ScriptTarget.Latest, true), (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && RENDERERS.has(node.expression.text)).filter(
        (node) => !/\bimpliedNudity\b/.test(node.getText()) || FALSE_ORIGIN.test(node.getText()),
      ).length;
    expect(flagged("localSentences({ slots, keyOf, impliedNudity: false });")).toBe(1);
    expect(flagged("plannedWriterConfig(labelOf, false);")).toBe(1);
    expect(flagged("boldReader();")).toBe(1);
    expect(flagged("localSentences({ slots, keyOf, impliedNudity });")).toBe(0);
    expect(flagged("plannedWriterConfig(labelOf, deps.impliedNudity === true);")).toBe(0);
  });

  test("the engine reads the avatar's origin (studioCreated) only at the named paths", () => {
    const reads = countsOf((node) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "studioCreated");
    expect(reads).toEqual(expected(ORIGIN_SOURCES));
  });

  test("an allow-list entry that waits for a later task names it", () => {
    const all = [...BOLD_CATEGORY_SITES, ...INDEX_SITES, ...COUNTING_SITES, ...ORIGIN_SOURCES];
    for (const entry of all) expect({ file: entry.file, why: entry.why.length > 10 }).toEqual({ file: entry.file, why: true });
    const waiting = all.filter((e) => e.until !== undefined).map((e) => e.until);
    expect(waiting).toEqual(expect.arrayContaining(["S5.BA7", "S5.BA8"]));
    // S5.BA6 moved the clip facts, the clip tab and the mock's clip facts to `isBoldFrame`: nothing waits for it any more.
    expect(waiting).not.toContain("S5.BA6");
  });
});

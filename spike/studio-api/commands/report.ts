import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CONFIG_IDS, P, RENDER_CONFIGS, type ConfigId } from "../lib/config";
import { findExisting, outRel, readJson, readJsonl, writeAtomic } from "../lib/files";
import { ResultLine, type Ctx } from "../lib/jobs";
import { ledgerSpentMicros, usd } from "../lib/money";
import { ScenesFile, type Slot } from "../lib/scenes";
import { AgeLine } from "./age";

/** SFace cosine threshold for "same person" from the OpenCV model card. */
const SAME_PERSON = 0.363;
const AVATAR_NAMES = ["candidate-1", "candidate-2", "candidate-3", "candidate-4", "master", "pack-front", "pack-body"];

const FaceEntry = z.object({
  faces: z.number().int(),
  headRatio: z.number().nullable(),
  cosMaster: z.number().nullable(),
  cosFront: z.number().nullable(),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  error: z.string().optional(),
});
type FaceEntry = z.infer<typeof FaceEntry>;
const FaceFile = z.record(z.string(), FaceEntry);

interface Data {
  latest: Map<string, ResultLine>;
  all: ResultLine[];
  face: Record<string, FaceEntry>;
  adult: Map<string, boolean>;
  slots: Slot[] | null;
  ledger: number;
}

async function load(): Promise<Data> {
  const all = await readJsonl(P.results, ResultLine);
  const latest = new Map<string, ResultLine>();
  for (const l of all) latest.set(l.jobId, l);
  const face = existsSync(P.face) ? await readJson(P.face, FaceFile) : {};
  const adult = new Map<string, boolean>();
  for (const a of await readJsonl(P.age, AgeLine)) adult.set(a.file, a.adult);
  const slots = existsSync(P.scenes) ? (await readJson(P.scenes, ScenesFile)).slots : null;
  return { latest, all, face, adult, slots, ledger: await ledgerSpentMicros() };
}

// ---------- stats ----------

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const f3 = (x: number | null) => (x === null ? "–" : x.toFixed(3));
const pct = (num: number, den: number) => (den ? `${Math.round((100 * num) / den)}% (${num}/${den})` : "–");

interface Summary {
  config: ConfigId;
  n: number;
  ok: number;
  refused: number;
  errTimeout: number;
  skipped: number;
  refusal: string;
  glamour: string;
  cosMean: string;
  cosMedian: string;
  cosMin: string;
  sameShare: string;
  headMean: string;
  latencyMean: string;
  cost: string;
  costPerOk: string;
  sizes: string;
}

function jobsFor(config: ConfigId, d: Data): { slotId: string; line: ResultLine | undefined; slot: Slot | undefined }[] {
  const cfg = RENDER_CONFIGS[config];
  if (d.slots) {
    return d.slots
      .filter((s) => cfg.slotIndexes.includes(s.index))
      .map((s) => ({ slotId: s.slotId, slot: s, line: d.latest.get(`${config}:${s.slotId}`) }));
  }
  return [...d.latest.values()]
    .filter((l) => l.config === config)
    .map((l) => ({ slotId: l.slotId, slot: undefined, line: l }));
}

function summarize(config: ConfigId, d: Data): Summary {
  const rows = jobsFor(config, d);
  const lines = rows.flatMap((r) => (r.line ? [r.line] : []));
  const by = (s: ResultLine["status"]) => lines.filter((l) => l.status === s);
  const ok = by("ok");
  const refused = by("refused");
  const errTimeout = by("error").length + by("timeout").length;
  const attempted = ok.length + refused.length + errTimeout;

  const glamour = [1, 2, 3]
    .map((lvl) => {
      const g = lines.filter((l) => l.category === "glamour" && l.spice === lvl && l.status !== "skipped_cap");
      return g.length ? `s${lvl}: ${g.filter((l) => l.status === "refused").length}/${g.length}` : null;
    })
    .filter((x) => x !== null)
    .join(", ");

  const faces = ok.flatMap((l) => (l.file && d.face[l.file] ? [d.face[l.file]] : []));
  const cos = faces.flatMap((f) => (f.cosMaster === null ? [] : [f.cosMaster]));
  const heads = faces.flatMap((f) => (f.headRatio === null ? [] : [f.headRatio]));
  const lat = ok.flatMap((l) => (l.latencyMs === null ? [] : [l.latencyMs]));
  let cost = 0;
  for (const l of d.all) if (l.config === config) cost += l.costMicros;
  const sizes = [...new Set(ok.map((l) => `${l.width ?? "?"}x${l.height ?? "?"}`))].join(" ");
  const latMean = mean(lat);

  return {
    config,
    n: rows.length,
    ok: ok.length,
    refused: refused.length,
    errTimeout,
    skipped: by("skipped_cap").length,
    refusal: pct(refused.length, attempted),
    glamour: glamour || "–",
    cosMean: f3(mean(cos)),
    cosMedian: f3(median(cos)),
    cosMin: f3(cos.length ? Math.min(...cos) : null),
    sameShare: faces.length ? pct(cos.filter((c) => c >= SAME_PERSON).length, ok.length) : "–",
    headMean: f3(mean(heads)),
    latencyMean: latMean === null ? "–" : `${(latMean / 1000).toFixed(1)}s`,
    cost: usd(cost),
    costPerOk: ok.length ? usd(Math.round(cost / ok.length)) : "–",
    sizes: sizes || "–",
  };
}

const COLUMNS: [keyof Summary, string][] = [
  ["config", "cfg"],
  ["n", "n"],
  ["ok", "ok"],
  ["refused", "refused"],
  ["errTimeout", "err/timeout"],
  ["skipped", "skipped_cap"],
  ["refusal", "refusal rate"],
  ["glamour", "glamour refused by spice"],
  ["cosMean", "cos mean"],
  ["cosMedian", "cos median"],
  ["cosMin", "cos min"],
  ["sameShare", `cos ≥ ${SAME_PERSON}`],
  ["headMean", "head ratio"],
  ["latencyMean", "latency"],
  ["cost", "cost"],
  ["costPerOk", "cost/ok"],
  ["sizes", "sizes"],
];

function markdown(summaries: Summary[]): string {
  const head = `| ${COLUMNS.map(([, h]) => h).join(" | ")} |`;
  const sep = `| ${COLUMNS.map(() => "---").join(" | ")} |`;
  const body = summaries.map((s) => `| ${COLUMNS.map(([k]) => String(s[k])).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

// ---------- html ----------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function card(title: string, file: string | null, lines: string[], d: Data, bad: boolean): string {
  const img = file
    ? `<a href="${esc(encodeURI(file))}"><img src="${esc(encodeURI(file))}" alt="${esc(title)}" loading="lazy"></a>`
    : `<div class="ph${bad ? " bad" : ""}">no image</div>`;
  const f = file ? d.face[file] : undefined;
  const faceLine = f
    ? `faces ${f.faces} · cosM ${f3(f.cosMaster)} · cosF ${f3(f.cosFront)} · head ${f3(f.headRatio)}`
    : "face –";
  const adult = file && d.adult.has(file) ? `adult ${d.adult.get(file) ? "yes" : "NO"}` : "adult –";
  const adultBad = file !== null && d.adult.get(file) === false;
  return `<figure>${img}<figcaption><b>${esc(title)}</b>${lines.map((l) => `<br>${esc(l)}`).join("")}<br>${esc(faceLine)}<br><span class="${adultBad ? "warn" : ""}">${esc(adult)}</span></figcaption></figure>`;
}

function lineInfo(l: ResultLine | undefined): { file: string | null; lines: string[]; bad: boolean } {
  if (!l) return { file: null, lines: ["not run"], bad: false };
  const cost = usd(l.costMicros);
  const lat = l.latencyMs === null ? "–" : `${(l.latencyMs / 1000).toFixed(1)}s`;
  if (l.status === "ok") {
    return { file: l.file, lines: [`ok · ${cost} · ${lat} · ${l.width ?? "?"}×${l.height ?? "?"}`], bad: false };
  }
  return {
    file: null,
    lines: [`${l.status}${l.httpStatus ? ` ${l.httpStatus}` : ""} · ${cost} · ${lat}`, (l.errorMessage ?? "").slice(0, 200)],
    bad: true,
  };
}

function html(summaries: Summary[], d: Data): string {
  const avatarCards = AVATAR_NAMES.map((name) => {
    const onDisk = findExisting(join(P.avatar, name));
    const rel = onDisk ? outRel(onDisk) : null;
    const l = d.latest.get(`avatar:${name}`);
    const info = lineInfo(l);
    const lines = name === "master" ? ["copy of the chosen candidate"] : info.lines;
    return card(name, rel ?? info.file, lines, d, info.bad);
  }).join("");

  const sections = CONFIG_IDS.map((id) => {
    const cfg = RENDER_CONFIGS[id];
    const cards = jobsFor(id, d)
      .map(({ slotId, slot, line }) => {
        const info = lineInfo(line);
        const cat = slot ?? line;
        const tag = cat ? `${cat.category ?? "?"} · ${cat.shot ?? "?"}${cat.spice ? ` · spice ${cat.spice}` : ""}` : "";
        return card(slotId, info.file, [tag, ...info.lines], d, info.bad);
      })
      .join("");
    const title = `${id}: ${cfg.model} · ${cfg.resolution}${cfg.quality ? ` · ${cfg.quality}` : ""} · refs [${cfg.refs.join(", ")}]`;
    return `<h2>${esc(title)}</h2><div class="grid">${cards}</div>`;
  }).join("");

  const th = COLUMNS.map(([, h]) => `<th>${esc(h)}</th>`).join("");
  const trs = summaries.map((s) => `<tr>${COLUMNS.map(([k]) => `<td>${esc(String(s[k]))}</td>`).join("")}</tr>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Studio API spike</title>
<style>
body{background:#111;color:#ddd;font:13px/1.4 system-ui,sans-serif;margin:16px}
h1,h2{color:#fff;font-weight:600}h2{margin-top:32px;font-size:16px}
table{border-collapse:collapse;display:block;overflow-x:auto}
th,td{border:1px solid #333;padding:4px 8px;text-align:left;white-space:nowrap}th{background:#1c1c1c}
.grid{display:flex;flex-wrap:wrap;gap:12px}
figure{margin:0;width:170px}
img{max-width:170px;display:block;border-radius:4px}
.ph{width:170px;height:120px;display:flex;align-items:center;justify-content:center;background:#222;border-radius:4px;color:#777}
.ph.bad{background:#3a1d1d;color:#e99}
figcaption{font-size:11px;color:#aaa;margin-top:4px;word-break:break-word}
.warn{color:#f77;font-weight:600}
</style></head><body>
<h1>Studio API spike</h1>
<p>Ledger spend: <b>${esc(usd(d.ledger))}</b> · generated ${esc(new Date().toISOString())} · face cosine is to master (cosM) and pack-front (cosF); SFace same-person threshold ${SAME_PERSON}</p>
<table><tr>${th}</tr>${trs}</table>
<h2>Avatar</h2><div class="grid">${avatarCards}</div>
${sections}
</body></html>
`;
}

export async function report(ctx: Ctx): Promise<void> {
  const d = await load();
  const summaries = CONFIG_IDS.map((id) => summarize(id, d));
  if (ctx.dryRun) {
    console.log("=== DRY RUN: report (free, local) — out/report.html not written ===");
  } else {
    await writeAtomic(P.report, html(summaries, d));
    console.log(`Wrote ${outRel(P.report)}`);
  }
  console.log(`\n${markdown(summaries)}\n\nTotal ledger spend: ${usd(d.ledger)}`);
}

/**
 * Regenerates studio/scripts/testFileTimes.json (the per-file times realWorkerTests.ts deals shards by) from a green studio.yml run.
 * Usage, from a checkout of the run's commit: `bun studio/scripts/makeTestFileTimes.ts <run-id> --commit <sha> --date <YYYY-MM-DD>`.
 * Needs `gh` logged in. It throws on a log it cannot parse, a missing shard job, or a table that does not match the repo's test files.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HEAVY_TEST_FILE, listTestFiles, parseFileTimes } from "./realWorkerTests";

const REPO = join(import.meta.dir, "..", "..");
const OUT = join(import.meta.dir, "testFileTimes.json");
const LINE = /^.*?\t.*?\t(\d{4}-\d\d-\d\dT[\d:.]+)Z (.*)$/;
const GROUP = /^##\[group\](studio[\\/]\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/;

function arg(name: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? undefined : process.argv[at + 1];
  if (value === undefined) throw new Error(`makeTestFileTimes: missing --${name}`);
  return value;
}

async function gh(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`makeTestFileTimes: gh ${args.join(" ")} exited ${code}: ${err}`);
  return out;
}

/** The span from each file's `##[group]` line to the next `##[endgroup]` line of one job log, in whole milliseconds. */
export function fileTimesOfLog(log: string, label: string): Record<string, number> {
  const times: Record<string, number> = {};
  let open: { file: string; at: number } | undefined;
  for (const raw of log.split("\n")) {
    const match = LINE.exec(raw.replace(/\r$/, ""));
    if (match === null) continue;
    const at = Date.parse(`${match[1]}Z`);
    const text = match[2] ?? "";
    const group = GROUP.exec(text);
    const groupFile = group?.[1]?.replaceAll("\\", "/");
    if (groupFile !== undefined) {
      if (open !== undefined) throw new Error(`makeTestFileTimes: ${label}: ${open.file} has no ##[endgroup] before ${groupFile}`);
      open = { file: groupFile, at };
    } else if (text === "##[endgroup]" && open !== undefined) {
      if (Number.isNaN(at) || at < open.at) throw new Error(`makeTestFileTimes: ${label}: bad timestamps for ${open.file}`);
      if (open.file in times) throw new Error(`makeTestFileTimes: ${label}: ${open.file} appears twice`);
      times[open.file] = Math.round(at - open.at);
      open = undefined;
    }
  }
  if (open !== undefined) throw new Error(`makeTestFileTimes: ${label}: ${open.file} has no ##[endgroup]`);
  if (Object.keys(times).length === 0) throw new Error(`makeTestFileTimes: ${label}: no test file groups in the log`);
  return times;
}

async function collect(runId: string, jobs: { id: number; name: string; conclusion: string }[], os: string, count: number): Promise<Record<string, number>> {
  const merged: Record<string, number> = {};
  for (let shard = 1; shard <= count; shard++) {
    const name = `test (${os}, shard ${shard}/${count})`;
    const job = jobs.find((candidate) => candidate.name === name);
    if (job === undefined) throw new Error(`makeTestFileTimes: run ${runId} has no job "${name}"`);
    if (job.conclusion !== "success") throw new Error(`makeTestFileTimes: job "${name}" is ${job.conclusion}, not success`);
    for (const [file, ms] of Object.entries(fileTimesOfLog(await gh("run", "view", runId, "--job", String(job.id), "--log"), name))) {
      if (file in merged) throw new Error(`makeTestFileTimes: ${file} ran in two ${os} shards`);
      merged[file] = ms;
    }
  }
  return merged;
}

const runId = process.argv[2];
if (runId === undefined || !/^\d+$/.test(runId)) throw new Error("makeTestFileTimes: usage: bun studio/scripts/makeTestFileTimes.ts <run-id> --commit <sha> --date <YYYY-MM-DD>");
const sha = arg("commit");
const date = arg("date");
const listing: unknown = JSON.parse(await gh("run", "view", runId, "--json", "jobs"));
const jobs = (typeof listing === "object" && listing !== null && "jobs" in listing && Array.isArray(listing.jobs) ? listing.jobs : []).flatMap((job: unknown) => {
  if (typeof job !== "object" || job === null || !("databaseId" in job) || !("name" in job) || !("conclusion" in job)) return [];
  const { databaseId, name, conclusion } = job;
  return typeof databaseId === "number" && typeof name === "string" && typeof conclusion === "string" ? [{ id: databaseId, name, conclusion }] : [];
});
const windows = await collect(runId, jobs, "windows-latest", 12);
const macos = await collect(runId, jobs, "macos-latest", 4);

const blocking = (await listTestFiles(["./studio"], REPO)).filter((file) => !HEAVY_TEST_FILE.test(file)).map((file) => file.replace(/^\.\//, ""));
for (const [os, map] of [["windows", windows], ["macos", macos]] as const) {
  const missing = blocking.filter((file) => !(file in map));
  const extra = Object.keys(map).filter((file) => !blocking.includes(file));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`makeTestFileTimes: ${os} does not match the repo (is this the run's commit?): not in the logs: ${missing.join(", ")}; not in the repo: ${extra.join(", ")}`);
  }
}

const sorted = (map: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const about =
  "Measured wall time of each Studio test file, in milliseconds: its tests plus its imports and hooks. " +
  `From the logs of the green studio.yml run ${runId} on main (commit ${sha}, ${date}): windows from the twelve test (windows-latest) shard jobs, ` +
  "macos from the four test (macos-latest) shard jobs. realWorkerTests.ts deals the blocking suite's files into shards by these times " +
  "(windows on Windows, macos elsewhere); a file that is not listed is dealt by count. A file's time is the span between its ##[group] and " +
  "##[endgroup] lines in a job log; regenerate with studio/scripts/makeTestFileTimes.ts from a newer green run once the suite has moved.";
const table = { about, windows: sorted(windows), macos: sorted(macos) };
parseFileTimes(table, "win32");
await writeFile(OUT, `${JSON.stringify(table, null, 2)}\n`);
console.log(`${OUT}: ${Object.keys(windows).length} windows, ${Object.keys(macos).length} macos files`);

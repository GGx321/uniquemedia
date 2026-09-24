import { parseArgs } from "node:util";
import { age } from "./commands/age";
import { candidates, pack } from "./commands/avatar";
import { meta } from "./commands/meta";
import { render } from "./commands/render";
import { report } from "./commands/report";
import { scenes } from "./commands/scenes";
import { API, DEFAULT_CAP, P } from "./lib/config";
import { acquireLock } from "./lib/files";
import type { Ctx } from "./lib/jobs";
import { Budget, ledgerSpentMicros, parseUsdToMicros, usd } from "./lib/money";
import { enableNetwork, remainingCredits } from "./lib/openrouter";

const HELP = `Studio API spike — measures OpenRouter image models.

Usage: bun run spike/studio-api/run.ts <command> [flags]

Commands (paid unless noted):
  candidates                 4 avatar portrait candidates
  pack --master <path>       copy the chosen candidate to master, render pack-front and pack-body
  scenes [--force]           plan 25 slots, one writer call, assemble prompts -> out/scenes.json
         [--fake-writer]     (free) build scenes.json from slot fields without the LLM; render refuses it
  render --config <A|B|C|D|E|all|A,B> [--limit N]
                             --limit N: canary, only the first N slots of each config are eligible
  age                        adult check for every ok render and avatar image without a result
  meta [--file <path>]...    (free) exiftool dump + 3 s MP4 re-encode, flags AI-provenance tags
  report                     (free) out/report.html + markdown summary

Flags:
  --dry-run                  print every planned request and the worst-case total; no network, no writes
  --cap <usd>                spend cap incl. earlier ledger spend (env SPIKE_CAP_USD, default ${DEFAULT_CAP})
`;

const PAID = new Set(["candidates", "pack", "scenes", "render", "age"]);

function parseLimit(arg: string | undefined): number | undefined {
  if (arg === undefined) return undefined;
  if (!/^[1-9]\d{0,2}$/.test(arg)) throw new Error(`--limit must be a positive integer, got "${arg}"`);
  return Number(arg);
}

/** Free balance check around a paid command; the ledger stays the source of truth. */
async function reconcile(before: Awaited<ReturnType<typeof remainingCredits>>, ledgerBefore: number): Promise<void> {
  const after = await remainingCredits();
  const ledgerDelta = (await ledgerSpentMicros()) - ledgerBefore;
  if ("error" in before || "error" in after) {
    const why = "error" in before ? before.error : "error" in after ? after.error : "";
    console.log(`credits: unavailable (${why}); ledger delta ${usd(ledgerDelta)}`);
    return;
  }
  const delta = before.micros - after.micros;
  console.log(
    `credits: remaining before ${usd(before.micros)}, after ${usd(after.micros)}, delta ${usd(delta)}; ` +
      `ledger delta ${usd(ledgerDelta)}; difference ${usd(delta - ledgerDelta)} (OpenRouter usage can lag by a minute)`
  );
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      cap: { type: "string" },
      master: { type: "string" },
      config: { type: "string" },
      limit: { type: "string" },
      force: { type: "boolean", default: false },
      "fake-writer": { type: "boolean", default: false },
      file: { type: "string", multiple: true },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(HELP);
    return;
  }

  const dryRun = values["dry-run"];
  const capMicros = parseUsdToMicros(values.cap ?? process.env.SPIKE_CAP_USD ?? DEFAULT_CAP);
  const limit = parseLimit(values.limit);
  const paid = PAID.has(command) && !dryRun && !(command === "scenes" && values["fake-writer"]);

  let release: (() => Promise<void>) | null = null;
  if (paid) {
    if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set (bun loads .env from the repo root)");
    release = await acquireLock(P.lock);
  }
  try {
    // Read only after the lock is held, so no other process can append in between.
    const spentBefore = await ledgerSpentMicros();
    const ctx: Ctx = { dryRun, capMicros, budget: new Budget(capMicros, spentBefore) };
    let creditsBefore: Awaited<ReturnType<typeof remainingCredits>> = { error: "not checked" };
    if (paid) {
      enableNetwork();
      creditsBefore = await remainingCredits();
      console.log(`api ${new URL(API.images).host}, cap ${usd(capMicros)}, ledger spent ${usd(spentBefore)}`);
    }
    try {
      switch (command) {
        case "candidates":
          return await candidates(ctx);
        case "pack":
          return await pack(ctx, values.master);
        case "scenes":
          return await scenes(ctx, { force: values.force, fakeWriter: values["fake-writer"] });
        case "render":
          return await render(ctx, values.config, limit);
        case "age":
          return await age(ctx);
        case "meta":
          return await meta(ctx, values.file ?? []);
        case "report":
          return await report(ctx);
        default:
          throw new Error(`Unknown command "${command}"\n\n${HELP}`);
      }
    } finally {
      if (paid) await reconcile(creditsBefore, spentBefore);
    }
  } finally {
    if (release) await release();
  }
}

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

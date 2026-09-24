/**
 * Parity of a face-js*.json against spike/studio-api/out/face.json, for results written outside
 * run.ts (the Electron renderer check). Writes parity.<suffix>.json next to the input.
 *
 *   bun run spike/face-js/parity.ts spike/face-js/out/face-js.renderer-t1.json
 */
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parityDigest, parityReport, readJsResults, readPyResults } from "./lib/parity.ts";

const input = process.argv[2];
if (!input || !basename(input).startsWith("face-js")) throw new Error("usage: parity.ts <spike/face-js/out/face-js*.json>");
const report = parityReport(await readPyResults(join(process.cwd(), "spike/studio-api/out/face.json")), await readJsResults(input));
const out = join(dirname(input), basename(input).replace(/^face-js/, "parity"));
await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${out}`);
console.log(JSON.stringify(parityDigest(report)));

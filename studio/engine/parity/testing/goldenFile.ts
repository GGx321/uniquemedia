/** The text of `golden.ts` for these transcripts. Kept in one place so that regenerating it is one command and one reviewable diff. */
export function goldenSource(golden: Readonly<Record<string, readonly string[]>>): string {
  const body = Object.entries(golden)
    .map(([name, lines]) => `  ${JSON.stringify(name)}: [\n${lines.map((line) => `    ${JSON.stringify(line)},`).join("\n")}\n  ],`)
    .join("\n");
  return [
    "// The transcript each parity scenario is bound to (see parity.test.ts). Both engines must produce exactly these lines.",
    "// REGENERATE deliberately, never to turn a red test green: `PARITY_WRITE_GOLDEN=1 bun test --no-env-file studio/engine/parity/parity.test.ts`",
    "// (it first requires the engine and the mock to agree), then READ the diff line by line: every changed line is a behaviour change.",
    "export const GOLDEN: Record<string, string[]> = {",
    body,
    "};",
    "",
  ].join("\n");
}

// 5a.2 (S5.6e, plan s5a2 §5.7): what the packaged-app smoke holds about the code template's money. A built-in category's scenes («home») are written by the shared template: the compose sends no
// writer request, spends $0 and writes every scene. A scene written FROM AN IDEA is the model's by nature, so an idea write still reaches the writer and is paid. The smoke reads the facts off
// the mock OpenRouter (its writer requests) and the engine's money status; these are the rules it applies, kept apart so they have a test (the app itself is only run in CI).

/** What the smoke reads before and after a write. */
export interface WriteFacts {
  /** Requests the mock OpenRouter received for the scene writer (a compose's chunk, an idea write). */
  writerRequests: number;
  /** The month's spend, in micro-dollars, as `money.status` says it. */
  spentMicros: number;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What is wrong with a compose of built-in scenes: a writer request, money spent, or scenes left unwritten. Empty when the template wrote it all for nothing. */
export function templateComposeProblems(before: WriteFacts, after: WriteFacts, scenes: { wanted: number; written: number }): string[] {
  const problems: string[] = [];
  const requests = after.writerRequests - before.writerRequests;
  if (requests !== 0) problems.push(`the compose sent ${plural(requests, "writer request", "writer requests")}, not none`);
  const spent = after.spentMicros - before.spentMicros;
  if (spent !== 0) problems.push(`the compose spent ${spent} µ$, not nothing`);
  if (scenes.written !== scenes.wanted) problems.push(`the compose wrote ${scenes.written} of ${scenes.wanted} scenes`);
  return problems;
}

/** What is wrong with an idea write: it must be exactly one more writer request, and it is paid. Empty when it is. */
export function ideaWriteProblems(before: WriteFacts, after: WriteFacts): string[] {
  const problems: string[] = [];
  const requests = after.writerRequests - before.writerRequests;
  if (requests !== 1) problems.push(`the idea write sent ${requests} writer requests, not one`);
  if (after.spentMicros - before.spentMicros <= 0) problems.push("the idea write spent nothing");
  return problems;
}

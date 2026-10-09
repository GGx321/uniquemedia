// A parity story is PENDING (`Scenario.pending`, Stage 4 S4.1) while the real engine does not serve the commands it tells. The mock's transcript is still bound to the golden;
// for the real engine the harness asks one thing of the commands the story names: each is answered with the engine's one refusal for a command it cannot serve,
// INTERNAL «<command> is not implemented yet» (a command served in part may say which part: «videos.delete with rejectPhotos is not implemented yet»).

/**
 * The named commands the real engine did NOT refuse that way, as sentences for the failing test to print: a command that was served, refused for another reason, sent and
 * never answered, or named but never sent. Empty when every named command, each time it was sent, got the refusal. `lines` is a transcript (`> type payload`, then the
 * events and notes it caused, then `< answer`).
 */
export function unservedAnswers(lines: readonly string[], commands: readonly string[]): string[] {
  const problems: string[] = [];
  for (const type of new Set(commands)) {
    const refusal = new RegExp(`^< error INTERNAL \\{"detail":"${escaped(type)}( with \\w+)? is not implemented yet"\\}$`);
    let sent = 0;
    lines.forEach((line, i) => {
      if (!line.startsWith(`> ${type} `)) return;
      sent += 1;
      const answer = lines.slice(i + 1).find((later) => later.startsWith("< "));
      if (answer === undefined) problems.push(`${type} was never answered`);
      else if (!refusal.test(answer)) problems.push(`${type} answered ${answer}`);
    });
    if (sent === 0) problems.push(`${type} was never sent`);
  }
  return problems;
}

/**
 * The other half of a pending story (S4.6a): the named commands the real engine DOES serve now, while the mock is not complete (S4.8) and the story cannot match line for
 * line yet. Each, every time it was sent, must be answered with anything but the refusal «not implemented yet»; a command sent and never answered, or never sent, is a
 * problem too (a story must exercise what it names).
 */
export function servedProblems(lines: readonly string[], commands: readonly string[]): string[] {
  const problems: string[] = [];
  for (const type of new Set(commands)) {
    const refusal = new RegExp(`^< error INTERNAL \\{"detail":"${escaped(type)}( with \\w+)? is not implemented yet"\\}$`);
    let sent = 0;
    lines.forEach((line, i) => {
      if (!line.startsWith(`> ${type} `)) return;
      sent += 1;
      const answer = lines.slice(i + 1).find((later) => later.startsWith("< "));
      if (answer === undefined) problems.push(`${type} was never answered`);
      else if (refusal.test(answer) || answer.startsWith("< error INTERNAL ")) problems.push(`${type} answered ${answer}, but the engine serves it now`);
    });
    if (sent === 0) problems.push(`${type} was never sent`);
  }
  return problems;
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

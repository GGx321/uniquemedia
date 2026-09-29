// A small evaluator for the arithmetic subset of ffmpeg's expression language
// that the graph builder emits: numbers, names, + - * / , parentheses, unary
// minus, `floor(x)`. It lets tests check an expression's VALUE without ffmpeg
// and without `eval`. It refuses anything else, so a new construct in the
// builder shows up as a test failure, not as a silent mis-evaluation.

type Vars = Readonly<Record<string, number>>;

export function evaluateExpression(source: string, vars: Vars): number {
  let pos = 0;
  const peek = (): string => source.charAt(pos);

  function fail(what: string): never {
    throw new Error(`expression ${JSON.stringify(source)}: ${what} at ${pos}`);
  }

  function number(): number {
    const start = pos;
    while (/[0-9.]/.test(peek()) && peek() !== "") pos++;
    return Number(source.slice(start, pos));
  }

  function primary(): number {
    const c = peek();
    if (c === "(") {
      pos++;
      const v = sum();
      if (peek() !== ")") fail("expected )");
      pos++;
      return v;
    }
    if (c === "-") {
      pos++;
      return -primary();
    }
    if (c === "+") {
      pos++;
      return primary();
    }
    if (/[0-9.]/.test(c) && c !== "") return number();
    const start = pos;
    while (/[A-Za-z0-9_]/.test(peek()) && peek() !== "") pos++;
    const name = source.slice(start, pos);
    if (name === "") return fail("unexpected character");
    if (peek() === "(") {
      pos++;
      const args = [sum()];
      while (peek() === ",") {
        pos++;
        args.push(sum());
      }
      if (peek() !== ")") fail("expected ) after the arguments");
      pos++;
      const [a] = args;
      if (name === "floor" && args.length === 1 && a !== undefined) return Math.floor(a);
      return fail(`unsupported function ${name} with ${args.length} arguments`);
    }
    const value = vars[name];
    if (value === undefined) return fail(`unknown name ${name}`);
    return value;
  }

  function product(): number {
    let v = primary();
    for (;;) {
      if (peek() === "*") {
        pos++;
        v *= primary();
      } else if (peek() === "/") {
        pos++;
        v /= primary();
      } else return v;
    }
  }

  function sum(): number {
    let v = product();
    for (;;) {
      if (peek() === "+") {
        pos++;
        v += product();
      } else if (peek() === "-") {
        pos++;
        v -= product();
      } else return v;
    }
  }

  const result = sum();
  if (pos !== source.length) fail("trailing input");
  return result;
}

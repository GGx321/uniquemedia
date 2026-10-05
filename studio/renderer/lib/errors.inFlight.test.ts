import { expect, test } from "bun:test";
import { errorText } from "./errors";

// IN_FLIGHT is refused for many reasons in Stage 3, and most of them cost no money: a library switch surveyed while ANY record is written, `media.list` during a switch, another
// import being picked. The general text must be true for all of them, so it names the busy state and does not claim paid requests are the cause.

test.each([
  ["a library switch being surveyed", "a library switch is being surveyed; write commands wait for it to finish"],
  ["another import being picked", "another import is being picked"],
  ["a render prepared across a library switch", "the library was switched while the render was being prepared"],
])("IN_FLIGHT for %s does not say the wait is for paid requests alone", (_name, detail) => {
  const text = errorText({ code: "IN_FLIGHT", detail });
  expect(text).toContain("другим действием");
  expect(text).not.toContain("Дождитесь завершения текущих платных запросов");
});

test("IN_FLIGHT tells the owner to wait and try again", () => {
  const text = errorText({ code: "IN_FLIGHT" });
  expect(text).toContain("дождитесь");
  expect(text).toContain("повторите");
});

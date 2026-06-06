import { test, expect } from "bun:test";
import { basename } from "./util";

test("basename strips directory on both separators", () => {
  expect(basename("/a/b/copy_1.mp4")).toBe("copy_1.mp4");
  expect(basename("C:\\x\\copy_2.mp4")).toBe("copy_2.mp4");
});

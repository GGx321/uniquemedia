import { test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

test("happy-dom + testing-library render works", () => {
  render(<div>hello</div>);
  expect(screen.getByText("hello")).toBeDefined();
});

import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";

test("happy-dom + testing-library render works", () => {
  render(<div>hello</div>);
  expect(screen.getByText("hello")).toBeDefined();
});

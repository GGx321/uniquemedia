import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { describeElement, focusedLabel } from "../testing";
import { ScreenTitle } from "./ScreenTitle";

// A screen that shows a title while it loads and another when it has loaded (EditorScreen's «Монтаж» and the draft's name, PhotosScreen's «Фото» and the avatar's
// name) swaps one h1 for another at a different place in the tree. The old h1 held the focus; its removal drops the focus to the body. The new title must take it
// back in the same commit: with a passive effect there is a gap, after the DOM changed and before the paint, in which the focus is on the body, and anything that
// reads it there (a layout effect, a focus-restoring dialog, a screen reader following the focus) finds nothing.

/** Records where the focus is when the commit's layout effects run, after the title's own (it stands later in the tree). */
function FocusProbe({ seen }: { seen: (Element | null)[] }) {
  useLayoutEffect(() => {
    seen.push(document.activeElement);
  });
  return null;
}

function Screen({ loaded, seen }: { loaded: boolean; seen: (Element | null)[] }) {
  return loaded ? (
    <main>
      <section>
        <ScreenTitle>Монтаж: Mia</ScreenTitle>
      </section>
      <FocusProbe seen={seen} />
    </main>
  ) : (
    <main>
      <ScreenTitle>Монтаж</ScreenTitle>
      <FocusProbe seen={seen} />
    </main>
  );
}

describe("ScreenTitle", () => {
  test("takes the focus when the screen opens", () => {
    render(<Screen loaded={false} seen={[]} />);
    expect(focusedLabel()).toBe(describeElement(screen.getByRole("heading", { level: 1, name: "Монтаж" })));
  });

  test("the loaded title has the focus in the commit that swaps it for the loading one, never leaving it on the body", () => {
    const seen: (Element | null)[] = [];
    const view = render(<Screen loaded={false} seen={seen} />);
    expect(focusedLabel()).toBe(describeElement(screen.getByRole("heading", { level: 1, name: "Монтаж" })));

    view.rerender(<Screen loaded seen={seen} />);

    const loaded = describeElement(screen.getByRole("heading", { level: 1, name: "Монтаж: Mia" }));
    // What the commit's layout effects saw of the focus, not what is left once the effects have run.
    expect(describeElement(seen.at(-1) ?? null)).toBe(loaded);
    expect(focusedLabel()).toBe(loaded);
  });
});

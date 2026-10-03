import { describe, expect, test } from "bun:test";
import { isTextEntry, ownsKeys } from "./keys";

// 3d.3a review: which keys belong to the focused control and which to the editor. ⌘Z / ⇧⌘Z are the draft's
// unless the owner is typing (a text field keeps its own undo); Delete, Escape and the arrows are the control's
// whenever it is a form control or editable text (Delete on the length slider must never delete the clip).

function input(type: string): HTMLInputElement {
  const node = document.createElement("input");
  node.type = type;
  return node;
}

function editable(): HTMLElement {
  const node = document.createElement("div");
  node.contentEditable = "true";
  document.body.append(node);
  return node;
}

describe("typing: ⌘Z belongs to the field", () => {
  test("text-entry inputs, a textarea and editable text", () => {
    for (const type of ["text", "search", "email", "url", "tel", "password", "number"]) expect(isTextEntry(input(type))).toBe(true);
    expect(isTextEntry(document.createElement("textarea"))).toBe(true);
    const node = editable();
    expect(isTextEntry(node)).toBe(true);
    node.remove();
  });

  test("not a slider, a box, a button, a colour or a file picker; not a plain element or nothing", () => {
    for (const type of ["range", "checkbox", "radio", "button", "submit", "reset", "color", "file"]) expect(isTextEntry(input(type))).toBe(false);
    expect(isTextEntry(document.createElement("button"))).toBe(false);
    expect(isTextEntry(document.createElement("div"))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry(window)).toBe(false);
  });
});

describe("a control that owns Delete, Escape and the arrows", () => {
  test("every input (a slider too), a textarea, a select and editable text", () => {
    for (const type of ["text", "range", "checkbox", "color", "number"]) expect(ownsKeys(input(type))).toBe(true);
    expect(ownsKeys(document.createElement("textarea"))).toBe(true);
    expect(ownsKeys(document.createElement("select"))).toBe(true);
    const node = editable();
    expect(ownsKeys(node)).toBe(true);
    node.remove();
  });

  test("not a button (a clip block, a toolbar button), not a plain element", () => {
    expect(ownsKeys(document.createElement("button"))).toBe(false);
    expect(ownsKeys(document.createElement("span"))).toBe(false);
    expect(ownsKeys(null)).toBe(false);
  });
});

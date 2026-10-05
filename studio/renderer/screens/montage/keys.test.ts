import { afterEach, describe, expect, test } from "bun:test";
import { isTextEntry, ownsKeys, type SpaceKey, spacePlays } from "./keys";

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

// The owner's feedback (2026-10-05): Space plays and pauses the montage. Not while typing (a text field, a select's type-ahead, editable
// text), not on a checkbox or a radio (Space is their only key), not inside an open dialog or menu or while a modal is open anywhere, and not
// with a modifier. On a button it plays INSTEAD of pressing the button (Enter still presses it).
describe("Space plays and pauses", () => {
  const space = (target: EventTarget, over: Partial<SpaceKey> = {}): SpaceKey => ({ key: " ", target, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, ...over });
  const placed = (node: HTMLElement, into: HTMLElement = document.body): HTMLElement => {
    into.append(node);
    return node;
  };
  const cleanup: HTMLElement[] = [];
  const add = <T extends HTMLElement>(node: T): T => {
    cleanup.push(node);
    return node;
  };
  afterEach(() => {
    for (const node of cleanup.splice(0)) node.remove();
  });

  test("on the page, a button (a switch, a tab, a clip block), a slider and a range input", () => {
    expect(spacePlays(space(document.body), document)).toBe(true);
    const button = add(placed(document.createElement("button")));
    expect(spacePlays(space(button), document)).toBe(true);
    const sw = add(placed(document.createElement("button")));
    sw.setAttribute("role", "switch");
    expect(spacePlays(space(sw), document)).toBe(true);
    const slider = add(placed(document.createElement("div")));
    slider.setAttribute("role", "slider");
    expect(spacePlays(space(slider), document)).toBe(true);
    expect(spacePlays(space(add(placed(input("range")))), document)).toBe(true);
    expect(spacePlays(space(window), document)).toBe(true);
  });

  test("not while typing: text inputs, a textarea, a select, editable text", () => {
    for (const type of ["text", "search", "number"]) expect(spacePlays(space(add(placed(input(type)))), document)).toBe(false);
    expect(spacePlays(space(add(placed(document.createElement("textarea")))), document)).toBe(false);
    expect(spacePlays(space(add(placed(document.createElement("select")))), document)).toBe(false);
    const node = add(editable());
    expect(spacePlays(space(node), document)).toBe(false);
  });

  test("not on a checkbox or a radio: Space is their only key", () => {
    for (const type of ["checkbox", "radio"]) expect(spacePlays(space(add(placed(input(type)))), document)).toBe(false);
  });

  test("not with a modifier, not while composing, not when the control already took it, not another key", () => {
    const button = add(placed(document.createElement("button")));
    for (const over of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { defaultPrevented: true }, { key: "Enter" }, { key: "k" }]) expect(spacePlays(space(button, over), document)).toBe(false);
  });

  test("not inside an open dialog or a menu, whatever is focused there", () => {
    for (const role of ["dialog", "alertdialog", "menu", "menubar", "listbox"]) {
      const box = add(placed(document.createElement("div")));
      box.setAttribute("role", role);
      const button = placed(document.createElement("button"), box);
      expect(spacePlays(space(button), document)).toBe(false);
    }
    const dialog = add(placed(document.createElement("dialog")));
    dialog.setAttribute("open", "");
    expect(spacePlays(space(placed(document.createElement("button"), dialog)), document)).toBe(false);
  });

  test("not while a modal is open anywhere, even with the focus left on the page", () => {
    const modal = add(placed(document.createElement("div")));
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    expect(spacePlays(space(document.body), document)).toBe(false);
    modal.remove();
    expect(spacePlays(space(document.body), document)).toBe(true);
  });
});

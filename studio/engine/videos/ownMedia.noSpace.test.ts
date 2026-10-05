import { expect, test } from "bun:test";
import { RENDER_NO_SPACE_DETAIL_PREFIX } from "../../shared/engine";
import { ownMediaNoSpace } from "./ownMedia";

// The window tells «no room for the temporary files» from other render failures by the detail's prefix, so the engine must write exactly it.

test("a render that cannot copy an own file for lack of space starts its detail with the contract's prefix", () => {
  expect(ownMediaNoSpace("photo").engineError.detail?.startsWith(RENDER_NO_SPACE_DETAIL_PREFIX)).toBe(true);
});

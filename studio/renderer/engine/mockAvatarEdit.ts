import { checkDescriptorEdit, composedLength, DESCRIPTOR_MAX_CHARS, type EngineError } from "../../shared/engine";

// The mock's side of `avatars.editDescriptor` (Stage 5, S5.0a). The engine's `#editDescriptor` answers a stale proposal first, then the text's own rules, both through
// `checkDescriptorEdit`; this is the same two steps over the mock's stored text, so a refusal carries the same closed reason in both.

/**
 * The text to store, or the VALIDATION to answer: stale when `expectedText` is not what is stored, else the first rule `text` breaks for an avatar of `age`. `body` is the
 * avatar's body phrase (S5.2a): the text and «; » and the phrase must together fit the 600.
 */
export function descriptorEditOutcome(stored: string, age: number, text: string, expectedText: string, body?: string): { text: string } | { error: EngineError } {
  if (expectedText !== stored) return { error: { code: "VALIDATION", descriptorReason: "stale", detail: "the stored description is not the one this edit was made against" } };
  const checked = checkDescriptorEdit(text, age, body);
  if (checked.ok) return { text: checked.text };
  return {
    error: {
      code: "VALIDATION",
      descriptorReason: checked.reason,
      ...(checked.words.length > 0 ? { descriptorWords: checked.words.slice(0, 10).map((word) => word.slice(0, 60)) } : {}),
      detail: `the description breaks a rule: ${checked.reason}`,
    },
  };
}

/** `avatars.setBody`: the VALIDATION to answer when the stored text and the new body phrase together are over the limit (the engine answers the same), else null. */
export function bodyCompositeRefusal(storedText: string, phrase: string | undefined): EngineError | null {
  return composedLength(storedText, phrase) > DESCRIPTOR_MAX_CHARS
    ? { code: "VALIDATION", descriptorReason: "too-long-with-body", detail: "the description and the body phrase together are over the limit" }
    : null;
}

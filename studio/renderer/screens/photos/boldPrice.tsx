import { PRICE_SCOPES_RU, type EngineError, type Estimate } from "../../../shared/engine";
import { Notice } from "../../ui/Notice";
import { boldAttemptLine } from "./level";

// S5.9g (plan s5a3 gaps C and D; mockups 47, 49, 55): what the price columns say about the «Смелая» route — the engine's price of one Seedream attempt under the
// expected sum, and, when the price list has no 2K tier, why «Смелая» cannot start while everything else can. Both read the engine's answer only.

/** State 55: a PRICE_UNAVAILABLE the engine raised for the 2K tier alone (`priceScope: "bold"`). Any other price failure is today's, with today's text. */
export function isBoldPriceMissing(error: EngineError | null | undefined): boolean {
  return error?.code === "PRICE_UNAVAILABLE" && error.priceScope === "bold";
}

/** State 55's warning (mockup 55): a warning, not an error — the rest works. `id` lets the retry button be described by it. */
export function BoldPriceNotice({ id }: { id?: string }) {
  return (
    <div id={id}>
      <Notice tone="warn">{PRICE_SCOPES_RU.bold}</Notice>
    </div>
  );
}

/** «Seedream 2K — до $X за попытку по прайсу» under the expected sum, only while the engine's estimate prices a Seedream attempt (`boldAttemptMicros`). */
export function BoldAttemptLine({ estimate }: { estimate: Estimate | null | undefined }) {
  const micros = estimate?.boldAttemptMicros;
  return micros === undefined ? null : <p className="gen-bold-price">{boldAttemptLine(micros)}</p>;
}

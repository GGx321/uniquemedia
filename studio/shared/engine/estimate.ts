import { z } from "zod";
import { Micros } from "./primitives";

// A cost shown before anything is spent. It lives in its own module so that `clips.ts` (whose job states `state.ts` imports) can name it without a cycle;
// `state.ts` re-exports both names, so every importer of `Estimate` is unchanged.

const IsoDate = z.iso.date();

/** Where prices came from: the live OpenRouter endpoints or the dated fallback table. */
export const PriceSource = z.enum(["live", "fallback"]);

/** A cost shown before anything is spent: expected and worst case, both in micro-dollars. */
export const Estimate = z
  .strictObject({
    expectedMicros: Micros,
    worstMicros: Micros,
    prices: PriceSource,
    pricesAsOf: IsoDate,
    /**
     * Additive (5a.3, S5.9a, gap C): the price of one attempt on the Seedream route (list, 2K), present only when the plan has Seedream slots, so the card can say
     * «до $X за попытку» without a price of its own. Nothing writes it before S5.9d.
     */
    boldAttemptMicros: Micros.positive().optional(),
  })
  .refine((e) => e.expectedMicros <= e.worstMicros, {
    message: "expected cost must not exceed the worst case",
    path: ["expectedMicros"],
  });

export type Estimate = z.infer<typeof Estimate>;

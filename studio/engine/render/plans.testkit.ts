import { motionPlan } from "../../shared/montage";
import type { MovingMotionPlan } from "./zoompan";

/** A moving plan of a kind, found by scanning seeds (a plan is a function of the seed and the clip id). */
export function planWhere(clipId: string, motion: "kenburns" | "pan", pick: (p: MovingMotionPlan) => boolean): { seed: number; plan: MovingMotionPlan } {
  for (let seed = 0; seed < 500; seed++) {
    const plan = motionPlan(seed, clipId, motion);
    if (plan.kind !== "static" && pick(plan)) return { seed, plan };
  }
  throw new Error("no seed gives that plan");
}

/** One case per motion the render has: Ken Burns in and out, and the four pan ways. */
export const MOVING_CASES: ReadonlyArray<{ name: string; motion: "kenburns" | "pan"; pick: (p: MovingMotionPlan) => boolean }> = [
  { name: "kenburns in", motion: "kenburns", pick: (p) => p.kind === "kenburns" && p.direction === "in" },
  { name: "kenburns out", motion: "kenburns", pick: (p) => p.kind === "kenburns" && p.direction === "out" },
  { name: "pan left", motion: "pan", pick: (p) => p.kind === "pan" && p.direction === "left" },
  { name: "pan right", motion: "pan", pick: (p) => p.kind === "pan" && p.direction === "right" },
  { name: "pan up", motion: "pan", pick: (p) => p.kind === "pan" && p.direction === "up" },
  { name: "pan down", motion: "pan", pick: (p) => p.kind === "pan" && p.direction === "down" },
];

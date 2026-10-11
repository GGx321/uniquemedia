import type { LightMood } from "./types";

// A hook for the owner's style references (2026-10-11): home content lit by a dim evening lamp, fairy lights or grainy low light, apart from the
// daylight of a street. PLACEHOLDERS: the style probe decides the real moods and their words; nothing draws them yet (today's light is the look
// module's table by time of day, engine/scenes/phoneLook.ts).
export const LIGHTS: readonly LightMood[] = [
  { id: "evening-lamp", text: "a single lamp on in the evening", setting: "indoor" },
  { id: "fairy-lights", text: "a string of fairy lights", setting: "indoor" },
  { id: "low-light", text: "dim light, a little grainy", setting: "indoor" },
  { id: "daylight-street", text: "plain daylight on the street", setting: "outdoor" },
];

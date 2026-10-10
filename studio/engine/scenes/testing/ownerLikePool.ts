import type { Pool } from "../pools";

// S5.R1 round 3: the shape of the owner's live category «Домашнее у кровати» («Home Lounging»), copied by hand (a test never reads a library): five places, one of which («a living room
// rug») has a phone activity as its only free-hand one. Before the fix, a selfie or mirror drawn there got the phone activity, which the reader then refused.

const one = (text: string) => ({ text, twoHanded: false });
const two = (text: string) => ({ text, twoHanded: true });

export const OWNER_LIKE_POOL: Pool = {
  locations: [
    { name: "a cozy bedroom", times: ["morning", "evening"], mirror: true, activities: [two("reading a magazine"), one("resting her head on hands"), two("adjusting a pillow")] },
    { name: "a living room rug", times: ["midday", "golden hour"], activities: [one("scrolling on a phone"), two("flipping through a book")] },
    { name: "a wide bed with pillows", times: ["morning", "night"], activities: [two("watching a tablet"), one("stretching her arms forward")] },
    { name: "a sunlit windowsill seat", times: ["midday", "golden hour"], activities: [one("holding a cup of tea"), two("writing in a notebook")] },
    { name: "a quiet home office floor", times: ["midday", "evening"], activities: [two("sorting papers"), one("leaning on one elbow")] },
  ],
  outfits: ["an oversized tee and shorts", "a loose button-up and pants", "a cotton hoodie and joggers", "a linen shirt and leggings"],
  shotDeck: ["friend", "candid", "selfie", "mirror", "candid"],
};

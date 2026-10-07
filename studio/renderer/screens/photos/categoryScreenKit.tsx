import { screen } from "@testing-library/react";
import type { AvatarSummary, CategoryInterrupted, CategoryPlace, CategoryPool, CategorySummary, CustomCategoryId } from "../../../shared/engine";
import { mockDescriptor } from "../../engine/mockEngine";
import { DEFAULT_TRAITS } from "../../lib/traits";
import { openSection, setup } from "../../testing";

// CS.3 screen tests' fixtures: the categories the CS.0 artboards draw («Кофейни Парижа» with six places and four outfits, «Горы зимой»,
// «Студия ч/б»), made before the mock's clock starts so a category the mock makes is the newest, as it would be.

export const MIA: AvatarSummary = {
  avatarId: "avatar-mia-0001",
  name: "Mia",
  descriptor: mockDescriptor(DEFAULT_TRAITS),
  masterPhotoId: "photo-mia-0001",
  createdAt: "2026-09-01T09:00:00.000Z",
  status: "active",
  photoCount: 1,
  videoCount: 0,
  eligibleUnusedCount: 0,
  usage: { state: "ok" },
};

function place(name: string, times: CategoryPlace["times"], activities: readonly string[], mirror = false): CategoryPlace {
  return { name, times: [...times], activities: activities.map((text, i) => ({ text, twoHanded: i === activities.length - 1 && activities.length > 2 })), mirror };
}

export const PARIS_POOL: CategoryPool = {
  locations: [
    place("corner cafe window seat", ["morning", "midday"], ["reading a paperback", "sipping a latte", "writing in a notebook"]),
    place("sidewalk cafe terrace", ["midday", "golden hour"], ["stirring an espresso", "people-watching", "laughing with a friend"]),
    place("bookshop by the river", ["midday"], ["browsing a shelf", "holding an open book"]),
    place("Seine riverside walk", ["golden hour", "evening"], ["leaning on the stone wall", "walking with a tote bag"]),
    place("boulangerie counter", ["morning"], ["holding a paper bag", "paying at the counter"]),
    place("cafe restroom mirror", ["evening"], ["fixing her hair", "checking her lipstick"], true),
  ],
  // The artboard's own outfits, cut to the contract's 35 chars (POOL_TEXT_MAX).
  outfits: ["beige trench coat, striped tee", "black beret and camel wool coat", "white blouse, high-waisted jeans", "navy knit cardigan and midi skirt"],
  shotDeck: ["friend", "friend", "selfie", "mirror", "candid"],
};

/** Five places, three outfits: every × at its minimum. */
export const WINTER_POOL: CategoryPool = {
  locations: [
    place("chalet balcony with a view", ["morning"], ["holding a mug", "wrapping a scarf"]),
    place("ski lift queue", ["midday"], ["adjusting her goggles", "carrying skis"]),
    place("snowy village street", ["evening"], ["window shopping", "catching snowflakes"]),
    place("fireside lounge", ["night"], ["reading a book", "warming her hands"]),
    place("hotel lobby mirror", ["evening"], ["checking her coat", "fixing her hat"], true),
  ],
  outfits: ["white puffer jacket and jeans", "cream knit sweater and leggings", "red ski suit"],
  shotDeck: ["friend", "selfie", "mirror", "candid", "candid"],
};

export function category(n: number, name: string, pool: CategoryPool = PARIS_POOL, patch: Partial<CategorySummary> = {}): CategorySummary {
  const day = String(n).padStart(2, "0");
  return {
    categoryId: `cat-seeded-${String(n).padStart(4, "0")}`,
    name,
    description: `Описание: ${name}`,
    label: name === "Кофейни Парижа" ? "Paris cafes" : "Mock theme",
    style: "phone",
    pool,
    model: "x-ai/grok-4.3",
    spentMicros: 5_000,
    createdAt: `2026-09-${day}T09:00:00.000Z`,
    updatedAt: `2026-09-${day}T09:00:00.000Z`,
    ...patch,
  };
}

/**
 * CS.8: «Домашнее у кровати» (CatCreateDoneAngles, CatSheetAngles): a description that names the angle («Вид сзади или вполоборота») keeps it in the pool,
 * stored as the model gave it (back first); its activities open with the body position, each within the 35 characters.
 */
export const BED_POOL: CategoryPool = {
  locations: [
    place("unmade bed with white linen", ["morning", "midday"], ["lying on her stomach, reading", "lying on her back, stretching"]),
    place("edge of the bed by the window", ["morning"], ["sitting on the bed edge, yawning", "sitting up in bed, pulling on socks"]),
    place("pillows against the headboard", ["evening", "night"], ["lying on her side, reading a book", "kneeling, fluffing a pillow"]),
    place("bedroom window with sheer curtains", ["morning", "golden hour"], ["standing at the window, stretching", "leaning on the sill, holding a mug"]),
    place("bedside nightstand with a lamp", ["evening"], ["kneeling on the bed, by the lamp", "lying on her stomach, writing"]),
    place("rug at the foot of the bed", ["midday"], ["sitting cross-legged on the rug", "lying on the rug, scrolling"]),
  ],
  outfits: ["oversized tee", "striped pyjamas", "satin nightgown", "grey lounge set"],
  shotDeck: ["friend", "friend", "candid", "candid", "selfie"],
  poses: ["back", "three-quarter"],
};

export const PARIS = category(1, "Кофейни Парижа", PARIS_POOL, {
  description: "Парижские кофейни и улочки вокруг них: утро с круассаном у окна, терраса на тротуаре, книжная лавка рядом, прогулка по набережной Сены.",
});
export const WINTER = category(2, "Горы зимой", WINTER_POOL);
export const MONO = category(3, "Студия ч/б", WINTER_POOL);
export const BED = category(4, "Домашнее у кровати", BED_POOL, {
  description: "Дома у кровати: лежит на животе и листает журнал, сидит на краю кровати, потягивается утром у окна. Вид сзади или вполоборота, лица почти не видно. Пижама, атласная сорочка, оверсайз-футболка.",
  label: "bedside at home",
  spentMicros: 6_000,
});

export function interruptedCreate(patch: Partial<CategoryInterrupted> = {}): CategoryInterrupted {
  return {
    jobId: "job-left-0001",
    kind: "create",
    name: "Рынки",
    description: "Рынки и прилавки с фруктами",
    categoryId: null,
    startedAt: "2026-09-20T09:00:00.000Z",
    spentMicros: 22_500,
    openReserveMicros: 22_500,
    ...patch,
  };
}

export function interruptedRegenerate(categoryId: CustomCategoryId, patch: Partial<CategoryInterrupted> = {}): CategoryInterrupted {
  return interruptedCreate({ jobId: "job-left-0002", kind: "regenerate", categoryId, name: "Кофейни Парижа", description: "Кофейни и бистро", ...patch });
}

/** Opens Mia's Photos screen from the sidebar and waits for the run's first price (today's path: «Сцены на проверку» off unless asked). */
export async function openPhotos(options: Parameters<typeof setup>[0] = {}) {
  const harness = setup({ avatars: [MIA], sceneReview: "off", ...options });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  await openSection("Фото");
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  await screen.findByRole("button", { name: /^Сгенерировать \d+ фото · до \$/ });
  return harness;
}

export function chipsGroup(): HTMLElement {
  return screen.getByRole("group", { name: "Категории · фото в каждой" });
}

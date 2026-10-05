# Face fixture images

Six JPEGs for the face gate's parity tests (`../expected.ts`, `parity.test.ts`) and for one decoder test. The repository is public, so where they
come from is written down here.

## Provenance

Five of them are the unmodified output of the Studio API spike (`spike/studio-api`, the 2026-09-24 run), copied from its git-ignored `out/` folder
(`../expected.ts` says the same). Every image of that run was made by an image model through OpenRouter:

| File | What it is |
| --- | --- |
| `master.jpg` | the avatar "master" portrait: the spike's pick of the four text-to-image candidates (its report names candidate-4) |
| `impostor-candidate-1.jpg` | one of the three candidates that were NOT picked: a different person built from the same text description |
| `render-best-home-1.jpg`, `render-median-travel-2.jpg`, `render-worst-fitness-3.jpg` | renders of the 25-slot plan, made by the model with `master.jpg` as its only reference image |

The candidates were generated from a text description alone (`spike/studio-api/commands/avatar.ts` passes no reference image for them), and the renders
used only the generated master as reference. So no photograph of a real person went into any of these five, and none depicts a real person on purpose. A
generated face can still resemble somebody; that was not checked.

## Not documented

`master-cmyk.jpg` (300 x 400, a CMYK-encoded JPEG) was added with the commit that makes a CMYK master fall back to the reference (`7e98cb47`) and is used
by `engine.runs.test.ts`. The commit and the code do not say how it was made. It is probably a re-encoding of one of the spike's generated portraits, but
that is a guess, not a record. If its source matters, ask whoever made it (the repository owner) before relying on it.

## Rules

- Do not add a photograph of a real person here. A test that needs a face takes one of these or a new image-model output, and its README row says so.
- The numbers in `../expected.ts` belong to these exact bytes; replacing an image means re-measuring it.

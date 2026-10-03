import { join } from "node:path";
import type { MediaKind, MediaPickKind, MediaUnsupportedReason } from "../../shared/engine";
import type { FileIdentity } from "../library/openRegular";
import { MediaStaging, type MediaStagingOptions, type StagedMedia } from "./staging";

// The hand-off from the import boundary to the per-kind importers (3f.2 photos, 3f.3a video, 3f.4 music, 3f.5 stickers).
//
// An importer is `(request) => outcome`. It gets the STAGED copy of the picked file (`request.staged`: a file inside the library's own
// staging folder, its size, its sha256 and its first bytes) and the file's display name. It never gets the picked path, and it must read
// the staged copy only. On `{ ok: true, jobId }` the importer OWNS the staged copy and disposes of it when it is done (a crash leaves it
// to the staging folder's sweep at the next start); on `{ ok: false, reason }` or a throw, the boundary disposes of it.

export interface MediaImportRequest {
  readonly staged: StagedMedia;
  /** The picked file's base name, for display; the importer decides what the library stores it as. */
  readonly name: string;
}
export type MediaImportOutcome = { ok: true; jobId: string } | { ok: false; reason: MediaUnsupportedReason };
export type MediaImporter = (request: MediaImportRequest) => Promise<MediaImportOutcome>;
export type MediaImporters = Partial<Record<MediaKind, MediaImporter>>;

/** One picked file, as main's check and the control channel describe it. */
export interface MediaImportCall {
  readonly pick: MediaPickKind;
  readonly path: string;
  readonly name: string;
  /** The identity main saw when the dialog answered. */
  readonly expected: FileIdentity;
}

export type MediaImportResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: MediaUnsupportedReason | "cancelled" | "failed"; detail: string };

export interface MediaImportsOptions {
  readonly newId: () => string;
  readonly importers?: MediaImporters | undefined;
  readonly staging?: Pick<MediaStagingOptions, "ops" | "noFollow" | "chunkBytes" | "caps"> | undefined;
}

/** Folder of a library root where picked files are staged: `<library>/media/.staging`. */
export function stagingDirOf(libraryRoot: string): string {
  return join(libraryRoot, "media", ".staging");
}

export class MediaImports {
  readonly #options: MediaImportsOptions;
  /** One staging area per library root, for the engine's life: the first use of each sweeps what a crash left in it. */
  readonly #areas = new Map<string, MediaStaging>();

  constructor(options: MediaImportsOptions) {
    this.#options = options;
  }

  #stagingFor(libraryRoot: string): MediaStaging {
    let area = this.#areas.get(libraryRoot);
    if (area === undefined) {
      const importers = this.#options.importers ?? {};
      area = new MediaStaging({
        ...this.#options.staging,
        dir: stagingDirOf(libraryRoot),
        newId: this.#options.newId,
        supports: (kind) => importers[kind] !== undefined,
      });
      this.#areas.set(libraryRoot, area);
    }
    return area;
  }

  /** Stages the picked file in `libraryRoot`'s staging area and hands the staged copy to its kind's importer. Never rejects for a bad file; a file's refusal is a result. */
  async importFile(libraryRoot: string, call: MediaImportCall, signal?: AbortSignal): Promise<MediaImportResult> {
    const result = await this.#stagingFor(libraryRoot).stage({ path: call.path, kind: call.pick, expected: call.expected, signal });
    if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
    const { staged } = result;
    const importer = this.#options.importers?.[staged.kind];
    if (importer === undefined) {
      await staged.dispose();
      return { ok: false, reason: "not-yet-supported", detail: `${staged.kind} files cannot be imported yet` };
    }
    let outcome: Awaited<ReturnType<MediaImporter>>;
    try {
      outcome = await importer({ staged, name: call.name });
    } catch {
      // The importer's own message may name its working files: only the fact travels.
      await staged.dispose();
      return { ok: false, reason: "failed", detail: "the importer failed" };
    }
    if (outcome.ok) return { ok: true, jobId: outcome.jobId };
    await staged.dispose();
    return { ok: false, reason: outcome.reason, detail: `the file was refused: ${outcome.reason}` };
  }
}

/** The clip file name: `clip-NN.mkv`, two digits (a montage has at most 20 clips). Pass 1 writes it, pass 2 lists it. */
export const clipFileName = (index: number): string => `clip-${String(index).padStart(2, "0")}.mkv`;

/** A layer-pass file name: `layers-NN.mkv`, two digits (at most 20 layers, so at most 20 calls). Each call writes one; the next reads it. */
export const layerFileName = (index: number): string => `layers-${String(index).padStart(2, "0")}.mkv`;

/** The concat list's name, relative to the job folder (ffmpeg's `cwd`). */
export const CONCAT_LIST_NAME = "list.txt";

/** The private copy of a stored track, in the job folder (3c.5): the measurement and pass 2 read this, never the stored file. */
export const TRACK_FILE_NAME = "track.m4a";

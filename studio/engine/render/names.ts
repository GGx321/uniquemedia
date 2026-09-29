/** The clip file name: `clip-NN.mkv`, two digits (a montage has at most 20 clips). Pass 1 writes it, pass 2 lists it. */
export const clipFileName = (index: number): string => `clip-${String(index).padStart(2, "0")}.mkv`;

/** The concat list's name, relative to the job folder (ffmpeg's `cwd`). */
export const CONCAT_LIST_NAME = "list.txt";

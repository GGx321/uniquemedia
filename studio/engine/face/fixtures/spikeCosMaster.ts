/**
 * Real SFace cosine-to-master scores from the face spike (OpenCV, Chromium-
 * parity numbers), copied by hand from `spike/studio-api/out/face.json`
 * (2026-09-24 run) since that file is git-ignored spike output. Values only —
 * no pixels, so this fixture needs no model and stays independent of network
 * access or the model cache.
 */

/** All 76 `render/**` entries with a face (spike README: "76 same-person renders"). */
export const SPIKE_TRUE_RENDER_COSMASTER: readonly number[] = [
  0.7499, 0.6366, 0.7238, 0.6202, 0.6043, 0.7292, 0.5556, 0.6793, 0.6575, 0.7687, 0.7716, 0.7291, 0.7649, 0.8002, 0.6056, 0.7762, 0.6339, 0.6227,
  0.726, 0.9017, 0.6726, 0.7178, 0.8612, 0.6807, 0.6264, 0.9113, 0.6906, 0.6709, 0.8126, 0.7592, 0.7824, 0.8627, 0.7538, 0.7331, 0.8226, 0.859,
  0.6808, 0.7393, 0.8788, 0.7815, 0.6669, 0.4659, 0.5852, 0.6031, 0.5971, 0.7039, 0.6028, 0.7005, 0.5508, 0.575, 0.6375, 0.6943, 0.6652, 0.6808,
  0.6835, 0.7411, 0.7407, 0.6364, 0.6314, 0.6989, 0.5753, 0.7463, 0.6233, 0.8213, 0.7067, 0.6867, 0.7287, 0.6079, 0.8178, 0.7087, 0.6923, 0.7741,
  0.6383, 0.7153, 0.6783, 0.5439,
];

/**
 * `avatar/candidate-1..3.jpg`: three different people generated from the same
 * text descriptor as the master (`candidate-4.jpg`), never picked. The
 * hardest impostors the spike produced (spike README: "0.621, 0.648, 0.658").
 */
export const SPIKE_IMPOSTOR_COSMASTER: readonly number[] = [0.6575, 0.6208, 0.6479];

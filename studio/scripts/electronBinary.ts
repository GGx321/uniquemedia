/** The path of the `electron` npm package's binary, the way every Studio script finds it (the `electron` module's default export is that path). */
export async function electronBinary(): Promise<string> {
  const mod: unknown = await import("electron");
  const path = typeof mod === "string" ? mod : typeof mod === "object" && mod !== null && "default" in mod ? mod.default : null;
  if (typeof path !== "string") throw new Error("could not locate the Electron binary");
  return path;
}

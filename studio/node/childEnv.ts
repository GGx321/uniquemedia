/**
 * Variables the engine (and the ffmpeg it spawns) may see: locating
 * executables and temp/home folders, the locale, and what Windows needs for
 * sockets and crypto. Compared case-insensitively, since Windows variable names
 * are. One list for `studio/main/engineEnv.ts` and for every ffmpeg child (S4):
 * a secret never gets in by a second list drifting from the first.
 */
export const ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SYSTEMROOT",
  "WINDIR",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "COMSPEC",
  "PATHEXT",
]);

/**
 * `parent` reduced to the allowlist. An allowlist rather than a denylist:
 * OPENROUTER_* and every other secret, NODE_OPTIONS and ELECTRON_* never pass,
 * whatever the parent had. Names keep their spelling (`SystemRoot` stays so).
 */
export function allowlistedEnv(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && ENV_ALLOWLIST.has(name.toUpperCase())) env[name] = value;
  }
  return env;
}

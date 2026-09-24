/**
 * Variables the engine (and the ffmpeg it spawns, which inherits the engine's
 * environment) may see: locating executables and temp/home folders, the
 * locale, and what Windows needs for sockets and crypto. Compared
 * case-insensitively, since Windows variable names are.
 */
const ENGINE_ENV_ALLOWLIST = new Set([
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
 * The explicit, minimal environment for `utilityProcess.fork` (invariant 10).
 * An allowlist rather than a denylist: OPENROUTER_* and every other secret,
 * NODE_OPTIONS and ELECTRON_* never reach the engine, whatever the parent had.
 */
export function engineEnv(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && ENGINE_ENV_ALLOWLIST.has(name.toUpperCase())) env[name] = value;
  }
  return env;
}

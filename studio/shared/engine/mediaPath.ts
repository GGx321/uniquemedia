// Paths the own-media boundary refuses before it touches the disk (3f.1). Pure strings: main calls it on what its dialog returned, and the
// engine calls it again on what main sent, as defence in depth. The platform is a parameter, so Windows' rules are tested on every OS.

const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * True for a path Windows would not read as a plain file: the device namespace (`\\.\COM1`, `\\.\pipe\x`, `\\?\GLOBALROOT\...`), a name
 * with an alternate data stream (`a.jpg:secret`), and a reserved device name (`CON`, `nul.txt`, `COM1`). False on every other platform,
 * where a colon and `CON` are ordinary.
 */
export function isUnsafePickedPath(path: string, platform: string): boolean {
  if (platform !== "win32") return false;
  const normal = path.replace(/\//g, "\\");
  if (normal.startsWith("\\\\.\\")) return true;
  let rest = normal;
  if (normal.startsWith("\\\\?\\")) {
    rest = normal.slice(4);
    if (/^UNC\\/i.test(rest)) rest = rest.slice(4);
    else if (/^[A-Za-z]:\\/.test(rest)) rest = rest.slice(2);
    else return true;
  } else if (/^[A-Za-z]:/.test(normal)) {
    rest = normal.slice(2);
  }
  if (rest.includes(":")) return true;
  // The drive-relative and UNC roots have no name of a device in them; every other segment is a name Windows may read as one.
  return rest.split("\\").some((segment) => RESERVED_DEVICE_NAME.test(segment.split(".")[0]?.trimEnd() ?? ""));
}

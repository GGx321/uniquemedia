// electron-builder afterPack hook.
//
// Without a Developer ID certificate electron-builder skips signing entirely,
// which leaves the Electron binary with its original linker-signed signature
// while the bundle around it has changed. macOS then refuses to launch the app
// with "the file is damaged" instead of the usual unidentified-developer
// prompt. An ad-hoc signature over the finished bundle keeps it launchable.
//
// This is not a substitute for Developer ID signing plus notarization: a
// downloaded ad-hoc build still needs the quarantine flag cleared or an
// explicit "Open Anyway" from the user.

const { execFileSync } = require("node:child_process");
const { readdirSync, statSync } = require("node:fs");
const path = require("node:path");

function isMachO(file) {
  try {
    return execFileSync("file", ["-b", file], { encoding: "utf8" }).includes("Mach-O");
  } catch {
    return false;
  }
}

function collectExecutables(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      collectExecutables(full, found);
      continue;
    }
    if (!entry.isFile()) continue;
    if ((statSync(full).mode & 0o111) === 0) continue;
    if (isMachO(full)) found.push(full);
  }
  return found;
}

function sign(target) {
  execFileSync("codesign", ["--force", "--sign", "-", target], { stdio: "inherit" });
}

exports.default = async function signAdHoc(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const unpacked = path.join(appPath, "Contents", "Resources", "app.asar.unpacked");

  // Helper binaries shipped outside the asar (ffmpeg, ffprobe, exiftool) run as
  // their own processes, so each one needs its own signature. They must be
  // signed before the bundle, otherwise the bundle seal breaks.
  let unpackedBinaries = [];
  try {
    unpackedBinaries = collectExecutables(unpacked);
  } catch {
    // no unpacked resources in this build
  }
  for (const binary of unpackedBinaries) sign(binary);

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: "inherit",
  });

  console.log(`  • ad-hoc signed ${path.basename(appPath)} (${unpackedBinaries.length} helper binaries)`);
};

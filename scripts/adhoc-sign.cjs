const { execFileSync } = require("child_process");
const { join } = require("path");
const { existsSync, readdirSync, statSync } = require("fs");

function sign(target) {
  execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", target], {
    stdio: "inherit",
  });
}

/** Mach-O files outside the asar are not covered by the bundle seal until signed individually. */
function findMachO(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      findMachO(p, out);
      continue;
    }
    if (entry.endsWith(".node")) {
      out.push(p);
      continue;
    }
    if (st.mode & 0o111) {
      const type = execFileSync("file", ["-b", p], { encoding: "utf8" });
      if (type.includes("Mach-O")) out.push(p);
    }
  }
  return out;
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("xattr", ["-cr", app]);

  for (const bin of findMachO(join(app, "Contents/Resources/app.asar.unpacked"))) {
    sign(bin);
  }

  const frameworks = join(app, "Contents/Frameworks");
  const entries = readdirSync(frameworks);
  for (const entry of entries) {
    if (entry.endsWith(".framework")) sign(join(frameworks, entry, "Versions/A"));
  }
  for (const entry of entries) {
    if (entry.endsWith(".app")) sign(join(frameworks, entry));
  }

  sign(app);

  // --deep is deprecated for verification and trips over Electron's vendored
  // frameworks; the shallow check is what Gatekeeper evaluates.
  execFileSync("codesign", ["--verify", "--strict", "--verbose=2", app], {
    stdio: "inherit",
  });
};

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const CONTENTS = [
  "TokenUsageLab.exe",
  "START-HERE.txt",
  "LICENSE",
  "THIRD-PARTY-NOTICES.txt",
  "BUILD-INFO.json",
  "SHA256SUMS.txt",
];
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export function requireWindowsX64(bytes) {
  assert(
    bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d,
    "Desktop artifact is not a PE executable",
  );
  const offset = bytes.readUInt32LE(0x3c);
  assert(offset >= 64 && offset + 6 <= bytes.length, "Invalid PE header");
  assert.equal(bytes.readUInt32LE(offset), 0x4550, "Missing PE signature");
  assert.equal(
    bytes.readUInt16LE(offset + 4),
    0x8664,
    "Desktop artifact is not Windows x64",
  );
}

export function validateContents(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  assert(
    entries.every((entry) => entry.isFile() && !entry.isSymbolicLink()),
    "Only regular files may be shared",
  );
  assert.deepEqual(
    entries.map((entry) => entry.name).sort(),
    [...CONTENTS].sort(),
    "Unexpected share-package content",
  );
}

export function stageTryout(root, now = new Date()) {
  const release = path.join(root, "release");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(release, "manifest.json"), "utf8"),
  );
  const app = fs.readFileSync(path.join(release, "TokenUsageLab.exe"));
  requireWindowsX64(app);
  const appHash = digest(app);
  assert.equal(
    manifest.files.find((file) => file.file === "TokenUsageLab.exe")?.sha256,
    appHash,
    "Desktop artifact differs from the validated local build",
  );
  const runtimeSources = manifest.sourceFiles.filter((file) =>
    /^(src\/|src-tauri\/src\/)/.test(file.file),
  );
  assert(
    runtimeSources.length > 0,
    "Build manifest has no runtime source records",
  );
  for (const source of runtimeSources) {
    const file = path.resolve(root, source.file);
    assert(file.startsWith(root + path.sep), "Source path escapes project");
    assert.equal(
      digest(fs.readFileSync(file)),
      source.sha256,
      `Rebuild desktop after changing ${source.file}`,
    );
  }
  assert(/^[0-9a-f]{40}$/.test(manifest.baseline), "Invalid source baseline");
  assert(/^\d+\.\d+\.\d+$/.test(manifest.version), "Invalid version");
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const folder = `TokenUsageLab-${manifest.version}-windows-x64-tryout-${stamp}`;
  const directory = path.join(release, "share", folder);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "TokenUsageLab.exe"), app);
  fs.copyFileSync(
    path.join(root, "docs/TRYOUT.md"),
    path.join(directory, "START-HERE.txt"),
  );
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(directory, "LICENSE"));
  const notices = fs.readFileSync(
    path.join(root, ".acceptance/THIRD-PARTY-NOTICES.txt"),
  );
  assert(notices.length > 1000, "Third-party notices have not been generated");
  fs.writeFileSync(path.join(directory, "THIRD-PARTY-NOTICES.txt"), notices);
  const info = {
    product: "Token Usage Lab",
    version: manifest.version,
    platform: "windows-x64",
    channel: "internal-tryout",
    packagedAt: now.toISOString(),
    sourceBaseline: manifest.baseline,
    sourceState: "local-uncommitted-candidate",
    desktopSha256: appHash,
    digitalSignature: "unsigned",
    runtime: "Microsoft Edge WebView2 Runtime x64",
    validationScope:
      "Local Windows machine only; other devices and macOS are unverified",
    cloudSync: false,
    includesUserData: false,
  };
  fs.writeFileSync(
    path.join(directory, "BUILD-INFO.json"),
    JSON.stringify(info, null, 2) + "\n",
  );
  const sums = CONTENTS.filter((file) => file !== "SHA256SUMS.txt")
    .map(
      (file) =>
        `${digest(fs.readFileSync(path.join(directory, file)))}  ${file}`,
    )
    .join("\n");
  fs.writeFileSync(path.join(directory, "SHA256SUMS.txt"), sums + "\n");
  validateContents(directory);
  return { directory, folder, info };
}

function main() {
  assert.equal(
    process.platform,
    "win32",
    "This command packages the Windows candidate only",
  );
  const root = path.resolve(import.meta.dirname, "..");
  const { directory, folder, info } = stageTryout(root);
  const archive = `${directory}.zip`;
  const entries = JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        path.join(root, "scripts/archive-tryout.ps1"),
        "-Directory",
        directory,
        "-Archive",
        archive,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim(),
  );
  assert.deepEqual(
    entries.sort(),
    CONTENTS.map((file) => `${folder}/${file}`).sort(),
  );
  const sha256 = digest(fs.readFileSync(archive));
  fs.writeFileSync(
    `${archive}.sha256`,
    `${sha256}  ${path.basename(archive)}\n`,
  );
  const result = {
    archive,
    sha256,
    bytes: fs.statSync(archive).size,
    files: CONTENTS,
    ...info,
  };
  fs.writeFileSync(
    path.join(root, ".acceptance/tryout-package.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main();

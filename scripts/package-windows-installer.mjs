import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  digest,
  CONTENTS,
  requireWindowsX64,
  validateContents,
} from "./package-tryout.mjs";
import { validateSource } from "./export-build-source.mjs";

const root = path.resolve(import.meta.dirname, "..");
export const PIN = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dirname, "windows-installer-source.json"),
    "utf8",
  ),
);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sha = (file) => digest(fs.readFileSync(file));

export function nsisExecutableHash(app) {
  // Tauri 2.10.1 changes only this bundle marker before packaging, then restores its input.
  const marker = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK");
  const offset = app.indexOf(marker);
  assert(
    offset >= 0 && app.indexOf(marker, offset + 1) === -1,
    "Expected one unpatched Tauri bundle marker",
  );
  const expected = Buffer.from(app);
  Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS").copy(expected, offset);
  return digest(expected);
}

function runtimeFiles(root) {
  const files = [];
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), {
      withFileTypes: true,
    })) {
      assert(!entry.isSymbolicLink(), "Runtime symlinks are not allowed");
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else {
        assert(entry.isFile(), "Expected a regular runtime source");
        files.push(file);
      }
    }
  }
  walk("src");
  walk("src-tauri/src");
  return files.sort();
}

export function stageInstaller(
  root,
  portable,
  provenance,
  commit,
  expected = PIN,
) {
  assert(
    /^[0-9a-f]{40}$/.test(commit),
    "Expected a full packaging source commit",
  );
  validateContents(portable);
  const read = (file) => fs.readFileSync(path.join(portable, file));
  const app = read("TokenUsageLab.exe");
  requireWindowsX64(app);
  assert.equal(
    digest(app),
    expected.executableSha256,
    "Application differs from the accepted portable build",
  );
  assert.equal(
    nsisExecutableHash(app),
    expected.installedExecutableSha256,
    "Unexpected NSIS bundle marker result",
  );
  const records = read("SHA256SUMS.txt")
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line);
      assert(match, "Invalid portable checksum entry");
      return { file: match[2], sha256: match[1] };
    });
  assert.deepEqual(
    records.map((entry) => entry.file).sort(),
    CONTENTS.filter((file) => file !== "SHA256SUMS.txt").sort(),
  );
  for (const record of records)
    assert.equal(digest(read(record.file)), record.sha256, record.file);
  const appInfo = JSON.parse(read("BUILD-INFO.json").toString("utf8"));
  assert.equal(appInfo.version, "0.1.0");
  assert.equal(appInfo.platform, "windows-x64");
  assert.equal(appInfo.includesUserData, false);
  assert.equal(appInfo.cloudSync, false);
  assert.equal(appInfo.desktopSha256, expected.executableSha256);
  assert.equal(digest(read("LICENSE")), sha(path.join(root, "LICENSE")));
  const sources = provenance.sourceCorrespondence.windows.records;
  assert.equal(sources.length, expected.runtimeFileCount);
  assert.deepEqual(
    sources.map((entry) => entry.file).sort(),
    runtimeFiles(root),
    "Runtime sources changed; rebuild the application instead of repackaging",
  );
  for (const source of sources) {
    assert(
      /^(src\/|src-tauri\/src\/)/.test(source.file) &&
        !source.file.includes("..") &&
        !source.file.includes("\\"),
    );
    assert.equal(
      sha(path.join(root, source.file)),
      source.sha256,
      `Runtime source changed: ${source.file}`,
    );
  }
  const resources = new Map([
    ["LICENSE", read("LICENSE")],
    ["THIRD-PARTY-NOTICES.txt", read("THIRD-PARTY-NOTICES.txt")],
    [
      "README.md",
      fs.readFileSync(path.join(root, "docs/WINDOWS-INSTALLER.md")),
    ],
    ["APP-BUILD-INFO.json", read("BUILD-INFO.json")],
    [
      "INSTALLER-INFO.json",
      Buffer.from(
        JSON.stringify(
          {
            product: "Token Usage Lab",
            applicationVersion: "0.1.0",
            distributionTag: "v0.1.0-beta.2",
            packagingSourceCommit: commit,
            originalRelease: expected.tag,
            originalArchiveSha256: expected.archiveSha256,
            executableSha256: expected.executableSha256,
            installedExecutableSha256: expected.installedExecutableSha256,
            mode: "Tauri NSIS packaging of the accepted executable, without recompilation",
            binaryDifference:
              "Only the three-byte bundle marker changes from UNK to NSS; all other bytes must match",
            markerSource:
              "https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.10.1/crates/tauri-bundler/src/bundle.rs",
            installationScope: "current-user",
            digitalSignature: "unsigned",
            includesUserData: false,
          },
          null,
          2,
        ) + "\n",
      ),
    ],
  ]);
  for (const [file, bytes] of resources) validateSource(file, bytes);
  const resourceDirectory = path.join(root, ".acceptance/installer-resources");
  const executable = path.join(
    root,
    "src-tauri/target/release/token-usage-lab.exe",
  );
  assert(
    !fs.existsSync(resourceDirectory) && !fs.existsSync(executable),
    "Never overwrite a prepared installer input",
  );
  fs.mkdirSync(resourceDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, app, { flag: "wx" });
  for (const [file, bytes] of resources)
    fs.writeFileSync(path.join(resourceDirectory, file), bytes, { flag: "wx" });
  return {
    result: "PASS",
    sourceCommit: commit,
    runtimeFiles: sources.length,
    executableSha256: digest(app),
    resources: [...resources.keys()],
  };
}

async function download(file, expectedHash) {
  const url = `https://github.com/${PIN.repository}/releases/download/${PIN.tag}/${file}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  assert(response.ok, `Download failed: ${file} (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(
    digest(bytes),
    expectedHash,
    `Download checksum mismatch: ${file}`,
  );
  return bytes;
}

async function main() {
  assert.equal(
    process.platform,
    "win32",
    "Windows is required for NSIS packaging",
  );
  const mode = process.argv[2];
  if (mode === "prepare") {
    const archive = await download(PIN.archive, PIN.archiveSha256);
    const provenance = JSON.parse(
      (await download("PROVENANCE.json", PIN.provenanceSha256)).toString(
        "utf8",
      ),
    );
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "usage-lab-installer-"),
    );
    const archivePath = path.join(temporary, "portable.zip");
    const extracted = path.join(temporary, "extracted");
    fs.writeFileSync(archivePath, archive, { flag: "wx" });
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        path.join(root, "scripts/extract-tryout.ps1"),
        "-Archive",
        archivePath,
        "-Directory",
        extracted,
      ],
      { windowsHide: true, stdio: "inherit" },
    );
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    console.log(
      JSON.stringify(
        stageInstaller(
          root,
          path.join(extracted, PIN.directory),
          provenance,
          commit,
        ),
      ),
    );
  } else if (mode === "stage") {
    const verification = readJson(
      path.join(root, ".acceptance/windows-installer-verification.json"),
    );
    assert.equal(verification.result, "PASS");
    const bundled = path.join(root, "src-tauri/target/release/bundle/nsis");
    const files = fs
      .readdirSync(bundled)
      .filter((file) => file.endsWith(".exe"));
    assert.equal(files.length, 1, "Expected exactly one NSIS installer");
    const installer = fs.readFileSync(path.join(bundled, files[0]));
    assert.equal(digest(installer), verification.installerSha256);
    const output = path.join(root, "release/windows-installer");
    assert(!fs.existsSync(output), "Never overwrite a staged installer");
    fs.mkdirSync(output, { recursive: true });
    const name = "TokenUsageLab-0.1.0-beta.2-windows-x64-Setup.exe";
    fs.writeFileSync(path.join(output, name), installer, { flag: "wx" });
    fs.copyFileSync(
      path.join(root, "docs/WINDOWS-INSTALLER.md"),
      path.join(output, "README-Windows.md"),
      fs.constants.COPYFILE_EXCL,
    );
    const info = readJson(
      path.join(root, ".acceptance/installer-resources/INSTALLER-INFO.json"),
    );
    fs.writeFileSync(
      path.join(output, "WINDOWS-INSTALLER-PROVENANCE.json"),
      JSON.stringify(
        {
          ...info,
          installer: name,
          installerSha256: digest(installer),
          verification,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    const sums =
      fs
        .readdirSync(output)
        .sort()
        .map((file) => `${sha(path.join(output, file))}  ${file}`)
        .join("\n") + "\n";
    fs.writeFileSync(
      path.join(output, "WINDOWS-INSTALLER-SHA256SUMS.txt"),
      sums,
      { flag: "wx" },
    );
    console.log(
      JSON.stringify({
        result: "PASS",
        installer: name,
        bytes: installer.length,
        sha256: digest(installer),
      }),
    );
  } else {
    throw new Error("Expected prepare or stage");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();

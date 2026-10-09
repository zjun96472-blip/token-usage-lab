import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageInstaller } from "../package-windows-installer.mjs";
import { digest, CONTENTS } from "../package-tryout.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-installer-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const portable = path.join(root, "portable");
  for (const dir of ["portable", "src", "src-tauri/src", "docs"])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  const app = Buffer.alloc(128);
  app.writeUInt16LE(0x5a4d, 0);
  app.writeUInt32LE(64, 0x3c);
  app.writeUInt32LE(0x4550, 64);
  app.writeUInt16LE(0x8664, 68);
  const expected = {
    executableSha256: digest(app),
    runtimeFileCount: 1,
    tag: "v0.1.0-beta.1",
    archiveSha256: "a".repeat(64),
  };
  const source = "export const value = 1;\n";
  fs.writeFileSync(path.join(root, "src/main.ts"), source);
  fs.writeFileSync(path.join(root, "LICENSE"), "MIT fixture\n");
  fs.writeFileSync(
    path.join(root, "docs/WINDOWS-INSTALLER.md"),
    "# Fixture manual\n",
  );
  for (const file of CONTENTS)
    fs.writeFileSync(path.join(portable, file), "Synthetic fixture\n");
  fs.writeFileSync(path.join(portable, "TokenUsageLab.exe"), app);
  fs.writeFileSync(path.join(portable, "LICENSE"), "MIT fixture\n");
  fs.writeFileSync(
    path.join(portable, "BUILD-INFO.json"),
    JSON.stringify({
      version: "0.1.0",
      platform: "windows-x64",
      includesUserData: false,
      cloudSync: false,
      desktopSha256: digest(app),
    }),
  );
  const checksums = () =>
    fs.writeFileSync(
      path.join(portable, "SHA256SUMS.txt"),
      CONTENTS.filter((file) => file !== "SHA256SUMS.txt")
        .map(
          (file) =>
            `${digest(fs.readFileSync(path.join(portable, file)))}  ${file}`,
        )
        .join("\n") + "\n",
    );
  checksums();
  const provenance = {
    sourceCorrespondence: {
      windows: { records: [{ file: "src/main.ts", sha256: digest(source) }] },
    },
  };
  const stage = () =>
    stageInstaller(root, portable, provenance, "b".repeat(40), expected);
  return { root, portable, provenance, stage, checksums };
}

test("installer preserves accepted executable bytes and includes only the manual and license resources", (t) => {
  const f = fixture(t);
  const result = f.stage();
  assert.equal(result.result, "PASS");
  assert.equal(
    digest(
      fs.readFileSync(
        path.join(f.root, "src-tauri/target/release/token-usage-lab.exe"),
      ),
    ),
    result.executableSha256,
  );
  assert.deepEqual(
    fs.readdirSync(path.join(f.root, ".acceptance/installer-resources")).sort(),
    [
      "APP-BUILD-INFO.json",
      "INSTALLER-INFO.json",
      "LICENSE",
      "README.md",
      "THIRD-PARTY-NOTICES.txt",
    ],
  );
  assert.throws(f.stage, /Never overwrite/);
});

test("installer rejects modified executable even if portable checksums are rewritten", (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.portable, "TokenUsageLab.exe"), "changed");
  f.checksums();
  assert.throws(f.stage, /differs from the accepted/);
});

test("installer refuses changed or added runtime sources instead of shipping stale application logic", (t) => {
  const changed = fixture(t);
  fs.appendFileSync(path.join(changed.root, "src/main.ts"), "// changed\n");
  assert.throws(changed.stage, /Runtime source changed/);
  const added = fixture(t);
  fs.writeFileSync(path.join(added.root, "src/new.ts"), "// new runtime\n");
  assert.throws(added.stage, /Runtime sources changed/);
});

test("installer rejects local data, duplicate checksums and unsafe source paths", (t) => {
  const extra = fixture(t);
  fs.writeFileSync(
    path.join(extra.portable, "usage.sqlite3"),
    "SYNTHETIC_PRIVATE_DATA",
  );
  assert.throws(extra.stage, /Unexpected share-package content/);
  const duplicate = fixture(t);
  const sums = path.join(duplicate.portable, "SHA256SUMS.txt");
  fs.appendFileSync(sums, fs.readFileSync(sums, "utf8").split("\n")[0] + "\n");
  assert.throws(duplicate.stage);
  const traversal = fixture(t);
  traversal.provenance.sourceCorrespondence.windows.records[0].file =
    "../private.ts";
  assert.throws(traversal.stage, /Runtime sources changed/);
});

test("installer refuses user-data metadata and altered upstream attribution", (t) => {
  const data = fixture(t);
  const infoFile = path.join(data.portable, "BUILD-INFO.json");
  const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
  info.includesUserData = true;
  fs.writeFileSync(infoFile, JSON.stringify(info));
  data.checksums();
  assert.throws(data.stage);
  const license = fixture(t);
  fs.writeFileSync(path.join(license.portable, "LICENSE"), "replacement\n");
  license.checksums();
  assert.throws(license.stage);
});

test("standard installer stays per-user, without custom scripts, signing claims or automatic updates", () => {
  const config = JSON.parse(
    fs.readFileSync(
      new URL("../../src-tauri/tauri.installer.conf.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(config.bundle.windows.nsis.installMode, "currentUser");
  assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.equal(config.bundle.windows.allowDowngrades, false);
  assert.equal(
    config.bundle.windows.webviewInstallMode.type,
    "downloadBootstrapper",
  );
  assert.equal(config.bundle.windows.nsis.template, undefined);
  assert.equal(config.bundle.windows.nsis.installerHooks, undefined);
  assert.deepEqual(config.bundle.windows.nsis.languages, [
    "SimpChinese",
    "English",
  ]);
  assert.equal(Object.keys(config.bundle.resources).length, 5);
});

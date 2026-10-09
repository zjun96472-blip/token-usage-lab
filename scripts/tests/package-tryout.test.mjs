import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONTENTS,
  digest,
  requireWindowsX64,
  stageTryout,
  validateContents,
} from "../package-tryout.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-package-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ["release", "docs", "src", ".acceptance"])
    fs.mkdirSync(path.join(root, dir));
  const exe = Buffer.alloc(128);
  exe.writeUInt16LE(0x5a4d, 0);
  exe.writeUInt32LE(64, 0x3c);
  exe.writeUInt32LE(0x4550, 64);
  exe.writeUInt16LE(0x8664, 68);
  fs.writeFileSync(path.join(root, "release/TokenUsageLab.exe"), exe);
  const source = "export const value = 1;\n";
  fs.writeFileSync(path.join(root, "src/main.ts"), source);
  fs.writeFileSync(
    path.join(root, "release/manifest.json"),
    JSON.stringify({
      version: "0.1.0",
      baseline: "a".repeat(40),
      files: [{ file: "TokenUsageLab.exe", sha256: digest(exe) }],
      sourceFiles: [{ file: "src/main.ts", sha256: digest(source) }],
    }),
  );
  fs.writeFileSync(path.join(root, "docs/TRYOUT.md"), "Trial guide\n");
  fs.writeFileSync(path.join(root, "LICENSE"), "MIT\n");
  fs.writeFileSync(
    path.join(root, ".acceptance/THIRD-PARTY-NOTICES.txt"),
    "License notice\n".repeat(100),
  );
  return root;
}

test("ships only the allowlisted desktop files, never CLI, source data or evidence", (t) => {
  const root = fixture(t);
  const secret = "SYNTHETIC_PRIVATE_DATA_MUST_NOT_SHIP";
  for (const name of [
    "release/usage-lab-cli.exe",
    "release/token-usage-lab.sqlite3",
    "release/README.md",
    ".acceptance/session.jsonl",
  ]) {
    fs.writeFileSync(path.join(root, name), secret);
  }
  const { directory, info } = stageTryout(root);
  assert.deepEqual(fs.readdirSync(directory).sort(), [...CONTENTS].sort());
  assert.equal(info.digitalSignature, "unsigned");
  assert.equal(info.cloudSync, false);
  assert.equal(info.includesUserData, false);
  for (const file of CONTENTS)
    assert(!fs.readFileSync(path.join(directory, file)).includes(secret));
  const lines = fs
    .readFileSync(path.join(directory, "SHA256SUMS.txt"), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, CONTENTS.length - 1);
  for (const line of lines) {
    const [hash, name] = line.split("  ");
    assert.equal(hash, digest(fs.readFileSync(path.join(directory, name))));
  }
});

test("rejects stale desktop builds when runtime source changes", (t) => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, "src/main.ts"), "// changed\n");
  assert.throws(() => stageTryout(root), /Rebuild desktop/);
});

test("rejects a binary that no longer matches its build manifest", (t) => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, "release/TokenUsageLab.exe"), "changed");
  assert.throws(() => stageTryout(root), /differs from the validated/);
});

test("rejects non-Windows or wrong-architecture artifacts", () => {
  assert.throws(
    () => requireWindowsX64(Buffer.from("not an executable")),
    /not a PE/,
  );
  const invalid = Buffer.alloc(128);
  invalid.writeUInt16LE(0x5a4d, 0);
  invalid.writeUInt32LE(64, 0x3c);
  invalid.writeUInt32LE(0x4550, 64);
  invalid.writeUInt16LE(0xaa64, 68);
  assert.throws(() => requireWindowsX64(invalid), /not Windows x64/);
});

test("rejects unexpected files and directories in the staged archive", (t) => {
  const { directory } = stageTryout(fixture(t));
  fs.writeFileSync(path.join(directory, "session.jsonl"), "private");
  assert.throws(() => validateContents(directory), /Unexpected share-package/);
  fs.unlinkSync(path.join(directory, "session.jsonl"));
  fs.mkdirSync(path.join(directory, "database"));
  assert.throws(() => validateContents(directory), /Only regular files/);
});

test("will not overwrite an existing share candidate", (t) => {
  const root = fixture(t);
  const now = new Date("2026-10-09T00:00:00Z");
  stageTryout(root, now);
  assert.throws(() => stageTryout(root, now), /EEXIST/);
});

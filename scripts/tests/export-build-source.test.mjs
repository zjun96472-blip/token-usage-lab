import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sourceFiles,
  validateSource,
  exportSource,
} from "../export-build-source.mjs";

const root = path.resolve(import.meta.dirname, "../..");
test("build snapshot is allowlisted and omits local evidence and histories", () => {
  const files = sourceFiles(root);
  assert(files.length > 50);
  for (const file of files) {
    assert(
      !/^(\.git\/|\.acceptance\/|release\/|node_modules\/|\.tooling\/)/.test(
        file,
      ),
    );
    assert(!/\.(db|sqlite3?|jsonl|log)$/.test(file));
    validateSource(file, fs.readFileSync(path.join(root, file)));
  }
});
test("credential and malformed source checks fail closed", () => {
  for (const text of [
    "-----BEGIN " + "PRIVATE KEY-----",
    "ghp_" + "a".repeat(30),
    "sk-" + "b".repeat(30),
    "\uFEFFtext",
    "\uFFFD",
    "\n".repeat(3001),
  ])
    assert.throws(() => validateSource("source.rs", Buffer.from(text)));
  assert.throws(() => validateSource("source.rs", Buffer.from([0xff])));
});
test("snapshot records byte-identical sources without overwriting a destination", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "usage-source-test-"),
  );
  const output = path.join(temporary, "snapshot");
  try {
    const result = exportSource(root, output, "a".repeat(40));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(output, "BUILD-SOURCE.json"), "utf8"),
    );
    assert.equal(result.files, manifest.files.length);
    for (const entry of manifest.files) {
      assert.deepEqual(
        fs.readFileSync(path.join(output, entry.file)),
        fs.readFileSync(path.join(root, entry.file)),
      );
    }
    assert(!fs.existsSync(path.join(output, ".git")));
    assert.throws(() => exportSource(root, output, "a".repeat(40)));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

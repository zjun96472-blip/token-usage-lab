import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { validateSource } from "./export-build-source.mjs";

export function validatePublicFile(file, bytes) {
  assert(!path.posix.isAbsolute(file) && !file.includes("\\"));
  assert(!file.split("/").some((part) => part === ".." || part === "."));
  assert(
    !/(^|\/)(\.git|\.acceptance|\.tooling|node_modules|dist|target|release)(\/|$)/.test(
      file,
    ),
    `Private or generated directory: ${file}`,
  );
  assert(
    !/(^|\/)\.env(?:\.|$)|\.(db|sqlite3?|jsonl|log|dmg|zip|exe|p12|pfx|pem)$/i.test(
      file,
    ),
    `Non-source artifact: ${file}`,
  );
  validateSource(file, bytes);
}

export function sourceRecords(root) {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .sort();
  assert(files.length > 50, "Expected a complete source checkout");
  return files
    .filter((file) => file !== "BUILD-SOURCE.json")
    .map((file) => {
      const absolute = path.join(root, file);
      const stat = fs.lstatSync(absolute);
      assert(
        stat.isFile() && !stat.isSymbolicLink(),
        `Non-regular source: ${file}`,
      );
      const bytes = fs.readFileSync(absolute);
      validatePublicFile(file, bytes);
      return {
        file,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      };
    });
}

function main() {
  const root = path.resolve(import.meta.dirname, "..");
  assert(process.argv.length <= 3, "Unexpected arguments");
  const mode = process.argv[2];
  assert(mode === undefined || mode === "--write-manifest", "Unknown mode");
  const files = sourceRecords(root);
  const manifestPath = path.join(root, "BUILD-SOURCE.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (mode === "--write-manifest") {
    manifest.sourceState = "public-release-source-snapshot";
    manifest.files = files;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  } else {
    assert.deepEqual(
      files,
      manifest.files,
      "Source manifest is stale or modified",
    );
  }
  console.log(
    JSON.stringify({
      result: "PASS",
      files: files.length,
      mode: mode ?? "verify",
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main();

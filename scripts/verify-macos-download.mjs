import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const labels = {
  "aarch64-apple-darwin": "apple-silicon",
  "x86_64-apple-darwin": "intel",
};
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function verifyMacDownload(directory, expected) {
  assert(/^[0-9a-f]{40}$/.test(expected.commit), "Expected a full CI commit");
  assert(
    /^[0-9a-f]{64}$/.test(expected.diskImageSha256),
    "Expected a disk-image hash from CI",
  );
  assert(labels[expected.target], "Expected a supported Mac target");
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  assert(
    entries.every((entry) => entry.isFile() && !entry.isSymbolicLink()),
    "Only regular delivery files are allowed",
  );
  const read = (name) => fs.readFileSync(path.join(directory, name));
  const info = JSON.parse(read("BUILD-INFO.json").toString("utf8"));
  assert.equal(info.product, "Token Usage Lab");
  assert(/^\d+\.\d+\.\d+$/.test(info.version), "Unexpected version");
  assert.equal(info.target, expected.target, "Wrong CPU architecture");
  assert.equal(info.sourceCommit, expected.commit, "Wrong source commit");
  assert.equal(
    info.diskImageSha256,
    expected.diskImageSha256,
    "Package metadata differs from CI",
  );
  assert.equal(info.channel, "internal-tryout");
  assert.equal(info.digitalSignature, "ad-hoc-not-Developer-ID");
  assert.equal(info.notarized, false);
  assert.equal(info.includesUserData, false);
  assert.equal(info.cloudSync, false);
  assert.equal(
    info.attempts.length,
    2,
    "Both native startups must be recorded",
  );
  assert.deepEqual(
    info.attempts.map((attempt) => attempt.attempt),
    [1, 2],
  );
  assert(
    info.attempts.every(
      (attempt) => attempt.processAlive && attempt.ledgerCreated,
    ),
    "Native startup failed",
  );

  const image = `TokenUsageLab-${info.version}-macos-${labels[info.target]}-internal.dmg`;
  const files = [
    image,
    "BUILD-INFO.json",
    "START-HERE.txt",
    "LICENSE",
    "THIRD-PARTY-NOTICES.txt",
  ];
  if (expected.manualSha256 !== undefined) {
    assert(
      /^[0-9a-f]{64}$/.test(expected.manualSha256),
      "Expected a manual hash",
    );
    files.push("README.md");
    assert.equal(
      digest(read("README.md")),
      expected.manualSha256,
      "The packaged manual differs from the approved document",
    );
  }
  assert.deepEqual(
    entries.map((entry) => entry.name).sort(),
    [...files, "SHA256SUMS.txt"].sort(),
    "Unexpected delivery content",
  );
  const records = read("SHA256SUMS.txt")
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^([0-9a-f]{64})  (.+)$/);
      assert(match, "Malformed checksum record");
      return { sha256: match[1], file: match[2] };
    });
  assert.deepEqual(
    records.map((record) => record.file).sort(),
    [...files].sort(),
    "Incomplete or repeated checksum records",
  );
  for (const record of records)
    assert.equal(
      digest(read(record.file)),
      record.sha256,
      `Checksum mismatch: ${record.file}`,
    );
  const bytes = read(image);
  assert.equal(
    digest(bytes),
    expected.diskImageSha256,
    "Disk image differs from the CI-verified artifact",
  );
  assert(
    bytes.length >= 512 &&
      bytes.toString("ascii", bytes.length - 512, bytes.length - 508) ===
        "koly",
    "Missing Apple UDIF disk-image footer",
  );
  assert.equal(
    bytes.readUInt32BE(bytes.length - 508),
    4,
    "Unsupported UDIF footer version",
  );
  for (const file of files.filter((name) => name !== image)) {
    const bytes = read(file);
    assert(
      !(bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191),
      `UTF-8 BOM: ${file}`,
    );
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  return {
    result: "PASS",
    image: path.join(directory, image),
    bytes: bytes.length,
    sha256: expected.diskImageSha256,
    target: info.target,
    commit: info.sourceCommit,
    operatingSystem: info.operatingSystem,
    notarized: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [directory, commit, target, diskImageSha256, manualSha256] =
    process.argv.slice(2);
  assert(
    directory,
    "Usage: node scripts/verify-macos-download.mjs DIRECTORY COMMIT TARGET CI_DISK_IMAGE_SHA256 [MANUAL_SHA256]",
  );
  console.log(
    JSON.stringify(
      verifyMacDownload(path.resolve(directory), {
        commit,
        target,
        diskImageSha256,
        manualSha256,
      }),
      null,
      2,
    ),
  );
}

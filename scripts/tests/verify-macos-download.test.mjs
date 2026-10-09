import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { digest, verifyMacDownload } from "../verify-macos-download.mjs";

function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "usage-macos-download-test-"),
  );
  const image = "TokenUsageLab-0.1.0-macos-apple-silicon-internal.dmg";
  // A synthetic footer exercises transfer checks, not native disk-image validation.
  const bytes = Buffer.alloc(1024);
  bytes.write("koly", 512);
  bytes.writeUInt32BE(4, 516);
  const manual = "# Token Usage Lab\n\nSynthetic manual fixture.\n";
  const expected = {
    commit: "a".repeat(40),
    target: "aarch64-apple-darwin",
    diskImageSha256: digest(bytes),
    manualSha256: digest(Buffer.from(manual)),
  };
  fs.writeFileSync(path.join(directory, "README.md"), manual);
  fs.writeFileSync(path.join(directory, image), bytes);
  fs.writeFileSync(
    path.join(directory, "BUILD-INFO.json"),
    JSON.stringify({
      product: "Token Usage Lab",
      version: "0.1.0",
      target: expected.target,
      sourceCommit: expected.commit,
      diskImageSha256: expected.diskImageSha256,
      channel: "internal-tryout",
      digitalSignature: "ad-hoc-not-Developer-ID",
      notarized: false,
      includesUserData: false,
      cloudSync: false,
      attempts: [1, 2].map((attempt) => ({
        attempt,
        processAlive: true,
        ledgerCreated: true,
      })),
    }),
  );
  for (const file of ["START-HERE.txt", "LICENSE", "THIRD-PARTY-NOTICES.txt"])
    fs.writeFileSync(path.join(directory, file), "Synthetic test fixture\n");
  const refresh = () =>
    fs.writeFileSync(
      path.join(directory, "SHA256SUMS.txt"),
      fs
        .readdirSync(directory)
        .filter((name) => name !== "SHA256SUMS.txt")
        .map(
          (name) =>
            `${digest(fs.readFileSync(path.join(directory, name)))}  ${name}`,
        )
        .join("\n") + "\n",
    );
  refresh();
  return {
    directory,
    expected,
    image,
    refresh,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test("accepts only the expected native artifact and exact delivery whitelist", () => {
  const data = fixture();
  try {
    assert.equal(
      verifyMacDownload(data.directory, data.expected).result,
      "PASS",
    );
    assert.throws(() =>
      verifyMacDownload(data.directory, {
        ...data.expected,
        target: "x86_64-apple-darwin",
      }),
    );
    assert.throws(() =>
      verifyMacDownload(data.directory, {
        ...data.expected,
        commit: "b".repeat(40),
      }),
    );
    fs.writeFileSync(
      path.join(data.directory, "private.sqlite3"),
      "not for sharing",
    );
    assert.throws(() => verifyMacDownload(data.directory, data.expected));
  } finally {
    data.cleanup();
  }
});

test("rejects a changed image even when its local checksum file is rewritten", () => {
  const data = fixture();
  try {
    const bytes = fs.readFileSync(path.join(data.directory, data.image));
    bytes[0] = 1;
    fs.writeFileSync(path.join(data.directory, data.image), bytes);
    data.refresh();
    assert.throws(() => verifyMacDownload(data.directory, data.expected));
  } finally {
    data.cleanup();
  }
});

test("rejects duplicated or missing checksum entries", () => {
  const data = fixture();
  try {
    const file = path.join(data.directory, "SHA256SUMS.txt");
    const sums = fs.readFileSync(file, "utf8");
    fs.appendFileSync(file, sums.split("\n")[0] + "\n");
    assert.throws(() => verifyMacDownload(data.directory, data.expected));
    fs.writeFileSync(file, sums.split("\n").slice(1).join("\n"));
    assert.throws(() => verifyMacDownload(data.directory, data.expected));
  } finally {
    data.cleanup();
  }
});

test("requires the approved manual even when local checksums are regenerated", () => {
  const data = fixture();
  try {
    const file = path.join(data.directory, "README.md");
    fs.writeFileSync(file, "Unapproved replacement manual\n");
    data.refresh();
    assert.throws(() => verifyMacDownload(data.directory, data.expected));
    fs.unlinkSync(file);
    data.refresh();
    assert.throws(() => verifyMacDownload(data.directory, data.expected));
  } finally {
    data.cleanup();
  }
});

test("retains strict verification of original six-file CI artifacts", () => {
  const data = fixture();
  try {
    const { manualSha256, ...original } = data.expected;
    assert.throws(() => verifyMacDownload(data.directory, original));
    fs.unlinkSync(path.join(data.directory, "README.md"));
    data.refresh();
    assert.equal(verifyMacDownload(data.directory, original).result, "PASS");
  } finally {
    data.cleanup();
  }
});

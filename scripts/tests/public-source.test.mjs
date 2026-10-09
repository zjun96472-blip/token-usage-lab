import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePublicFile } from "../audit-public-source.mjs";

test("public source rejects logs, databases, credentials and built artifacts", () => {
  for (const file of [
    ".acceptance/report.json",
    ".git/config",
    ".tooling/state.json",
    "logs/session.jsonl",
    "data/usage.sqlite3",
    "release/app.exe",
    ".env",
    ".env.local",
    "node_modules/pkg/index.js",
    "app.dmg",
    "secrets/identity.p12",
    "../private.json",
    "/private.json",
  ])
    assert.throws(() => validatePublicFile(file, Buffer.from("fixture\n")));
});

test("public source preserves UTF-8 and source-only boundaries", () => {
  validatePublicFile(
    "src/example.ts",
    Buffer.from("export const value = 1;\n"),
  );
  validatePublicFile("docs/manual.md", Buffer.from("# Manual\n"));
  assert.throws(() =>
    validatePublicFile("docs/manual.md", Buffer.from([239, 187, 191, 65])),
  );
  assert.throws(() =>
    validatePublicFile("src/example.rs", Buffer.from("\n".repeat(3001))),
  );
  assert.throws(() =>
    validatePublicFile("src/example.ts", Buffer.from("ghp_" + "a".repeat(30))),
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const revision = "a".repeat(40);
const licenseUrl = `https://raw.githubusercontent.com/example/library/${revision}/LICENSE`;
const pkg = {
  ecosystem: "npm",
  name: "fixture-library",
  version: "1.0.0",
  license: "MIT",
  repository: "https://github.com/example/library.git",
};

function fixture(pinned, available = true) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "usage-license-test-"),
  );
  fs.mkdirSync(path.join(directory, "scripts"));
  fs.mkdirSync(path.join(directory, ".acceptance"));
  fs.copyFileSync(
    path.join(root, "scripts/fetch-missing-notices.mjs"),
    path.join(directory, "scripts/fetch-missing-notices.mjs"),
  );
  fs.writeFileSync(
    path.join(directory, "scripts/license-revisions.json"),
    JSON.stringify(
      pinned
        ? {
            "npm:fixture-library@1.0.0": {
              revision,
              revisionBasis: "repository-license-snapshot-not-package-commit",
            },
          }
        : {},
    ),
  );
  fs.writeFileSync(
    path.join(directory, ".acceptance/missing-licenses.json"),
    JSON.stringify([pkg]),
  );
  const responses = {
    "https://registry.npmjs.org/fixture-library/1.0.0": JSON.stringify({
      gitHead: revision,
    }),
    ...(available
      ? { [licenseUrl]: "MIT License\nPermission is hereby granted." }
      : {}),
  };
  const bootstrap = `
    import fs from 'node:fs';
    import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {pathToFileURL} from 'node:url';
    const responses=${JSON.stringify(responses)};
    const calls=[];
    childProcess.execFileSync=(command,args)=>{
      const url=args.at(-1);
      calls.push(url);
      fs.writeFileSync('calls.json',JSON.stringify(calls));
      const body=responses[url];
      fs.writeFileSync(args[args.indexOf('--output')+1],body ?? 'Not Found');
      return JSON.stringify({http_code:body===undefined?'404':'200'});
    };
    syncBuiltinESMExports();
    await import(pathToFileURL(process.cwd()+'/scripts/fetch-missing-notices.mjs'));
  `;
  try {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", bootstrap],
      {
        cwd: directory,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      },
    );
    assert.ifError(result.error);
    return {
      result,
      calls: JSON.parse(
        fs.readFileSync(path.join(directory, "calls.json"), "utf8"),
      ),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("pinned licenses avoid mutable metadata and GitHub API quota", () => {
  const { result, calls } = fixture(true);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [licenseUrl]);
});

test("unknown package versions still resolve published metadata", () => {
  const { result, calls } = fixture(false);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [
    "https://registry.npmjs.org/fixture-library/1.0.0",
    licenseUrl,
  ]);
});

test("missing pinned licenses fail instead of silently following a newer revision", () => {
  const { result, calls } = fixture(true, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Pinned license unavailable/);
  assert(
    calls.every((url) =>
      url.startsWith(
        `https://raw.githubusercontent.com/example/library/${revision}/`,
      ),
    ),
  );
});

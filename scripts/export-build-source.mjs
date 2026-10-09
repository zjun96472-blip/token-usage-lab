import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FILES = [
  "LICENSE",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "postcss.config.cjs",
  "tailwind.config.cjs",
  "tsconfig.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "vitest.config.ts",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/build.rs",
  "src-tauri/tauri.conf.json",
  ".github/workflows/build-macos.yml",
  "scripts/vite-usage-bridge.ts",
  "scripts/check-source.mjs",
  "scripts/build-macos.sh",
  "scripts/export-rust-notices.sh",
  "scripts/generate-notices.mjs",
  "scripts/fetch-missing-notices.mjs",
  "scripts/license-revisions.json",
  "scripts/package-macos.mjs",
  "docs/MACOS-TRYOUT.md",
  "docs/MACOS-MANUAL.md",
];
const TREES = [
  ["src", /\.(tsx?|css|html|json)$/],
  ["src-tauri/src", /\.(rs|sql)$/],
  ["src-tauri/capabilities", /\.json$/],
  ["src-tauri/icons", /^(32x32\.png|128x128\.png|icon\.ico)$/],
  ["tests", /\.tsx?$/],
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function sourceFiles(root) {
  const files = [...FILES];
  const walk = (relative, extension) => {
    for (const entry of fs.readdirSync(path.join(root, relative), {
      withFileTypes: true,
    })) {
      assert(
        !entry.isSymbolicLink(),
        `Source symlinks are not allowed: ${relative}/${entry.name}`,
      );
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child, extension);
      else {
        assert(
          entry.isFile() && extension.test(entry.name),
          `Unexpected source file: ${child}`,
        );
        files.push(child);
      }
    }
  };
  for (const [directory, extension] of TREES) walk(directory, extension);
  return files.sort();
}

export function validateSource(relative, bytes) {
  if (/\.(png|ico)$/.test(relative)) return;
  assert(
    !(bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191),
    `UTF-8 BOM: ${relative}`,
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert(!text.includes("\uFFFD"), `Invalid text: ${relative}`);
  assert(
    !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text),
    `Private key in ${relative}`,
  );
  assert(
    !/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{24,})\b/.test(
      text,
    ),
    `Possible credential in ${relative}`,
  );
  assert(
    !/[A-Za-z]:[\\/]+Users[\\/]+[^\s\\/]+/i.test(text),
    `Developer-specific local path in ${relative}`,
  );
  if (/\.(rs|tsx?|mjs|cjs|sh|css|html|sql)$/.test(relative)) {
    assert(
      text.split("\n").length <= 3000,
      `Source exceeds 3000 lines: ${relative}`,
    );
  }
}

export function exportSource(root, output, baseline) {
  assert(
    /^[0-9a-f]{40}$/.test(baseline),
    "Expected a verified full source baseline",
  );
  assert(!fs.existsSync(output), "Build source destination already exists");
  const records = sourceFiles(root).map((file) => {
    const absolute = path.join(root, file);
    assert(fs.lstatSync(absolute).isFile(), `Expected a regular file: ${file}`);
    const bytes = fs.readFileSync(absolute);
    validateSource(file, bytes);
    return { file, bytes, sha256: hash(bytes) };
  });
  fs.mkdirSync(output, { recursive: true });
  for (const record of records) {
    const file = path.join(output, record.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, record.bytes, { flag: "wx" });
  }
  const manifest = {
    product: "Token Usage Lab",
    sourceBaseline: baseline,
    sourceState: "allowlisted-uncommitted-candidate-snapshot",
    excludes: [
      "git history",
      "local usage",
      "chat logs",
      "databases",
      "credentials",
      "existing build outputs",
    ],
    files: records.map(({ file, sha256, bytes }) => ({
      file,
      sha256,
      bytes: bytes.length,
    })),
  };
  fs.writeFileSync(
    path.join(output, "BUILD-SOURCE.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  fs.writeFileSync(
    path.join(output, ".gitignore"),
    "node_modules/\n.acceptance/\nsrc-tauri/target/\nsrc-tauri/gen/\ndist/\nrelease/\n*.tsbuildinfo\n*.log\n.env*\n",
    { flag: "wx" },
  );
  fs.writeFileSync(path.join(output, ".gitattributes"), "* -text\n", {
    flag: "wx",
  });
  return {
    output,
    files: records.length,
    bytes: records.reduce((sum, file) => sum + file.bytes.length, 0),
    sourceBaseline: baseline,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = path.resolve(import.meta.dirname, "..");
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const output = path.join(root, "release", `macos-build-source-${stamp}`);
  const baseline = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  console.log(JSON.stringify(exportSource(root, output, baseline), null, 2));
}

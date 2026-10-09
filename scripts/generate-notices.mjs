import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const evidence = path.join(root, ".acceptance");
const licenseName = /^(licen[cs]e|notice|copying|copyright)([-_.]|$)/i;
const entries = [];
const missing = [];
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function licenses(directory, depth = 0) {
  const results = [];
  if (!fs.existsSync(directory)) return results;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && licenseName.test(entry.name)) {
      const bytes = fs.readFileSync(file);
      if (bytes.length < 256000) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!text.includes("\0")) results.push(text.trim());
      }
    } else if (entry.isDirectory() && depth < 2) {
      results.push(...licenses(file, depth + 1));
    }
  }
  return [...new Set(results)];
}

function add(pkg, directory, ecosystem) {
  let texts = licenses(directory);
  const cached = path.join(
    evidence,
    "license-sources",
    `${ecosystem}-${pkg.name.replaceAll("/", "_")}@${pkg.version}.json`,
  );
  if (!texts.length && fs.existsSync(cached)) {
    const record = readJson(cached);
    texts = record.files.map(
      (file) =>
        `License source: ${file.url}\nRevision basis: ${record.revisionBasis}\n\n${file.text}`,
    );
  }
  if (!texts.length) {
    const vcsFile = path.join(directory, ".cargo_vcs_info.json");
    missing.push({
      ecosystem,
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      repository: pkg.repository,
      vcs: fs.existsSync(vcsFile) ? readJson(vcsFile) : undefined,
    });
  }
  entries.push({
    ecosystem,
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    texts,
  });
}

function resolvePackage(name, from) {
  const resolver = createRequire(path.join(from, "package.json"));
  for (const directory of resolver.resolve.paths(name) ?? []) {
    const file = path.join(directory, name, "package.json");
    if (fs.existsSync(file)) return fs.realpathSync(path.dirname(file));
  }
  return null;
}

const visited = new Set();
function visit(directory) {
  const pkg = readJson(path.join(directory, "package.json"));
  const key = `${pkg.name}@${pkg.version}`;
  if (visited.has(key)) return;
  visited.add(key);
  if (directory !== root) add(pkg, directory, "npm");
  const mandatory = pkg.dependencies ?? {};
  const optional = pkg.optionalDependencies ?? {};
  for (const name of Object.keys({
    ...mandatory,
    ...optional,
    ...pkg.peerDependencies,
  })) {
    const child = resolvePackage(name, directory);
    if (child) visit(child);
    else if (name in mandatory && !(name in optional))
      throw new Error(`Missing dependency: ${name}`);
  }
}
visit(root);

const metadata = readJson(path.join(evidence, "rust-metadata.json"));
const nativeRoot = fs.mkdtempSync(path.join(evidence, "rust-notices-"));
execFileSync("tar", [
  "-xf",
  path.join(evidence, "rust-licenses.tar"),
  "-C",
  nativeRoot,
]);
const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
const seen = new Set();
function visitRust(id) {
  if (seen.has(id)) return;
  seen.add(id);
  const pkg = packages.get(id);
  if (pkg.source) {
    const relative = pkg.manifest_path.split("/registry/src/")[1];
    if (!relative)
      throw new Error(`Unknown crate source location: ${pkg.name}`);
    add(pkg, path.join(nativeRoot, path.posix.dirname(relative)), "cargo");
  }
  for (const dep of nodes.get(id)?.deps ?? []) {
    if (dep.dep_kinds.some((kind) => kind.kind !== "dev")) visitRust(dep.pkg);
  }
}
visitRust(metadata.resolve.root);

if (missing.length) {
  fs.writeFileSync(
    path.join(evidence, "missing-licenses.json"),
    JSON.stringify(missing, null, 2),
  );
  throw new Error(
    `Missing license text: ${missing.map((pkg) => `${pkg.ecosystem}:${pkg.name}@${pkg.version}`).join(", ")}`,
  );
}

entries.sort((a, b) =>
  `${a.ecosystem}:${a.name}:${a.version}`.localeCompare(
    `${b.ecosystem}:${b.name}:${b.version}`,
  ),
);
const text = [
  "Token Usage Lab - Third-party notices",
  "The application's upstream MIT license is supplied separately in LICENSE.",
  "The following notices include runtime dependencies and their build-time dependencies.",
  ...entries.map(
    (entry) =>
      `\n${"=".repeat(72)}\n${entry.ecosystem}: ${entry.name}@${entry.version}\nLicense: ${entry.license ?? "See below"}\nUnmodified upstream source: ${entry.ecosystem === "cargo" ? `https://crates.io/api/v1/crates/${entry.name}/${entry.version}/download` : `https://www.npmjs.com/package/${entry.name}/v/${entry.version}`}\n\n${entry.texts.join("\n\n")}`,
  ),
].join("\n");
fs.writeFileSync(
  path.join(evidence, "THIRD-PARTY-NOTICES.txt"),
  text + "\n",
  "utf8",
);
console.log(
  JSON.stringify({
    packages: entries.length,
    bytes: Buffer.byteLength(text),
    output: ".acceptance/THIRD-PARTY-NOTICES.txt",
  }),
);

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..", ".acceptance");
const packages = JSON.parse(
  fs.readFileSync(path.join(root, "missing-licenses.json"), "utf8"),
);
const output = path.join(root, "license-sources");
fs.mkdirSync(output, { recursive: true });
const cache = new Map();
const pins = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "license-revisions.json"), "utf8"),
);

async function get(url) {
  if (!cache.has(url)) {
    const temporary = path.join(
      output,
      `${createHash("sha256").update(url).digest("hex")}.download`,
    );
    const response = JSON.parse(
      execFileSync(
        process.platform === "win32" ? "curl.exe" : "curl",
        [
          "--silent",
          "--show-error",
          "--location",
          "--proto",
          "=https",
          "--max-time",
          "20",
          "--retry",
          "2",
          "--retry-all-errors",
          "--max-filesize",
          "256000",
          "--output",
          temporary,
          "--write-out",
          '{"http_code":"%{http_code}"}',
          url,
        ],
        { encoding: "utf8", windowsHide: true },
      ),
    );
    if (response.http_code !== "200" && response.http_code !== "404")
      throw new Error(`License request failed: ${response.http_code} ${url}`);
    const text =
      response.http_code === "200" ? fs.readFileSync(temporary, "utf8") : null;
    assert(
      !text || Buffer.byteLength(text) <= 256000,
      "License response too large",
    );
    cache.set(url, text);
  }
  return cache.get(url);
}

for (const pkg of packages) {
  const file = path.join(
    output,
    `${pkg.ecosystem}-${pkg.name.replaceAll("/", "_")}@${pkg.version}.json`,
  );
  if (fs.existsSync(file)) continue;
  if (pkg.ecosystem === "cargo" && pkg.license.includes("Apache-2.0")) {
    const text = fs.readFileSync(
      path.resolve(
        root,
        "..",
        "node_modules/@tauri-apps/api/LICENSE_APACHE-2.0",
      ),
      "utf8",
    );
    assert(text.includes("Apache License"), "Standard Apache license missing");
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          name: pkg.name,
          version: pkg.version,
          revisionBasis:
            "Apache-2.0-license-choice-from-published-package-metadata",
          files: [
            { url: "https://www.apache.org/licenses/LICENSE-2.0.txt", text },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      `${pkg.ecosystem}:${pkg.name}@${pkg.version}: declared Apache-2.0 license choice`,
    );
    continue;
  }
  const pin = pins[`${pkg.ecosystem}:${pkg.name}@${pkg.version}`];
  let sha = pin?.revision ?? pkg.vcs?.git?.sha1;
  let revisionBasis = pin?.revisionBasis ?? "published-package-or-version-tag";
  if (pkg.ecosystem === "npm" && !pin) {
    const metadata = JSON.parse(
      await get(
        `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`,
      ),
    );
    sha = metadata.gitHead;
  }
  const repoValue =
    typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const repo = new URL(
    repoValue.replace(/^git\+/, "").replace(/\.git\/?$/, ""),
  );
  assert.equal(repo.hostname, "github.com");
  assert.equal(repo.protocol, "https:");
  const repoPath = repo.pathname.replace(/^\/|\/$/g, "");
  assert(/^[\w.-]+\/[\w.-]+$/.test(repoPath), "Unexpected repository path");
  if (!sha) {
    for (const tag of [`v${pkg.version}`, pkg.version]) {
      const ref = await get(
        `https://api.github.com/repos/${repoPath}/git/ref/tags/${tag}`,
      );
      if (!ref) continue;
      let object = JSON.parse(ref).object;
      if (object.type === "tag") {
        object = JSON.parse(
          await get(
            `https://api.github.com/repos/${repoPath}/git/tags/${object.sha}`,
          ),
        ).object;
      }
      if (object.type === "commit") {
        sha = object.sha;
        break;
      }
    }
  }
  const files = [];
  async function readLicense() {
    if (!sha) return;
    assert(/^[0-9a-f]{40}$/.test(sha), `Invalid source revision: ${pkg.name}`);
    for (const name of [
      "LICENSE",
      "LICENSE.md",
      "LICENSE.txt",
      "LICENSE-MIT",
      "LICENSE-APACHE",
      "LICENCE",
      "COPYING",
    ]) {
      const url = `https://raw.githubusercontent.com/${repoPath}/${sha}/${name}`;
      const text = await get(url);
      if (text && /license|permission|copyright/i.test(text)) {
        files.push({ url, text });
        break;
      }
    }
  }
  await readLicense();
  assert(!pin || files.length, `Pinned license unavailable: ${pkg.name}`);
  if (!files.length && pkg.license.includes("Apache-2.0")) {
    const url = "https://www.apache.org/licenses/LICENSE-2.0.txt";
    const text = await get(url);
    assert(
      text?.includes("Apache License"),
      "Canonical Apache license missing",
    );
    files.push({ url, text });
    revisionBasis = "Apache-2.0-license-choice-from-published-package-metadata";
  }
  if (!files.length) {
    const commits = JSON.parse(
      await get(`https://api.github.com/repos/${repoPath}/commits?per_page=1`),
    );
    sha = commits[0]?.sha;
    revisionBasis = "repository-license-snapshot-not-package-commit";
    await readLicense();
  }
  assert(
    files.length,
    `No upstream license found for ${pkg.name}@${pkg.version}`,
  );
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        revision: sha,
        revisionBasis,
        files,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `${pkg.ecosystem}:${pkg.name}@${pkg.version}: ${files.length} pinned license file(s)`,
  );
}

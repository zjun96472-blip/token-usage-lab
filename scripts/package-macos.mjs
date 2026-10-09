import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(import.meta.dirname, "..");
const evidence = path.join(root, ".acceptance");
const target = process.argv[2];
const architectures = {
  "aarch64-apple-darwin": { native: "arm64", label: "apple-silicon" },
  "x86_64-apple-darwin": { native: "x64", label: "intel" },
};
const architecture = architectures[target];
const sha256 = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", timeout: 120000 }).trim();

function appPid(binary) {
  const expected = fs.realpathSync(binary);
  for (const line of run("/bin/ps", ["-axo", "pid=,comm="]).split("\n")) {
    const entry = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!entry) continue;
    try {
      if (fs.realpathSync(entry[2]) === expected) return Number(entry[1]);
    } catch {
      // Most processes are unrelated to the application under test.
    }
  }
  return null;
}

async function startup(app, binary, attempt) {
  const log = path.join(evidence, `macos-startup-${attempt}.log`);
  const descriptor = fs.openSync(log, "wx");
  const launcher = spawn("/usr/bin/open", ["-n", "-W", app], {
    stdio: ["ignore", descriptor, descriptor],
  });
  let launchError;
  launcher.on("error", (error) => {
    launchError = error;
  });
  fs.closeSync(descriptor);
  let pid;
  try {
    for (let elapsed = 0; elapsed < 30; elapsed++) {
      if (launchError) throw launchError;
      pid = appPid(binary);
      if (pid) break;
      await delay(1000);
    }
    assert(pid, "The installed app did not start through Launch Services");
    await delay(12000);
    assert.equal(appPid(binary), pid, "The app exited during startup");
    const ledger = path.join(
      os.homedir(),
      "Library/Application Support/TokenUsageLab/token-usage-lab.sqlite3",
    );
    assert(fs.existsSync(ledger), "The isolated local ledger was not created");
    const screenshot = path.join(evidence, `macos-startup-${attempt}.png`);
    run("/usr/sbin/screencapture", ["-x", screenshot]);
    assert(fs.statSync(screenshot).size > 1000, "Startup screenshot is empty");
    fs.appendFileSync(
      log,
      "PASS: native app stayed running and created its isolated ledger.\n",
    );
    return {
      attempt,
      processAlive: true,
      ledgerCreated: true,
      screenshot: path.basename(screenshot),
    };
  } finally {
    const current = appPid(binary);
    if (current) {
      process.kill(current, "SIGTERM");
      for (let wait = 0; wait < 50 && appPid(binary); wait++) await delay(100);
      if (appPid(binary) === current) process.kill(current, "SIGKILL");
    }
    if (launcher.exitCode === null) launcher.kill("SIGTERM");
  }
}

async function main() {
  assert.equal(
    process.platform,
    "darwin",
    "A real Mac is required for package acceptance",
  );
  assert(architecture, "Expected an Apple Silicon or Intel target");
  assert.equal(
    process.arch,
    architecture.native,
    "Run acceptance on the matching native architecture",
  );
  fs.mkdirSync(evidence, { recursive: true });
  const version = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).version;
  assert(/^\d+\.\d+\.\d+$/.test(version), "Unexpected package version");
  const bundle = path.join(root, "src-tauri/target", target, "release/bundle");
  const images = fs
    .readdirSync(path.join(bundle, "dmg"))
    .filter((name) => name.endsWith(".dmg"));
  assert.equal(images.length, 1, "Expected exactly one final disk image");
  const dmg = path.join(bundle, "dmg", images[0]);
  run("/usr/bin/hdiutil", ["verify", dmg]);

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "token-usage-macos-"),
  );
  const mount = path.join(temporary, "mounted");
  const app = path.join(temporary, "Token Usage Lab.app");
  fs.mkdirSync(mount);
  let mounted = false;
  try {
    run("/usr/bin/hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mount,
      dmg,
    ]);
    mounted = true;
    run("/usr/bin/ditto", [path.join(mount, "Token Usage Lab.app"), app]);
  } finally {
    if (mounted) run("/usr/bin/hdiutil", ["detach", mount]);
  }
  const plist = path.join(app, "Contents/Info.plist");
  const property = (name) =>
    run("/usr/bin/plutil", ["-extract", name, "raw", "-o", "-", plist]);
  assert.equal(property("CFBundleIdentifier"), "local.tokenusagelab.desktop");
  assert.equal(property("CFBundleExecutable"), "token-usage-lab");
  assert.equal(property("CFBundleShortVersionString"), version);
  assert.deepEqual(
    fs.readdirSync(path.join(app, "Contents/MacOS")).sort(),
    ["token-usage-lab"],
    "The desktop bundle must not contain development tools",
  );
  const binary = path.join(app, "Contents/MacOS/token-usage-lab");
  assert.equal(
    run("/usr/bin/lipo", ["-archs", binary]),
    process.arch === "arm64" ? "arm64" : "x86_64",
  );
  const original = path.join(
    bundle,
    "macos/Token Usage Lab.app/Contents/MacOS/token-usage-lab",
  );
  assert.equal(
    sha256(binary),
    sha256(original),
    "The disk image contains a different app binary",
  );
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const signature = spawnSync(
    "/usr/bin/codesign",
    ["-dv", "--verbose=4", app],
    { encoding: "utf8" },
  );
  assert.equal(
    signature.status,
    0,
    "Could not inspect the application signature",
  );
  assert(
    signature.stderr.includes("Signature=adhoc"),
    "Expected the explicitly declared ad-hoc signature",
  );
  const resources = path.join(app, "Contents/Resources");
  for (const [source, destination] of [
    ["LICENSE", "LICENSE"],
    [".acceptance/THIRD-PARTY-NOTICES.txt", "THIRD-PARTY-NOTICES.txt"],
    ["docs/MACOS-TRYOUT.md", "START-HERE.txt"],
  ]) {
    assert.equal(
      sha256(path.join(resources, destination)),
      sha256(path.join(root, source)),
      `Missing resource: ${destination}`,
    );
  }
  const attempts = [];
  for (const attempt of [1, 2])
    attempts.push(await startup(app, binary, attempt));

  const destination = path.join(root, "release/macos");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.mkdirSync(destination);
  const filename = `TokenUsageLab-${version}-macos-${architecture.label}-internal.dmg`;
  fs.copyFileSync(dmg, path.join(destination, filename));
  for (const name of ["LICENSE", "THIRD-PARTY-NOTICES.txt", "START-HERE.txt"]) {
    fs.copyFileSync(path.join(resources, name), path.join(destination, name));
  }
  fs.copyFileSync(
    path.join(root, "docs/MACOS-MANUAL.md"),
    path.join(destination, "README.md"),
  );
  const info = {
    product: "Token Usage Lab",
    version,
    target,
    channel: "internal-tryout",
    builtAt: new Date().toISOString(),
    sourceCommit: run("git", ["rev-parse", "HEAD"]),
    sourceSnapshotSha256: sha256(path.join(root, "BUILD-SOURCE.json")),
    operatingSystem: run("/usr/bin/sw_vers", ["-productVersion"]),
    desktopSha256: sha256(binary),
    diskImageSha256: sha256(dmg),
    digitalSignature: "ad-hoc-not-Developer-ID",
    notarized: false,
    minimumSystemVersion: property("LSMinimumSystemVersion"),
    validationScope:
      "Native macOS CI startup and restart only; real tool logs and downloaded Gatekeeper flow unverified",
    cloudSync: false,
    includesUserData: false,
    attempts,
  };
  fs.writeFileSync(
    path.join(destination, "BUILD-INFO.json"),
    JSON.stringify(info, null, 2) + "\n",
  );
  const sums = fs
    .readdirSync(destination)
    .sort()
    .map((name) => `${sha256(path.join(destination, name))}  ${name}`);
  fs.writeFileSync(
    path.join(destination, "SHA256SUMS.txt"),
    sums.join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(evidence, "macos-package.json"),
    JSON.stringify(info, null, 2) + "\n",
  );
  console.log(JSON.stringify({ result: "PASS", filename, ...info }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

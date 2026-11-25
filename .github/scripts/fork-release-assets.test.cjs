const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { stageForkReleaseAssets } = require("./fork-release-assets.cjs");

const desktop = [
  ["mac-arm64", ["dmg", "zip"], "mac"],
  ["mac-x64", ["dmg", "zip"], "mac-x64"],
  ["linux-arm64", ["AppImage", "deb"], "linux-arm64"],
  ["linux-x64", ["AppImage", "deb"], "linux"],
  ["win-arm64", ["exe"], "win-arm64"],
  ["win-x64", ["exe"], "win-x64"],
];
const cli = [
  ["mac-arm64", "darwin-arm64.tar.gz"],
  ["linux-arm64", "linux-arm64.tar.gz"],
  ["linux-x64", "linux-x64.tar.gz"],
  ["win-arm64", "win32-arm64.zip"],
  ["win-x64", "win32-x64.zip"],
];

function fixture(t, channel = "stable") {
  const root = mkdtempSync(join(tmpdir(), "t3codejp-release-assets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = {
    inputDir: join(root, "inputs"),
    outputDir: join(root, "release-assets"),
    sourceDir: join(root, "scripts"),
    channel,
    version: channel === "stable" ? "1.0.0" : "1.0.0-" + channel + ".20261125.10",
    databaseMigration: 42,
  };
  const scripts = {
    "install.sh": Buffer.from("#!/bin/sh\necho planned shell installer\n"),
    "install.ps1": Buffer.from("Write-Output 'planned PowerShell installer'\r\n"),
  };
  mkdirSync(options.sourceDir);
  for (const [name, contents] of Object.entries(scripts)) {
    writeFileSync(join(options.sourceDir, name), contents);
  }
  const put = (artifact, name, contents = name) => {
    const dir = join(options.inputDir, artifact);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), contents);
  };
  const prefix = channel === "stable" ? "latest" : "nightly";
  for (const [target, extensions, manifest] of desktop) {
    const artifact = "desktop-" + target;
    const arch = target.split("-")[1];
    for (const extension of extensions) {
      const artifactArch =
        arch === "x64" ? ({ AppImage: "x86_64", deb: "amd64" }[extension] ?? arch) : arch;
      const basename =
        extension === "AppImage" && channel !== "preview"
          ? channel === "nightly"
            ? "T3CodeJP-Nightly"
            : "T3CodeJP"
          : "T3CodeJP-" + options.version;
      const name = basename + "-" + artifactArch + "." + extension;
      put(artifact, name);
      if (extension === "exe" && channel !== "preview") put(artifact, name + ".blockmap");
    }
    if (channel !== "preview") {
      put(artifact, prefix + "-" + manifest + ".yml", "version: " + options.version + "\n");
    }
    put(artifact, "builder-debug.yml");
  }
  const archives = cli.map(([target, suffix]) => {
    const name = "t3-" + options.version + "-" + suffix;
    put("cli-" + target, name);
    return name;
  });
  return { options, archives, scripts, put };
}

test("stages the full platform matrix with version-matched metadata and source installer scripts", async (t) => {
  const { options, archives, scripts } = fixture(t, "nightly");
  await stageForkReleaseAssets(options);
  const files = readdirSync(options.outputDir);
  assert.ok(files.includes("nightly-win-x64.yml"));
  assert.ok(files.includes("nightly-win-arm64.yml"));
  assert.ok(files.includes("nightly-linux-arm64.yml"));
  assert.ok(files.includes("nightly-mac-x64.yml"));
  assert.ok(files.includes("T3CodeJP-Nightly-x86_64.AppImage"));
  assert.ok(files.includes("T3CodeJP-" + options.version + "-amd64.deb"));
  assert.equal(files.filter((name) => name.endsWith(".exe.blockmap")).length, 2);
  assert.ok(!files.includes("builder-debug.yml"));

  const read = (name) => readFileSync(join(options.outputDir, name));
  const metadataName = "t3code-release.json";
  assert.deepEqual(JSON.parse(read(metadataName)), {
    version: options.version,
    t3code: { databaseMigration: options.databaseMigration },
  });
  for (const [name, contents] of Object.entries(scripts)) {
    assert.deepEqual(read(name), contents);
  }
  const checkedFiles = [...archives, metadataName, ...Object.keys(scripts)].sort();
  const expected =
    checkedFiles
      .map((name) => createHash("sha256").update(read(name)).digest("hex") + "  " + name)
      .join("\n") + "\n";
  assert.equal(read("SHA256SUMS").toString(), expected);
});

test("refuses to stage a partial platform matrix even when desktop and CLI artifacts exist", async (t) => {
  const { options } = fixture(t);
  rmSync(join(options.inputDir, "cli-win-arm64"), { recursive: true });
  await assert.rejects(stageForkReleaseAssets(options), /missing artifact cli-win-arm64/i);
  assert.equal(existsSync(join(options.outputDir, "SHA256SUMS")), false);
});

test("refuses to stage a release when a source installer is missing", async (t) => {
  const { options } = fixture(t);
  const missingScript = join(options.sourceDir, "install.ps1");
  rmSync(missingScript);
  await assert.rejects(stageForkReleaseAssets(options), { code: "ENOENT", path: missingScript });
  assert.equal(existsSync(options.outputDir), false);
});

test("rejects missing Windows differential assets and manifests from an older build", async (t) => {
  const { options, put } = fixture(t);
  const artifact = "desktop-win-arm64";
  const blockmap = "T3CodeJP-1.0.0-arm64.exe.blockmap";
  rmSync(join(options.inputDir, artifact, blockmap));
  await assert.rejects(stageForkReleaseAssets(options), /blockmap/);
  put(artifact, blockmap);
  put(artifact, "latest-win-arm64.yml", "version: 0.1.9\n");
  await assert.rejects(stageForkReleaseAssets(options), /version.*1\.0\.0/);
});

test("excludes updater metadata from Preview and refuses a leaked manifest or blockmap", async (t) => {
  const { options, put } = fixture(t, "preview");
  const artifact = "desktop-win-x64";
  const manifest = "latest-win-x64.yml";
  put(artifact, manifest);
  await assert.rejects(stageForkReleaseAssets(options), /Preview.*updater metadata/);
  rmSync(join(options.inputDir, artifact, manifest));
  put(artifact, "T3CodeJP-" + options.version + "-x64.exe.blockmap");
  await assert.rejects(stageForkReleaseAssets(options), /Preview.*updater metadata/);
  rmSync(join(options.inputDir, artifact, "T3CodeJP-" + options.version + "-x64.exe.blockmap"));
  await stageForkReleaseAssets(options);
  assert.ok(readdirSync(options.outputDir).every((name) => !/\.(?:yml|blockmap)$/.test(name)));
});

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
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

function linuxManifest(version, installers) {
  const sha512 = (name) => createHash("sha512").update(name).digest("base64");
  return [
    "version: " + version,
    "files:",
    ...installers.flatMap((name) => [
      "  - url: " + name,
      "    sha512: " + sha512(name),
      "    size: " + Buffer.byteLength(name),
      ...(name.endsWith(".AppImage") ? ["    blockMapSize: 10"] : []),
    ]),
    "path: " + installers[0],
    "sha512: " + sha512(installers[0]),
    "releaseDate: '2026-11-25T00:00:00.000Z'",
    "",
  ].join("\n");
}

function fixture(t, channel = "stable", distribution) {
  const root = mkdtempSync(join(tmpdir(), "t3codejp-release-assets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = {
    inputDir: join(root, "inputs"),
    outputDir: join(root, "release-assets"),
    sourceDir: join(root, "scripts"),
    channel,
    version: channel === "stable" ? "1.0.0" : "1.0.0-" + channel + ".20261125.10",
    databaseMigration: 42,
    ...(distribution === undefined ? {} : { distribution }),
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
  for (const [target, extensions, manifest] of distribution === "cli" ? [] : desktop) {
    const artifact = "desktop-" + target;
    const arch = target.split("-")[1];
    const installers = [];
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
      installers.push(name);
      put(artifact, name);
      if (extension === "exe" && channel !== "preview") put(artifact, name + ".blockmap");
    }
    if (channel !== "preview") {
      const contents = target.startsWith("linux-")
        ? linuxManifest(options.version, installers.toReversed())
        : "version: " + options.version + "\n";
      put(artifact, prefix + "-" + manifest + ".yml", contents);
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

for (const [channel, distribution] of [
  ["nightly", undefined],
  ["nightly", "all"],
  ["stable", "cli"],
  ["nightly", "cli"],
  ["preview", "cli"],
]) {
  test(`stages the ${distribution ?? "default"} ${channel} matrix with version-matched metadata and source installer scripts`, async (t) => {
    const { options, archives, scripts } = fixture(t, channel, distribution);
    await stageForkReleaseAssets(options);
    const files = readdirSync(options.outputDir);
    if (distribution !== "cli") {
      assert.ok(files.includes("nightly-win-x64.yml"));
      assert.ok(files.includes("nightly-win-arm64.yml"));
      assert.ok(files.includes("nightly-linux-arm64.yml"));
      assert.ok(files.includes("nightly-mac-x64.yml"));
      assert.ok(files.includes("T3CodeJP-Nightly-x86_64.AppImage"));
      assert.ok(files.includes("T3CodeJP-" + options.version + "-amd64.deb"));
      assert.equal(files.filter((name) => name.endsWith(".exe.blockmap")).length, 2);
      assert.ok(!files.includes("builder-debug.yml"));
    }

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
    if (distribution === "cli") {
      assert.deepEqual(files.sort(), [...checkedFiles, "SHA256SUMS"].sort());
    }
  });
}

test("refuses to stage a partial platform matrix even when desktop and CLI artifacts exist", async (t) => {
  const { options } = fixture(t);
  rmSync(join(options.inputDir, "cli-win-arm64"), { recursive: true });
  await assert.rejects(stageForkReleaseAssets(options), /missing artifact cli-win-arm64/i);
  assert.equal(existsSync(join(options.outputDir, "SHA256SUMS")), false);
});

for (const [target] of cli) {
  test(`refuses a CLI-only release missing cli-${target}`, async (t) => {
    const { options } = fixture(t, "stable", "cli");
    rmSync(join(options.inputDir, "cli-" + target), { recursive: true });
    await assert.rejects(
      stageForkReleaseAssets(options),
      new RegExp("Missing artifact cli-" + target),
    );
    assert.equal(existsSync(options.outputDir), false);
  });

  test(`rejects extra files and wrong CLI archive versions or targets in cli-${target}`, async (t) => {
    const { options, put } = fixture(t, "stable", "cli");
    const artifact = "cli-" + target;
    const name = readdirSync(join(options.inputDir, artifact))[0];
    const expected = new RegExp(artifact + " must contain exactly ");
    for (const extra of ["unexpected.txt", "T3CodeJP-1.0.0-x64.exe"]) {
      put(artifact, extra);
      await assert.rejects(stageForkReleaseAssets(options), expected);
      assert.equal(existsSync(options.outputDir), false);
      rmSync(join(options.inputDir, artifact, extra));
    }
    rmSync(join(options.inputDir, artifact, name));
    await assert.rejects(stageForkReleaseAssets(options), expected);
    for (const wrong of [
      name.replace(options.version, "1.0.1"),
      name.replace(/(?:arm64|x64)/, "ia32"),
    ]) {
      put(artifact, wrong);
      await assert.rejects(stageForkReleaseAssets(options), expected);
      assert.equal(existsSync(options.outputDir), false);
      rmSync(join(options.inputDir, artifact, wrong));
    }
  });
}

test("rejects unexpected desktop and unsupported CLI artifacts in a CLI-only release", async (t) => {
  const { options, put } = fixture(t, "stable", "cli");
  for (const artifact of [...desktop.map(([target]) => "desktop-" + target), "cli-mac-x64"]) {
    put(artifact, "unexpected.zip");
    await assert.rejects(stageForkReleaseAssets(options), /Unexpected artifact.*cli/i);
    assert.equal(existsSync(options.outputDir), false);
    rmSync(join(options.inputDir, artifact), { recursive: true });
  }
  writeFileSync(join(options.inputDir, "latest-win-x64.yml"), "version: 1.0.0\n");
  await assert.rejects(stageForkReleaseAssets(options), /Unexpected artifact.*cli/i);
  assert.equal(existsSync(options.outputDir), false);
});

test("rejects an unknown distribution before staging assets", async (t) => {
  const { options } = fixture(t);
  await assert.rejects(
    stageForkReleaseAssets({ ...options, distribution: "desktop" }),
    /distribution/i,
  );
  assert.equal(existsSync(options.outputDir), false);
});

for (const distribution of [undefined, "cli"]) {
  for (const name of ["install.sh", "install.ps1"]) {
    test(`refuses a ${distribution ?? "default"} release when source ${name} is missing`, async (t) => {
      const { options } = fixture(t, "stable", distribution);
      const missingScript = join(options.sourceDir, name);
      rmSync(missingScript);
      await assert.rejects(stageForkReleaseAssets(options), {
        code: "ENOENT",
        path: missingScript,
      });
      assert.equal(existsSync(options.outputDir), false);
    });
  }
}

for (const distribution of [undefined, "all", "cli"]) {
  test(`command accepts ${distribution ?? "omitted"} distribution after database migration`, (t) => {
    const { options, archives } = fixture(t, "stable", distribution);
    const result = spawnSync(
      process.execPath,
      [
        join(__dirname, "fork-release-assets.cjs"),
        options.inputDir,
        options.outputDir,
        options.channel,
        options.version,
        String(options.databaseMigration),
        ...(distribution === undefined ? [] : [distribution]),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const files = readdirSync(options.outputDir);
    if (distribution === "cli") {
      assert.deepEqual(
        files.sort(),
        [...archives, "install.sh", "install.ps1", "t3code-release.json", "SHA256SUMS"].sort(),
      );
    } else {
      assert.ok(files.includes("latest-win-x64.yml"));
    }
    for (const name of ["install.sh", "install.ps1"]) {
      assert.deepEqual(
        readFileSync(join(options.outputDir, name)),
        readFileSync(join(__dirname, "../../scripts", name)),
      );
    }
  });
}

test("rejects missing Windows differential assets and incomplete or mismatched updater manifests", async (t) => {
  const { options, put } = fixture(t);
  const artifact = "desktop-win-arm64";
  const blockmap = "T3CodeJP-1.0.0-arm64.exe.blockmap";
  rmSync(join(options.inputDir, artifact, blockmap));
  await assert.rejects(stageForkReleaseAssets(options), /blockmap/);
  put(artifact, blockmap);
  put(artifact, "latest-win-arm64.yml", "version: 0.1.9\n");
  await assert.rejects(stageForkReleaseAssets(options), /version.*1\.0\.0/);
  put(artifact, "latest-win-arm64.yml", "version: " + options.version + "\n");

  for (const [linuxArtifact, manifest, image, otherImage] of [
    [
      "desktop-linux-x64",
      "latest-linux.yml",
      "T3CodeJP-x86_64.AppImage",
      "T3CodeJP-arm64.AppImage",
    ],
    [
      "desktop-linux-arm64",
      "latest-linux-arm64.yml",
      "T3CodeJP-arm64.AppImage",
      "T3CodeJP-x86_64.AppImage",
    ],
  ]) {
    const good = readFileSync(join(options.inputDir, linuxArtifact, manifest), "utf8");
    put(linuxArtifact, manifest, "version: " + options.version + "\n");
    await assert.rejects(stageForkReleaseAssets(options), /must list its staged AppImage/);
    put(linuxArtifact, manifest, good.replace(image, otherImage));
    await assert.rejects(stageForkReleaseAssets(options), /must list its staged AppImage/);
    put(linuxArtifact, manifest, good);
    put(linuxArtifact, image, image + "extra bytes");
    await assert.rejects(stageForkReleaseAssets(options), /size does not match/);
    put(linuxArtifact, image, "x".repeat(Buffer.byteLength(image)));
    await assert.rejects(stageForkReleaseAssets(options), /SHA512 does not match/);
    put(linuxArtifact, image);
  }
  assert.equal(existsSync(options.outputDir), false);
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

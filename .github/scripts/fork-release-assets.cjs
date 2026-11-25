const { createHash } = require("node:crypto");
const {
  copyFileSync,
  createReadStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");

const TARGETS = [
  {
    platform: "mac-arm64",
    cliKey: "darwin-arm64.tar.gz",
    installers: [".dmg", ".zip"],
    manifest: "mac",
  },
  { platform: "mac-x64", installers: [".dmg", ".zip"], manifest: "mac-x64" },
  {
    platform: "linux-x64",
    cliKey: "linux-x64.tar.gz",
    installers: [".AppImage", ".deb"],
    manifest: "linux",
  },
  {
    platform: "linux-arm64",
    cliKey: "linux-arm64.tar.gz",
    installers: [".AppImage", ".deb"],
    manifest: "linux-arm64",
  },
  { platform: "win-x64", cliKey: "win32-x64.zip", installers: [".exe"], manifest: "win-x64" },
  { platform: "win-arm64", cliKey: "win32-arm64.zip", installers: [".exe"], manifest: "win-arm64" },
];
const METADATA_FILE = "t3code-release.json";
const INSTALL_SCRIPT_FILES = ["install.sh", "install.ps1"];
const LINUX_X64_ARTIFACT_ARCH = { ".AppImage": "x86_64", ".deb": "amd64" };

function artifactFiles(inputDir, artifact) {
  let entries;
  try {
    entries = readdirSync(join(inputDir, artifact), { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error("Missing artifact " + artifact + ".", { cause: error });
  }
  return entries.map((entry) => {
    if (!entry.isFile() || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.name)) {
      throw new Error("Unexpected asset in " + artifact + ": " + entry.name);
    }
    return entry.name;
  });
}

function checkManifestVersion(inputDir, artifact, file, expected) {
  const text = readFileSync(join(inputDir, artifact, file), "utf8");
  const version = /^version:[ \t]*([^\r\n]+)/m
    .exec(text)?.[1]
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2");
  if (version !== expected) {
    throw new Error(artifact + "/" + file + " must declare version " + expected + ".");
  }
}

function desktopFiles(inputDir, target, version, channel) {
  const artifact = "desktop-" + target.platform;
  const names = artifactFiles(inputDir, artifact).filter((name) => name !== "builder-debug.yml");
  const arch = target.platform.split("-")[1];
  const installers = target.installers.map((extension) => {
    const matches = names.filter((name) => name.endsWith(extension));
    const artifactArch = arch === "x64" ? (LINUX_X64_ARTIFACT_ARCH[extension] ?? arch) : arch;
    const basename =
      extension === ".AppImage" && channel !== "preview"
        ? channel === "nightly"
          ? "T3CodeJP-Nightly"
          : "T3CodeJP"
        : "T3CodeJP-" + version;
    const expected = basename + "-" + artifactArch + extension;
    if (matches.length !== 1 || matches[0] !== expected) {
      throw new Error(artifact + " must contain exactly " + expected + ".");
    }
    return expected;
  });

  const updaterFiles = names.filter((name) => /\.(?:yml|blockmap)$/.test(name));
  if (channel === "preview") {
    if (updaterFiles.length > 0)
      throw new Error("Preview artifact " + artifact + " carries updater metadata.");
    return installers;
  }

  const manifest = (channel === "stable" ? "latest" : "nightly") + "-" + target.manifest + ".yml";
  if (!updaterFiles.includes(manifest))
    throw new Error("Missing manifest " + manifest + " in " + artifact + ".");
  checkManifestVersion(inputDir, artifact, manifest, version);
  const exe = installers.find((name) => name.endsWith(".exe"));
  if (exe && !updaterFiles.includes(exe + ".blockmap")) {
    throw new Error("Missing Windows blockmap for " + exe + " in " + artifact + ".");
  }

  for (const name of updaterFiles) {
    if (name !== manifest && !installers.some((installer) => name === installer + ".blockmap")) {
      throw new Error("Unexpected updater file " + name + " in " + artifact + ".");
    }
  }
  return [...installers, ...updaterFiles];
}

async function writeChecksums(outputDir, names) {
  const lines = [];
  for (const name of names.toSorted()) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(join(outputDir, name))) hash.update(chunk);
    lines.push(hash.digest("hex") + "  " + name);
  }
  writeFileSync(join(outputDir, "SHA256SUMS"), lines.join("\n") + "\n");
}

async function stageForkReleaseAssets({
  inputDir,
  outputDir,
  sourceDir = join(__dirname, "../../scripts"),
  channel,
  version,
  databaseMigration,
}) {
  if (!["stable", "nightly", "preview"].includes(channel))
    throw new Error("Invalid release channel.");
  const base = "[1-9]\\d*\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
  const suffix = channel === "stable" ? "" : "-" + channel + "\\.\\d{8}\\.[1-9]\\d*";
  if (!new RegExp("^" + base + suffix + "$").test(version))
    throw new Error("Invalid fork release version.");
  if (!Number.isSafeInteger(databaseMigration) || databaseMigration < 0) {
    throw new Error("Expected a non-negative database migration ID.");
  }

  const files = new Map();
  const cliArchives = [];
  const add = (artifact, name) => {
    if (files.has(name)) throw new Error("Conflicting release asset " + name + ".");
    files.set(name, join(inputDir, artifact, name));
  };
  for (const target of TARGETS) {
    for (const name of desktopFiles(inputDir, target, version, channel)) {
      add("desktop-" + target.platform, name);
    }
    if (target.cliKey) {
      const artifact = "cli-" + target.platform;
      const name = "t3-" + version + "-" + target.cliKey;
      const names = artifactFiles(inputDir, artifact);
      if (names.length !== 1 || names[0] !== name) {
        throw new Error(artifact + " must contain exactly " + name + ".");
      }
      add(artifact, name);
      cliArchives.push(name);
    }
  }

  const installScripts = INSTALL_SCRIPT_FILES.map((name) => [
    name,
    readFileSync(join(sourceDir, name)),
  ]);
  mkdirSync(outputDir);
  for (const [name, source] of files) copyFileSync(source, join(outputDir, name));
  for (const [name, contents] of installScripts) writeFileSync(join(outputDir, name), contents);
  const metadata = { version, t3code: { databaseMigration } };
  writeFileSync(join(outputDir, METADATA_FILE), JSON.stringify(metadata, null, 2) + "\n");
  await writeChecksums(outputDir, [...cliArchives, METADATA_FILE, ...INSTALL_SCRIPT_FILES]);
}

if (require.main === module) {
  const [, , inputDir, outputDir, channel, version, migration] = process.argv;
  if (!inputDir || !outputDir || !channel || !version || !/^\d+$/.test(migration)) {
    console.error(
      "Usage: fork-release-assets.cjs <input-dir> <output-dir> <channel> <version> <database-migration>",
    );
    process.exitCode = 1;
  } else {
    stageForkReleaseAssets({
      inputDir,
      outputDir,
      channel,
      version,
      databaseMigration: Number(migration),
    }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}

module.exports = { stageForkReleaseAssets };

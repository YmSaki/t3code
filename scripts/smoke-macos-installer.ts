import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import Plist from "plist";

NodeAssert.equal(HostProcess.Platform.defaultValue(), "darwin", "Run only on macOS");
NodeAssert.equal(process.env.CI, "true", "Run only in CI");
NodeAssert.equal(
  process.env.RUNNER_ENVIRONMENT,
  "github-hosted",
  "Run only in a disposable GitHub-hosted runner",
);
const { values } = NodeUtil.parseArgs({
  options: {
    baseline: { type: "string" },
    candidate: { type: "string" },
    upstream: { type: "string" },
    "output-dir": { type: "string" },
    arch: { type: "string", default: HostProcess.Architecture.defaultValue() },
  },
});
const arch = values.arch;
NodeAssert.ok(arch === "x64" || arch === "arm64", "Pass --arch x64|arm64");
NodeAssert.equal(
  arch,
  HostProcess.Architecture.defaultValue(),
  "The proof must run on the DMGs' native architecture",
);
const input = (key: "baseline" | "candidate" | "upstream" | "output-dir") => {
  const value = values[key];
  NodeAssert.ok(value, `Missing --${key}`);
  return NodePath.resolve(value);
};
const dmg = (key: "baseline" | "candidate" | "upstream") => {
  const file = NodeFS.realpathSync(input(key));
  NodeAssert.equal(NodePath.extname(file).toLowerCase(), ".dmg", `--${key} must be a DMG`);
  NodeAssert.ok(NodeFS.statSync(file).isFile(), `--${key} must be a real DMG file`);
  return file;
};
const baseline = dmg("baseline"),
  candidate = dmg("candidate"),
  upstream = dmg("upstream");
NodeAssert.equal(new Set([baseline, candidate, upstream]).size, 3, "Use three distinct DMGs");
const home = NodeFS.realpathSync(NodeOS.userInfo().homedir);
NodeAssert.ok(process.env.HOME, "Keep the runner's real HOME for Keychain access");
NodeAssert.equal(NodeFS.realpathSync(process.env.HOME), home, "Do not override the runner's HOME");
const officialHome = NodePath.join(home, ".t3"),
  forkHome = NodePath.join(home, ".t3codejp"),
  appSupport = NodePath.join(home, "Library/Application Support"),
  forkProfile = NodePath.join(appSupport, "t3codejp"),
  freshBackup = NodePath.join(home, ".t3codejp-fresh-proof-backup"),
  customHome = NodePath.join(home, "custom [data]'home");
const exists = (file: string) => NodeFS.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
for (const directory of [officialHome, forkHome, freshBackup, customHome])
  NodeAssert.equal(exists(directory), false, `Refusing existing data: ${directory}`);
if (exists(appSupport)) {
  for (const name of NodeFS.readdirSync(appSupport))
    NodeAssert.equal(
      /^t3(?:[ ._-]*code)?(?:[ ._-]*jp)?(?:$|[\s._(-])/i.test(name),
      false,
      `Refusing a conflicting app profile: ${NodePath.join(appSupport, name)}`,
    );
}
const inside = (parent: string, file: string) => {
  const relative = NodePath.relative(parent, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
};
const outputPath = input("output-dir");
let outputAncestor = outputPath;
while (!exists(outputAncestor)) outputAncestor = NodePath.dirname(outputAncestor);
const output = NodePath.join(
  NodeFS.realpathSync(outputAncestor),
  NodePath.relative(outputAncestor, outputPath),
);
NodeAssert.equal(inside("/Applications", output), false, "Never install in /Applications");
for (const reserved of [officialHome, forkHome, appSupport, freshBackup, customHome]) {
  NodeAssert.equal(inside(reserved, output), false, "Keep proof output separate from app state");
  NodeAssert.equal(inside(output, reserved), false, "Keep app state outside proof output");
}
NodeFS.mkdirSync(output, { recursive: true });
NodeAssert.equal(NodeFS.realpathSync(output), output);
NodeAssert.deepEqual(NodeFS.readdirSync(output), [], "Use an empty proof output directory");
const applications = NodePath.join(output, "Applications");
NodeFS.mkdirSync(applications);
const run = (command: string, args: string[], env?: NodeJS.ProcessEnv) => {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...(env ? { env } : {}),
  });
  if (result.status !== 0)
    throw new Error(
      `${NodePath.basename(command)} exited ${result.status} (${result.signal}): ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout.trim();
};
const digest = (file: string) => {
  const hash = NodeCrypto.createHash("sha256");
  const fd = NodeFS.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let length: number;
    while ((length = NodeFS.readSync(fd, buffer)) !== 0) hash.update(buffer.subarray(0, length));
    return hash.digest("hex");
  } finally {
    NodeFS.closeSync(fd);
  }
};
const hashes = {
  baseline: digest(baseline),
  candidate: digest(candidate),
  upstream: digest(upstream),
};
NodeAssert.equal(
  hashes.upstream,
  arch === "x64"
    ? "f31c4a3fcbed88a1e9fc252f0b117c814052bb4db720ab975725a64a0894b8f9"
    : "4613582f18d0c8ba60164e5d5d779bce4bb6cf7824b75fe94ecfe00a21f9bf",
  "Use the pinned official v0.1.12 DMG",
);

type MountEntity = { "mount-point"?: string; "dev-entry"?: string };
type MountReceipt = { "system-entities": MountEntity[] };
type BundlePlist = {
  CFBundleExecutable: string;
  CFBundleShortVersionString: string;
  CFBundleIdentifier: string;
  CFBundleURLTypes?: { CFBundleURLSchemes?: string[] }[];
};
const bundle = (app: string) => {
  const info = Plist.parse(
    run("/usr/bin/plutil", [
      "-convert",
      "xml1",
      "-o",
      "-",
      "--",
      NodePath.join(app, "Contents/Info.plist"),
    ]),
  ) as unknown as BundlePlist;
  const executableName = info.CFBundleExecutable;
  NodeAssert.ok(typeof executableName === "string" && executableName.length > 0);
  NodeAssert.equal(NodePath.basename(executableName), executableName);
  NodeAssert.ok(executableName !== "." && executableName !== "..");
  const executable = NodePath.join(app, "Contents/MacOS", executableName);
  NodeAssert.ok(inside(app, NodeFS.realpathSync(executable)), "Executable must stay in its app");
  NodeFS.accessSync(executable, NodeFS.constants.X_OK);
  NodeAssert.ok(
    run("/usr/bin/lipo", ["-archs", executable])
      .split(/\s+/)
      .includes(arch === "x64" ? "x86_64" : "arm64"),
    `App must support ${arch}`,
  );
  NodeAssert.ok(typeof info.CFBundleIdentifier === "string" && info.CFBundleIdentifier.length > 0);
  const schemes = (info.CFBundleURLTypes ?? []).flatMap((type) => type.CFBundleURLSchemes ?? []);
  NodeAssert.ok(schemes.every((scheme) => typeof scheme === "string" && scheme.length > 0));
  return {
    app,
    executable,
    version: info.CFBundleShortVersionString,
    bundleId: info.CFBundleIdentifier,
    schemes: [...new Set(schemes.map((scheme) => scheme.toLowerCase()))].sort(),
  };
};
const mounts: { image: string; mountpoint: string; device?: string; detached: boolean }[] = [];
const mountRoot = NodeFS.realpathSync(
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3codejp-dmg-proof-")),
);
const installed = new Set<string>();
const removeApp = (app: string) => {
  NodeAssert.equal(NodePath.dirname(app), applications);
  NodeAssert.ok(installed.has(app), "Remove only an app copied by this proof");
  NodeAssert.ok(NodeFS.lstatSync(app).isDirectory());
  NodeAssert.equal(NodeFS.realpathSync(app), app, "Do not remove a redirected app path");
  NodeFS.rmSync(app, { recursive: true });
  installed.delete(app);
};
const detach = (mount: (typeof mounts)[number]) => {
  if (mount.detached) return;
  // A failed attach can still leave a volume mounted; discover only our exact mountpoint.
  const info = Plist.parse(run("/usr/bin/hdiutil", ["info", "-plist"])) as unknown as {
    images: MountReceipt[];
  };
  const entity = info.images
    .flatMap((image) => image["system-entities"])
    .find((entry) => entry["mount-point"] === mount.mountpoint);
  if (entity) {
    const device = entity["dev-entry"];
    NodeAssert.ok(device && /^\/dev\/disk\d+(?:s\d+)*$/.test(device));
    if (mount.device) NodeAssert.equal(device, mount.device, "Mounted device changed");
    mount.device = device;
    run("/usr/bin/hdiutil", ["detach", device]);
  }
  mount.detached = true;
};
const install = (image: string, version: string, previous?: ReturnType<typeof bundle>) => {
  const mountpoint = NodeFS.mkdtempSync(NodePath.join(mountRoot, "volume-"));
  const mount: (typeof mounts)[number] = { image, mountpoint, detached: false };
  mounts.push(mount);
  try {
    const receipt = Plist.parse(
      run("/usr/bin/hdiutil", [
        "attach",
        "-readonly",
        "-nobrowse",
        "-noautoopen",
        "-mountpoint",
        mountpoint,
        "-plist",
        image,
      ]),
    ) as unknown as MountReceipt;
    const volumes = receipt["system-entities"].filter((entry) => entry["mount-point"]);
    NodeAssert.equal(volumes.length, 1, "Expected exactly one mounted DMG volume");
    const volume = volumes[0];
    NodeAssert.ok(volume);
    NodeAssert.equal(volume["mount-point"], mountpoint);
    NodeAssert.ok(volume["dev-entry"]);
    mount.device = volume["dev-entry"];
    const apps = NodeFS.readdirSync(mountpoint).filter((name) => name.endsWith(".app"));
    NodeAssert.equal(apps.length, 1, "Expected exactly one app on the DMG");
    const name = apps[0];
    NodeAssert.ok(name);
    const source = NodePath.join(mountpoint, name);
    NodeAssert.ok(NodeFS.lstatSync(source).isDirectory(), "DMG app must not be a symlink");
    const metadata = bundle(source);
    NodeAssert.equal(metadata.version, version);
    const destination = NodePath.join(applications, name);
    if (previous) {
      NodeAssert.equal(destination, previous.app, "Update must replace the same app bundle");
      NodeAssert.equal(metadata.bundleId, previous.bundleId);
      NodeAssert.deepEqual(metadata.schemes, previous.schemes);
      removeApp(previous.app);
    } else NodeAssert.equal(exists(destination), false, "Never replace an unowned app");
    run("/usr/bin/ditto", [source, destination]);
    installed.add(destination);
    return bundle(destination);
  } finally {
    detach(mount);
  }
};
const tree = (directory: string) => {
  const entries: Record<
    string,
    { mode: number; sha256?: string; link?: string; directory?: true }
  > = {};
  const visit = (relative: string) => {
    const file = NodePath.join(directory, relative),
      stat = NodeFS.lstatSync(file);
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) entries[relative] = { mode, link: NodeFS.readlinkSync(file) };
    else if (stat.isDirectory()) {
      entries[relative] = { mode, directory: true };
      for (const child of NodeFS.readdirSync(file).sort()) visit(NodePath.join(relative, child));
    } else {
      NodeAssert.ok(stat.isFile(), `Unexpected non-file in snapshot: ${file}`);
      entries[relative] = { mode, sha256: digest(file) };
    }
  };
  visit("");
  return entries;
};
const snapshot = (base: string) => {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(base, "userdata/statev2.sqlite"), {
    readOnly: true,
  });
  try {
    return {
      threads: db
        .prepare(
          "SELECT thread_id, project_id, title FROM orchestration_v2_projection_threads ORDER BY thread_id",
        )
        .all(),
      messages: db
        .prepare(
          "SELECT message_id, thread_id, role, payload_json FROM orchestration_v2_projection_messages ORDER BY message_id",
        )
        .all()
        .map((row) => ({
          id: row.message_id,
          threadId: row.thread_id,
          role: row.role,
          text: (JSON.parse(String(row.payload_json)) as { text: string }).text,
        })),
    };
  } finally {
    db.close();
  }
};
const verifySettings = (base: string) => {
  const settings = JSON.parse(
    NodeFS.readFileSync(NodePath.join(base, "userdata/client-settings.json"), "utf8"),
  ) as Record<string, unknown>;
  NodeAssert.equal(settings.language, "ja");
  NodeAssert.equal(settings.fontSizeInterface, 17);
  NodeAssert.deepEqual(
    JSON.parse(NodeFS.readFileSync(NodePath.join(base, "userdata/settings.json"), "utf8")),
    { projectSettingsFolded: true },
  );
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(base, "userdata/attachments/migration-proof.txt"), "utf8"),
    "Keep the migrated attachment.\n",
  );
};
const phases: Record<
  string,
  {
    profile: string;
    dataHome: string;
    version: string;
    bundleId: string;
    arch: string;
    screenshot: string;
  }
> = {};
const nativeEnv: NodeJS.ProcessEnv = {
  HOME: home,
  CI: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
};
for (const key of [
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "__CF_USER_TEXT_ENCODING",
  "SECURITYSESSIONID",
])
  if (process.env[key] !== undefined) nativeEnv[key] = process.env[key];
const native = (
  label: string,
  app: ReturnType<typeof bundle>,
  expectedHome: string,
  flags: string[] = [],
) => {
  const phaseDir = NodePath.join(output, label);
  NodeFS.mkdirSync(phaseDir);
  console.log(`Verifying ${label}`);
  run(
    process.execPath,
    [
      NodePath.join(import.meta.dirname, "verify-macos-desktop-artifact.ts"),
      "--executable",
      app.executable,
      "--version",
      app.version,
      "--expected-home",
      expectedHome,
      "--output-dir",
      phaseDir,
      ...flags,
    ],
    nativeEnv,
  );
  const result = JSON.parse(
    NodeFS.readFileSync(NodePath.join(phaseDir, "result.json"), "utf8"),
  ) as {
    profile: string;
    dataHome: string;
    version: string;
    bundleId: string;
    arch: string;
  };
  NodeAssert.equal(result.dataHome, expectedHome);
  NodeAssert.equal(result.version, app.version);
  NodeAssert.equal(result.bundleId, app.bundleId);
  NodeAssert.equal(result.arch, arch);
  NodeAssert.ok(typeof result.profile === "string" && inside(appSupport, result.profile));
  NodeAssert.ok(NodeFS.statSync(result.profile).isDirectory());
  if (!flags.includes("--official")) NodeAssert.equal(result.profile, forkProfile);
  const screenshot = NodePath.join(phaseDir, "window.png");
  NodeAssert.ok(NodeFS.statSync(screenshot).isFile());
  phases[label] = {
    profile: result.profile,
    dataHome: result.dataHome,
    version: result.version,
    bundleId: result.bundleId,
    arch: result.arch,
    screenshot,
  };
  return result;
};

const failures: unknown[] = [];
try {
  const official = install(upstream, "0.1.12");
  NodeAssert.ok(official.schemes.includes("t3code"));
  const userdata = NodePath.join(officialHome, "userdata");
  NodeFS.mkdirSync(userdata, { recursive: true });
  NodeFS.copyFileSync(
    NodePath.join(import.meta.dirname, "fixtures/desktop-launch/statev2.sqlite"),
    NodePath.join(userdata, "statev2.sqlite"),
  );
  NodeFS.writeFileSync(
    NodePath.join(userdata, "client-settings.json"),
    JSON.stringify({
      notificationMode: "off",
      language: "ja",
      onboardingCompletedAt: "2026-11-26T00:00:00.000Z",
      panelAnimationDurationMs: 0,
      fontSizeInterface: 17,
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(userdata, "desktop-settings.json"),
    JSON.stringify({ serverExposureMode: "local-only", updateChannelConfiguredByUser: true }),
  );
  NodeFS.writeFileSync(
    NodePath.join(userdata, "settings.json"),
    JSON.stringify({ projectSettingsFolded: true }),
  );
  NodeFS.mkdirSync(NodePath.join(userdata, "attachments"));
  NodeFS.writeFileSync(
    NodePath.join(userdata, "attachments/migration-proof.txt"),
    "Keep the migrated attachment.\n",
  );
  const seededBusiness = snapshot(officialHome);
  const officialResult = native("official", official, officialHome, ["--official"]);
  const business = snapshot(officialHome);
  NodeAssert.deepEqual(business, seededBusiness);
  NodeAssert.equal(business.threads.length, 2);
  NodeAssert.equal(business.messages.length, 3);
  verifySettings(officialHome);
  NodeAssert.equal(exists(forkHome), false, "Official startup must not create fork data");
  NodeAssert.equal(exists(forkProfile), false, "Official startup must not create a fork profile");
  const sourceData = tree(officialHome),
    originalApp = tree(official.app);
  const assertOfficial = () => {
    NodeAssert.deepEqual(tree(official.app), originalApp, "Official app files or symlinks changed");
    NodeAssert.deepEqual(tree(officialHome), sourceData, "Official ~/.t3 changed");
  };
  const oldApp = install(baseline, "1.0.0");
  NodeAssert.notEqual(oldApp.app, official.app);
  NodeAssert.equal(oldApp.bundleId, "io.github.ymsaki.t3codejp");
  NodeAssert.notEqual(oldApp.bundleId, official.bundleId);
  NodeAssert.ok(oldApp.schemes.includes("t3codejp"));
  NodeAssert.deepEqual(
    oldApp.schemes.filter((scheme) => official.schemes.includes(scheme)),
    [],
    "Official and fork protocol schemes must not overlap",
  );
  const fresh = native("fresh", oldApp, forkHome, ["--fresh"]);
  NodeAssert.notEqual(fresh.profile, officialResult.profile);
  const freshBusiness = snapshot(forkHome);
  NodeAssert.deepEqual(
    freshBusiness.threads.filter((thread) =>
      business.threads.some((source) => source.thread_id === thread.thread_id),
    ),
    [],
    "Fresh fork must not import official threads",
  );
  NodeAssert.deepEqual(
    freshBusiness.messages.filter((message) =>
      business.messages.some((source) => source.id === message.id),
    ),
    [],
    "Fresh fork must not import official messages",
  );
  assertOfficial();

  NodeFS.renameSync(forkHome, freshBackup);
  NodeFS.mkdirSync(forkHome);
  NodeFS.cpSync(userdata, NodePath.join(forkHome, "userdata"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  native("migrated", oldApp, forkHome);
  NodeAssert.deepEqual(snapshot(forkHome), business);
  verifySettings(forkHome);
  assertOfficial();

  const upgradedApp = install(candidate, "1.0.1", oldApp);
  native("upgraded", upgradedApp, forkHome);
  NodeAssert.deepEqual(snapshot(forkHome), business);
  verifySettings(forkHome);
  assertOfficial();
  const defaultData = tree(forkHome);
  NodeFS.mkdirSync(customHome);
  NodeFS.cpSync(NodePath.join(forkHome, "userdata"), NodePath.join(customHome, "userdata"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  native("custom-home", upgradedApp, customHome, ["--home-dir", customHome]);
  NodeAssert.deepEqual(snapshot(customHome), business);
  verifySettings(customHome);
  NodeAssert.deepEqual(
    tree(forkHome),
    defaultData,
    "Custom T3CODE_HOME must preserve the default home",
  );
  assertOfficial();
  const customData = tree(customHome);
  removeApp(upgradedApp.app);
  NodeAssert.equal(exists(upgradedApp.app), false);
  NodeAssert.deepEqual(tree(forkHome), defaultData);
  NodeAssert.deepEqual(tree(customHome), customData);
  NodeAssert.ok(
    NodeFS.statSync(forkProfile).isDirectory(),
    "Removal must preserve the fork profile",
  );
  assertOfficial();
  const result = {
    arch,
    upstreamVersion: official.version,
    baselineVersion: oldApp.version,
    candidateVersion: upgradedApp.version,
    hashes,
    applications: { official, baseline: oldApp, candidate: upgradedApp },
    mounts,
    phases,
    data: business,
    upstreamPreserved: true,
    defaultHomesSeparated: true,
    profilesSeparated: true,
    protocolSchemesSeparated: true,
    migrationPreserved: true,
    dmgReplacementPreserved: true,
    customHomePreserved: true,
    removalPreserved: true,
  };
  NodeFS.writeFileSync(NodePath.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  failures.push(error);
} finally {
  for (const mount of mounts.toReversed()) {
    try {
      detach(mount);
    } catch (error) {
      failures.push(error);
    }
  }
  if (mounts.every((mount) => mount.detached)) {
    try {
      NodeFS.rmSync(mountRoot, { recursive: true });
    } catch (error) {
      failures.push(error);
    }
  }
}
if (failures.length > 0) throw new AggregateError(failures, "macOS installer proof failed");

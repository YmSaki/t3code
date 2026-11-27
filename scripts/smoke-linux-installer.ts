import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({
  options: {
    baseline: { type: "string" },
    candidate: { type: "string" },
    "baseline-appimage": { type: "string" },
    "candidate-appimage": { type: "string" },
    upstream: { type: "string" },
    "output-dir": { type: "string" },
    user: { type: "string", default: "t3-install-proof" },
    "runtime-verifier": { type: "string" },
  },
});
NodeAssert.equal(HostProcess.Platform.defaultValue(), "linux");
NodeAssert.equal(process.getuid?.(), 0, "Package installation needs root in the disposable host");
NodeAssert.ok(
  (process.env.CI === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted") ||
    NodeFS.existsSync("/etc/t3codejp-installer-proof"),
  "Run only in a disposable GitHub-hosted runner or a marked test VM",
);
const input = (key: keyof typeof values) => {
  const value = values[key];
  if (typeof value !== "string") throw new Error(`Missing --${key}`);
  return NodePath.resolve(value);
};
const baseline = input("baseline"),
  candidate = input("candidate");
const baselineImage = input("baseline-appimage"),
  candidateImage = input("candidate-appimage");
const upstream = input("upstream"),
  output = input("output-dir");
const user = values.user;
NodeAssert.match(user, /^[a-z][a-z0-9-]{0,25}$/);
NodeFS.mkdirSync(output, { recursive: true });
NodeAssert.deepEqual(NodeFS.readdirSync(output), [], "Use an empty proof output directory");
const run = (command: string, args: string[]) => {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} exited ${result.status} (${result.signal}): ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout.trim();
};
const digest = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
const architecture = run("dpkg", ["--print-architecture"]);
NodeAssert.ok(architecture === "amd64" || architecture === "arm64", "Use an amd64 or arm64 host");
const upstreamSha256 = {
  amd64: "c1ca3e656e12ba10377513e9bbe20a5112540cda9601e21c70b85ba7c53f1b29",
  arm64: "3ca1a4e548794e39fa11027d39f5e6a3510154c49bd771756b1744a1d5a804e0",
};
NodeAssert.equal(digest(upstream), upstreamSha256[architecture]);
for (const file of [upstream, baseline, candidate]) {
  NodeAssert.equal(run("dpkg-deb", ["--field", file, "Architecture"]), architecture, file);
}
NodeAssert.equal(run("dpkg-deb", ["--field", upstream, "Package"]), "t3code");
NodeAssert.equal(run("dpkg-deb", ["--field", upstream, "Version"]), "0.1.12");
const baselineVersion = run("dpkg-deb", ["--field", baseline, "Version"]);
const candidateVersion = run("dpkg-deb", ["--field", candidate, "Version"]);
run("dpkg", ["--compare-versions", candidateVersion, "gt", baselineVersion]);
for (const file of [baseline, candidate])
  NodeAssert.equal(run("dpkg-deb", ["--field", file, "Package"]), "t3codejp");
NodeAssert.notEqual(NodeChildProcess.spawnSync("id", [user]).status, 0, "Use a new test user");
run("useradd", ["--create-home", "--shell", "/bin/bash", user]);
const home = run("getent", ["passwd", user]).split(":")[5];
NodeAssert.equal(home, `/home/${user}`);
const uid = run("id", ["-u", user]);
const runtimeDir = `/run/user/${uid}`;
NodeFS.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
run("chown", [`${user}:${user}`, runtimeDir, output]);
const node = NodePath.join(output, "node");
NodeFS.copyFileSync(process.execPath, node);
NodeFS.chmodSync(node, 0o755);
const runtimeVerifier = values["runtime-verifier"]
  ? NodePath.join(output, "verify-linux-desktop-artifact.mjs")
  : NodePath.join(import.meta.dirname, "verify-linux-desktop-artifact.ts");
if (values["runtime-verifier"]) {
  NodeFS.copyFileSync(NodePath.resolve(values["runtime-verifier"]), runtimeVerifier);
  const playwrightPackage = NodeModule.createRequire(import.meta.url).resolve(
    "playwright-core/package.json",
  );
  NodeFS.cpSync(
    NodePath.dirname(playwrightPackage),
    NodePath.join(output, "node_modules/playwright-core"),
    { recursive: true },
  );
}
const userRun = (command: string, args: string[]) =>
  run("runuser", [
    "-u",
    user,
    "--",
    "env",
    "-i",
    `HOME=${home}`,
    `USER=${user}`,
    `LOGNAME=${user}`,
    `XDG_RUNTIME_DIR=${runtimeDir}`,
    `XDG_CONFIG_HOME=${home}/.config`,
    "PATH=/usr/local/bin:/usr/bin:/bin",
    command,
    ...args,
  ]);
const install = (file: string) =>
  run("apt-get", ["-o", "DPkg::Lock::Timeout=180", "install", "-y", file]);
const launcher = (name: string) => {
  const files = run("dpkg-query", ["-L", name]).split("\n");
  const desktop = files.find(
    (file) => file.startsWith("/usr/share/applications/") && file.endsWith(".desktop"),
  );
  NodeAssert.ok(desktop, `No launcher for ${name}`);
  const text = NodeFS.readFileSync(desktop, "utf8");
  const exec = /^Exec=(?:"([^"]+)"|([^\s]+))/m.exec(text);
  NodeAssert.ok(exec);
  const executable = exec[1] ?? exec[2];
  NodeAssert.ok(executable);
  return { desktop, executable, text };
};
const fingerprint = (file: string) => {
  const stat = NodeFS.lstatSync(file);
  return stat.isSymbolicLink()
    ? { link: NodeFS.readlinkSync(file), resolved: NodeFS.realpathSync(file) }
    : { sha256: digest(file), mode: stat.mode & 0o7777 };
};
const tree = (directory: string): Record<string, ReturnType<typeof fingerprint>> => {
  const entries: Record<string, ReturnType<typeof fingerprint>> = {};
  const visit = (relative: string) => {
    const file = NodePath.join(directory, relative),
      stat = NodeFS.lstatSync(file);
    if (stat.isDirectory())
      for (const child of NodeFS.readdirSync(file).sort()) visit(NodePath.join(relative, child));
    else entries[relative] = fingerprint(file);
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
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(base, "userdata/attachments/migration-proof.txt"), "utf8"),
    "Keep the migrated attachment.\n",
  );
};
const phases: Record<string, unknown> = {};
const native = (
  label: string,
  executable: string,
  version: string,
  expectedHome: string,
  flags: string[] = [],
) => {
  const phaseDir = NodePath.join(output, label);
  NodeFS.mkdirSync(phaseDir);
  run("chown", [`${user}:${user}`, phaseDir]);
  console.log(`Verifying ${label}`);
  userRun("dbus-run-session", [
    "--",
    "xvfb-run",
    "-a",
    node,
    runtimeVerifier,
    "--executable",
    executable,
    "--version",
    version,
    "--expected-home",
    expectedHome,
    "--output-dir",
    phaseDir,
    ...flags,
  ]);
  const result = JSON.parse(
    NodeFS.readFileSync(NodePath.join(phaseDir, "result.json"), "utf8"),
  ) as {
    profile: string;
  };
  phases[label] = result;
  return result;
};

install(upstream);
const official = launcher("t3code"),
  officialHome = NodePath.join(home, ".t3"),
  forkHome = NodePath.join(home, ".t3codejp");
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
run("chown", ["-R", `${user}:${user}`, officialHome]);
const officialResult = native("official", official.executable, "0.1.12", officialHome, [
  "--official",
]);
const business = snapshot(officialHome);
NodeAssert.equal(business.threads.length, 2);
NodeAssert.equal(business.messages.length, 3);
verifySettings(officialHome);
const sourceData = tree(officialHome);
const packageFiles = [...run("dpkg-query", ["-L", "t3code"]).split("\n"), "/usr/bin/t3code"].filter(
  (file) => NodeFS.existsSync(file) && !NodeFS.lstatSync(file).isDirectory(),
);
const originalPackage = Object.fromEntries(packageFiles.map((file) => [file, fingerprint(file)]));
const officialMime = /^MimeType=(.+)$/m
  .exec(official.text)?.[1]
  ?.split(";")
  .find(
    (value) =>
      value.startsWith("x-scheme-handler/") &&
      !value.endsWith("/http") &&
      !value.endsWith("/https"),
  );
NodeAssert.ok(officialMime);
userRun("xdg-mime", ["default", NodePath.basename(official.desktop), officialMime]);
const officialAssociation = userRun("xdg-mime", ["query", "default", officialMime]);
NodeAssert.ok(officialAssociation);
const assertOfficial = () => {
  NodeAssert.equal(run("dpkg-query", ["-W", "-f=${Version}", "t3code"]), "0.1.12");
  NodeAssert.deepEqual(
    Object.fromEntries(packageFiles.map((file) => [file, fingerprint(file)])),
    originalPackage,
  );
  NodeAssert.deepEqual(tree(officialHome), sourceData);
  NodeAssert.equal(userRun("xdg-mime", ["query", "default", officialMime]), officialAssociation);
};

install(baseline);
const oldLauncher = launcher("t3codejp");
NodeAssert.notEqual(oldLauncher.desktop, official.desktop);
const fresh = native("fresh", oldLauncher.executable, baselineVersion, forkHome, ["--fresh"]);
NodeAssert.notEqual(fresh.profile, officialResult.profile);
assertOfficial();
NodeFS.renameSync(forkHome, NodePath.join(home, "fresh-fork-backup"));
NodeFS.mkdirSync(forkHome);
NodeFS.cpSync(userdata, NodePath.join(forkHome, "userdata"), { recursive: true });
run("chown", ["-R", `${user}:${user}`, forkHome]);
native("migrated", oldLauncher.executable, baselineVersion, forkHome);
NodeAssert.deepEqual(snapshot(forkHome), business);
verifySettings(forkHome);
assertOfficial();

install(candidate);
const upgradedLauncher = launcher("t3codejp");
NodeAssert.equal(NodePath.basename(upgradedLauncher.desktop), "t3codejp.desktop");
NodeAssert.match(upgradedLauncher.text, /^StartupWMClass=io\.github\.ymsaki\.t3codejp$/m);
const metainfo = NodeFS.readFileSync(
  "/usr/share/metainfo/io.github.ymsaki.t3codejp.metainfo.xml",
  "utf8",
);
NodeAssert.ok(
  metainfo.includes(
    `<launchable type="desktop-id">${NodePath.basename(upgradedLauncher.desktop)}</launchable>`,
  ),
);
if (oldLauncher.desktop !== upgradedLauncher.desktop)
  NodeAssert.equal(NodeFS.existsSync(oldLauncher.desktop), false);
native("upgraded", upgradedLauncher.executable, candidateVersion, forkHome);
run("desktop-file-validate", [upgradedLauncher.desktop]);
NodeAssert.equal(
  NodeFS.existsSync(
    NodePath.join(home, ".local/share/applications", NodePath.basename(upgradedLauncher.desktop)),
  ),
  false,
  "A hidden protocol entry must not shadow the application launcher",
);
NodeAssert.deepEqual(snapshot(forkHome), business);
verifySettings(forkHome);
assertOfficial();
NodeAssert.equal(
  userRun("xdg-mime", ["query", "default", "x-scheme-handler/t3codejp"]),
  "io.github.ymsaki.t3codejp.desktop",
);

const defaultData = tree(NodePath.join(forkHome, "userdata"));
const customHome = NodePath.join(home, "custom [data]'home");
NodeFS.mkdirSync(customHome);
NodeFS.cpSync(NodePath.join(forkHome, "userdata"), NodePath.join(customHome, "userdata"), {
  recursive: true,
});
run("chown", ["-R", `${user}:${user}`, customHome]);
native("custom-home", upgradedLauncher.executable, candidateVersion, customHome, [
  "--home-dir",
  customHome,
]);
NodeAssert.deepEqual(snapshot(customHome), business);
verifySettings(customHome);
NodeAssert.deepEqual(tree(NodePath.join(forkHome, "userdata")), defaultData);
assertOfficial();
const customData = tree(NodePath.join(customHome, "userdata"));
run("dpkg", ["--purge", "t3codejp"]);
NodeAssert.equal(NodeFS.existsSync(upgradedLauncher.executable), false);
NodeAssert.equal(NodeFS.existsSync(upgradedLauncher.desktop), false);
NodeAssert.deepEqual(tree(NodePath.join(forkHome, "userdata")), defaultData);
NodeAssert.deepEqual(tree(NodePath.join(customHome, "userdata")), customData);
assertOfficial();

const imageHome = NodePath.join(home, "appimage-home");
NodeFS.mkdirSync(imageHome);
NodeFS.cpSync(userdata, NodePath.join(imageHome, "userdata"), { recursive: true });
const imagePath = NodePath.join(home, "Applications/T3CodeJP.AppImage");
NodeFS.mkdirSync(NodePath.dirname(imagePath));
NodeFS.copyFileSync(baselineImage, imagePath);
NodeFS.chmodSync(imagePath, 0o755);
run("chown", ["-R", `${user}:${user}`, imageHome, NodePath.dirname(imagePath)]);
native("appimage-baseline", imagePath, baselineVersion, imageHome, ["--home-dir", imageHome]);
NodeAssert.deepEqual(snapshot(imageHome), business);
verifySettings(imageHome);
assertOfficial();
NodeFS.copyFileSync(candidateImage, imagePath);
NodeFS.chmodSync(imagePath, 0o755);
native("appimage-upgraded", imagePath, candidateVersion, imageHome, ["--home-dir", imageHome]);
NodeAssert.deepEqual(snapshot(imageHome), business);
verifySettings(imageHome);
assertOfficial();
const imageData = tree(NodePath.join(imageHome, "userdata"));
NodeFS.unlinkSync(imagePath);
NodeAssert.deepEqual(tree(NodePath.join(imageHome, "userdata")), imageData);
assertOfficial();
const result = {
  architecture,
  upstreamVersion: "0.1.12",
  baselineVersion,
  candidateVersion,
  phases,
  data: business,
  packageFilesVerified: packageFiles.length,
  upstreamPreserved: true,
  migrationPreserved: true,
  customHomePreserved: true,
  debUninstallPreserved: true,
  appImageReplacementPreserved: true,
  appImageRemovalPreserved: true,
};
NodeFS.writeFileSync(NodePath.join(output, "result.json"), JSON.stringify(result, null, 2));
console.log("Linux coexistence, migration, update, and removal checks passed.");

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as HostProcess from "@t3tools/shared/HostProcess";
import { buildRemoteT3RunnerScript } from "@t3tools/ssh/tunnel";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({
  options: {
    "baseline-dir": { type: "string" },
    "candidate-dir": { type: "string" },
    "output-dir": { type: "string" },
  },
});
NodeAssert.equal(HostProcess.Platform.defaultValue(), "linux", "Run SSH proof on Linux.");
NodeAssert.equal(process.env.CI, "true");
NodeAssert.equal(process.env.GITHUB_ACTIONS, "true");
NodeAssert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
NodeAssert.ok(process.env.RUNNER_TEMP);
NodeAssert.ok(values["baseline-dir"] && values["candidate-dir"] && values["output-dir"]);
const requestedOutput = NodePath.resolve(values["output-dir"]);
const output = NodePath.join(
  NodeFS.realpathSync(NodePath.dirname(requestedOutput)),
  NodePath.basename(requestedOutput),
);
NodeAssert.equal(NodeFS.existsSync(output), false, "SSH evidence needs a new output directory.");
const scratch = NodeFS.mkdtempSync(NodePath.join(process.env.RUNNER_TEMP, "t3-cli-ssh-"));
const runtimeRelative = NodePath.relative(output, scratch);
NodeAssert.ok(
  runtimeRelative === ".." || runtimeRelative.startsWith(`..${NodePath.sep}`),
  "Runtime fixtures must stay outside uploaded evidence.",
);
NodeFS.mkdirSync(output);
const remoteHome = NodePath.join(scratch, "remote home [CLI]'proof");
NodeFS.mkdirSync(remoteHome, { mode: 0o700 });
const forkHome = NodePath.join(remoteHome, ".t3codejp");
const upstreamHome = NodePath.join(remoteHome, ".t3");
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: process.env.HOME,
  USER: process.env.USER,
  LOGNAME: process.env.LOGNAME,
  LANG: "C.UTF-8",
  T3CODE_TELEMETRY_ENABLED: "false",
};
const transcript: Array<{ label: string; code: number | null; output: string }> = [];
const run = (command: string, args: string[], label: string, input?: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: scratch,
      env,
      stdio: "pipe",
      signal: AbortSignal.timeout(180_000),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-65536);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-65536);
    });
    child.once("error", reject);
    child.stdin.once("error", reject);
    child.once("close", (code) => {
      transcript.push({
        label,
        code,
        output: `${stdout}\n${stderr}`.replace(/https?:\/\/\S+/g, "[fixture URL]"),
      });
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
const requireSuccess = async (command: string, args: string[], label: string, input?: string) => {
  const result = await run(command, args, label, input);
  NodeAssert.equal(result.code, 0, `${label}: ${result.stdout}\n${result.stderr}`);
  return result;
};
const listen = (server: NodeNet.Server) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      NodeAssert.ok(address && typeof address !== "string");
      resolve(address.port);
    });
  });
const close = (server: NodeNet.Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));
const assets = new Map<string, string>();
const arch = HostProcess.Architecture.defaultValue();
for (const [version, directory] of [
  ["1.0.0", values["baseline-dir"]],
  ["1.0.1", values["candidate-dir"]],
]) {
  NodeAssert.ok(directory);
  for (const name of ["SHA256SUMS", `t3-${version}-linux-${arch}.tar.gz`]) {
    const file = NodePath.join(directory, name);
    NodeAssert.ok(NodeFS.statSync(file).isFile());
    assets.set(`/releases/download/v${version}/${name}`, file);
  }
}
const requests: string[] = [];
let offline = false;
const mirror = NodeHttp.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  requests.push(url.pathname);
  const file = assets.get(url.pathname);
  if (offline || !file || url.search !== "?proof=ssh%2Fdistribution/") {
    response.writeHead(offline ? 503 : 404).end();
    return;
  }
  response.writeHead(200, { "Content-Length": NodeFS.statSync(file).size });
  NodeFS.createReadStream(file).pipe(response);
});
let sshd: NodeChildProcess.ChildProcess | undefined;
let capturedSshdPid: number | undefined;
let mirrorListening = false;
const snapshot = () => {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(forkHome, "userdata/statev2.sqlite"), {
    readOnly: true,
  });
  try {
    return {
      threads: db
        .prepare(
          "SELECT thread_id, title FROM orchestration_v2_projection_threads ORDER BY thread_id",
        )
        .all(),
      messages: db
        .prepare(
          "SELECT message_id, payload_json FROM orchestration_v2_projection_messages ORDER BY message_id",
        )
        .all(),
    };
  } finally {
    db.close();
  }
};
const hash = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
const quoteConfig = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
let proof: Record<string, unknown> | undefined;
let failure: unknown;
try {
  const mirrorPort = await listen(mirror);
  mirrorListening = true;
  const base = `http://127.0.0.1:${mirrorPort}/releases/download?proof=ssh%2Fdistribution/`;
  await requireSuccess(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-f", NodePath.join(scratch, "host")],
    "generate fixture host key",
  );
  await requireSuccess(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-f", NodePath.join(scratch, "client")],
    "generate fixture client key",
  );
  NodeFS.copyFileSync(
    NodePath.join(scratch, "client.pub"),
    NodePath.join(scratch, "authorized_keys"),
  );
  NodeFS.chmodSync(NodePath.join(scratch, "authorized_keys"), 0o600);
  const portProbe = NodeNet.createServer();
  const port = await listen(portProbe);
  await close(portProbe);
  const account = NodeOS.userInfo().username;
  const pidFile = NodePath.join(scratch, "sshd.pid");
  const config = NodePath.join(scratch, "sshd_config");
  NodeFS.writeFileSync(
    config,
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${quoteConfig(NodePath.join(scratch, "host"))}`,
      `PidFile ${quoteConfig(pidFile)}`,
      `AuthorizedKeysFile ${quoteConfig(NodePath.join(scratch, "authorized_keys"))}`,
      `AllowUsers ${account}`,
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "AuthenticationMethods publickey",
      "UsePAM yes",
      "PermitRootLogin no",
      "StrictModes yes",
      "AllowTcpForwarding no",
      "X11Forwarding no",
      `SetEnv ${quoteConfig(`HOME=${remoteHome}`)}`,
      "LogLevel VERBOSE",
      "",
    ].join("\n"),
  );
  await requireSuccess(
    "sudo",
    ["-n", "install", "-d", "-m", "0755", "/run/sshd"],
    "prepare SSH privilege separation",
  );
  const ready = Promise.withResolvers<void>();
  void ready.promise.catch(() => {});
  let sshdLog = "";
  sshd = NodeChildProcess.spawn("sudo", ["-n", "/usr/sbin/sshd", "-D", "-e", "-f", config], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  sshd.stderr?.on("data", (chunk: Buffer) => {
    sshdLog = (sshdLog + chunk.toString()).slice(-65536);
    if (sshdLog.includes("Server listening on 127.0.0.1")) ready.resolve();
  });
  sshd.once("error", ready.reject);
  sshd.once("exit", (code) => ready.reject(new Error(`Owned sshd exited ${code}: ${sshdLog}`)));
  await Promise.race([
    ready.promise,
    NodeTimersPromises.setTimeout(15_000, undefined, { ref: false }).then(() => {
      throw new Error(`Owned sshd did not listen: ${sshdLog}`);
    }),
  ]);
  capturedSshdPid = Number(NodeFS.readFileSync(pidFile, "utf8").trim());
  NodeAssert.ok(Number.isSafeInteger(capturedSshdPid) && capturedSshdPid > 1);
  const knownHosts = NodePath.join(scratch, "known_hosts");
  NodeFS.writeFileSync(
    knownHosts,
    `[127.0.0.1]:${port} ${NodeFS.readFileSync(NodePath.join(scratch, "host.pub"), "utf8")}`,
  );
  const sshArgs = [
    "-T",
    "-p",
    String(port),
    "-i",
    NodePath.join(scratch, "client"),
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    `${account}@127.0.0.1`,
  ];
  const remote = (command: string, label: string, script?: string) =>
    requireSuccess("ssh", [...sshArgs, command], label, script);
  const home = await remote('printf "%s" "$HOME"', "verify isolated SSH home");
  NodeAssert.equal(
    home.stdout,
    remoteHome,
    "Do not run a remote installer against the runner's real home.",
  );
  const upstreamRuntime = NodePath.join(upstreamHome, "runtime/versions/1.0.0");
  NodeFS.mkdirSync(upstreamRuntime, { recursive: true });
  const upstreamExecutable = NodePath.join(upstreamRuntime, "t3");
  NodeFS.writeFileSync(upstreamExecutable, "#!/bin/sh\necho UPSTREAM_SHOULD_NOT_RUN\nexit 98\n", {
    mode: 0o755,
  });
  NodeFS.writeFileSync(NodePath.join(upstreamRuntime, ".install-complete"), "1.0.0\n");
  const upstreamHash = hash(upstreamExecutable);
  const baselineRunner = buildRemoteT3RunnerScript({
    archiveVersion: "1.0.0",
    releaseBaseUrl: base,
  });
  const candidateRunner = buildRemoteT3RunnerScript({
    archiveVersion: "1.0.1",
    releaseBaseUrl: base,
  });
  const baseline = await remote(
    "sh -s -- --version",
    "cold-install the baseline over SSH",
    baselineRunner,
  );
  NodeAssert.match(baseline.stdout, /1\.0\.0\b/);
  NodeAssert.ok(!baseline.stdout.includes("UPSTREAM_SHOULD_NOT_RUN"));
  const userdata = NodePath.join(forkHome, "userdata");
  NodeFS.mkdirSync(userdata, { recursive: true });
  NodeFS.copyFileSync(
    NodePath.join(import.meta.dirname, "fixtures/desktop-launch/statev2.sqlite"),
    NodePath.join(userdata, "statev2.sqlite"),
  );
  NodeFS.writeFileSync(
    NodePath.join(userdata, "client-settings.json"),
    JSON.stringify({ language: "ja", fontSizeInterface: 17 }),
  );
  NodeFS.writeFileSync(
    NodePath.join(userdata, "settings.json"),
    JSON.stringify({ projectSettingsFolded: true }),
  );
  NodeFS.mkdirSync(NodePath.join(userdata, "attachments"));
  const preserved = ["client-settings.json", "settings.json", "attachments/proof.txt"];
  NodeFS.writeFileSync(
    NodePath.join(userdata, "attachments/proof.txt"),
    "Preserve this synthetic SSH attachment.\n",
  );
  const settings = preserved.map((file) => hash(NodePath.join(userdata, file)));
  const data = snapshot();
  NodeAssert.equal(data.threads.length, 2);
  NodeAssert.equal(data.messages.length, 3);
  await remote(
    `T3CODE_RELEASE_BASE_URL='${base}' sh -s -- update 1.0.1 --yes`,
    "install the update over SSH",
    baselineRunner,
  );
  const upgraded = await remote(
    "sh -s -- --version",
    "select the updated SSH runtime",
    candidateRunner,
  );
  NodeAssert.match(upgraded.stdout, /1\.0\.1\b/);
  NodeAssert.deepEqual(snapshot(), data);
  NodeAssert.deepEqual(
    preserved.map((file) => hash(NodePath.join(userdata, file))),
    settings,
  );
  const missing = await run(
    "ssh",
    [...sshArgs, "sh -s -- --version"],
    "reject an unpublished SSH runtime",
    buildRemoteT3RunnerScript({ archiveVersion: "1.0.99", releaseBaseUrl: base }),
  );
  NodeAssert.notEqual(missing.code, 0);
  NodeAssert.match(missing.stderr, /Could not download t3 1\.0\.99\b/);
  NodeAssert.ok(requests.includes("/releases/download/v1.0.99/SHA256SUMS"));
  NodeAssert.equal(hash(upstreamExecutable), upstreamHash);
  offline = true;
  const before = requests.length;
  const cached = await remote(
    "sh -s -- --version",
    "reuse the cached runtime offline",
    candidateRunner,
  );
  NodeAssert.match(cached.stdout, /1\.0\.1\b/);
  NodeAssert.equal(
    requests.length,
    before,
    "The installed SSH runtime must start without downloading again.",
  );
  NodeAssert.deepEqual(snapshot(), data);
  proof = {
    platform: `linux-${arch}`,
    baseline: "1.0.0",
    candidate: "1.0.1",
    realSsh: true,
    isolatedHome: true,
    upstreamPreserved: true,
    dataPreserved: true,
    settingsPreserved: true,
    missingReleaseRejected: true,
    cachedRuntimeStartsOffline: true,
    data,
    requests,
  };
} catch (error) {
  failure = error;
} finally {
  if (sshd) {
    const captured = sshd;
    const exited = new Promise<void>((resolve) => {
      if (captured.exitCode !== null || captured.signalCode !== null) resolve();
      else captured.once("exit", () => resolve());
    });
    captured.kill("SIGTERM");
    await Promise.race([exited, NodeTimersPromises.setTimeout(10_000, undefined, { ref: false })]);
    if (captured.exitCode === null && captured.signalCode === null && capturedSshdPid) {
      await run("sudo", ["-n", "kill", "-KILL", String(capturedSshdPid)], "stop the captured sshd");
      await Promise.race([
        exited,
        NodeTimersPromises.setTimeout(10_000, undefined, { ref: false }).then(() => {
          failure ??= new Error("The captured SSH daemon did not stop.");
        }),
      ]);
    }
  }
  if (mirrorListening) await close(mirror);
  NodeFS.writeFileSync(
    NodePath.join(output, "transcript.json"),
    JSON.stringify(transcript, null, 2),
  );
  if (failure) NodeFS.writeFileSync(NodePath.join(output, "failure.txt"), String(failure));
  if (proof && !failure)
    NodeFS.writeFileSync(NodePath.join(output, "result.json"), JSON.stringify(proof, null, 2));
  NodeFS.rmSync(scratch, { recursive: true, force: true });
}
if (failure) throw failure;
console.log("SSH CLI installation, update, preservation, and offline reuse passed.");

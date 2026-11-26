// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalTimers:off - Native smoke proof uses Node subprocesses and loopback HTTP.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import {
  AuthBrowserSessionResult,
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  OrchestrationV2ShellHttpSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Schema from "effect/Schema";

const decodeDescriptor = Schema.decodeUnknownSync(
  Schema.toCodecJson(ExecutionEnvironmentDescriptor),
);
const decodeBootstrap = Schema.decodeUnknownSync(Schema.toCodecJson(AuthBrowserSessionResult));
const decodeShell = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ShellHttpSnapshot));
const decodeThread = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot),
);
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeProofSettings = Schema.decodeUnknownSync(ServerSettings, { onExcessProperty: "error" });
const BASELINE = "1.0.0";
const CANDIDATE = "1.0.1";
const RELEASES_PATH = "/repos/YmSaki/t3codeJP/releases";
const UPSTREAM_PATH = "/repos/pingdotgg/t3code/releases";
const MIRROR_QUERY = "proof=synthetic-mirror-query";
const FIXTURE_DB = NodePath.join(import.meta.dirname, "fixtures/desktop-launch/statev2.sqlite");
const { values } = NodeUtil.parseArgs({
  options: {
    "baseline-dir": { type: "string" },
    "candidate-dir": { type: "string" },
    "output-dir": { type: "string" },
    ssh: { type: "boolean", default: false },
  },
});

if (
  process.env.CI !== "true" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
  !process.env.RUNNER_TEMP
) {
  throw new Error("CLI distribution proof requires a GitHub-hosted Actions runner with CI=true.");
}
if (values.ssh) {
  throw new Error("SSH proof belongs to the separate smoke-cli-ssh.ts helper; omit --ssh here.");
}
if (!values["baseline-dir"] || !values["candidate-dir"] || !values["output-dir"]) {
  throw new Error(
    "Usage: smoke-cli-distribution.ts --baseline-dir <assets> --candidate-dir <assets> --output-dir <new directory>",
  );
}
const platform = HostProcess.Platform.defaultValue();
const arch = HostProcess.Architecture.defaultValue();
const platformKey = `${platform}-${arch}`;
NodeAssert.ok(
  ["linux-x64", "linux-arm64", "darwin-arm64", "win32-x64", "win32-arm64"].includes(platformKey),
  `No native CLI archive exists for ${platformKey}.`,
);
const runnerTemp = NodeFS.realpathSync(process.env.RUNNER_TEMP);
const requestedOutput = NodePath.resolve(values["output-dir"]);
const outputDir = NodePath.join(
  NodeFS.realpathSync(NodePath.dirname(requestedOutput)),
  NodePath.basename(requestedOutput),
);
NodeAssert.ok(!NodeFS.existsSync(outputDir), "Proof output must be a new directory.");
NodeAssert.ok(
  NodeFS.statSync(NodePath.dirname(outputDir)).isDirectory(),
  "Proof output parent must already exist.",
);
const outputParent = NodeFS.realpathSync(NodePath.dirname(outputDir));
const inside = (parent: string, child: string) => {
  const relative = NodePath.relative(parent, child);
  return (
    relative === "" ||
    (!NodePath.isAbsolute(relative) &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      relative !== "..")
  );
};
NodeAssert.ok(!inside(outputDir, runnerTemp), "RUNNER_TEMP must not be inside uploaded output.");
const scratch = NodeFS.mkdtempSync(NodePath.join(runnerTemp, "t3-cli-distribution-"));
NodeAssert.ok(!inside(scratch, outputParent), "Proof output must not contain runtime fixtures.");
NodeFS.mkdirSync(outputDir);

type Phase =
  | "setup"
  | "fresh"
  | "baseline-ready"
  | "missing"
  | "corrupt"
  | "update"
  | "candidate-ready"
  | "offline";
type RequestProof = {
  phase: Phase;
  kind: string;
  method: string;
  path: string;
  status: number;
  queryPreserved?: boolean;
};
type CommandProof = {
  step: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};
type StagedRelease = {
  directory: string;
  version: string;
  archive: string;
  sha256: string;
  metadata: unknown;
};
let phase: Phase = "setup";
let mirrorMode: "normal" | "missing" | "corrupt" | "offline" = "normal";
const requests: RequestProof[] = [];
const commands: CommandProof[] = [];
const checks: string[] = [];
const secrets = new Set<string>();
const children = new Set<NodeChildProcess.ChildProcess>();
const servers: NodeNet.Server[] = [];
const sockets = new Set<NodeNet.Socket>();
const cancellation = new AbortController();
const cancel = () => {
  cancellation.abort(new Error("CLI distribution proof interrupted."));
  for (const child of children) void stop(child);
};
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
let failure: string | undefined;
let baseline: StagedRelease | undefined;
let candidate: StagedRelease | undefined;

const clean = (text: string) => {
  let result = text.replaceAll(scratch, "<runtime>");
  for (const secret of secrets) result = result.replaceAll(secret, "<redacted>");
  return result
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(
      /^.*(?:Pairing URL:|App link:|Token:|Connection string:).*$/gim,
      "<startup credential omitted>",
    )
    .replace(/^[ \t]*[█▀▄ ]+[ \t]*$/gm, "")
    .replace(/([?#&](?:token|access_token|credential)=)[^\s&#]+/gi, "$1<redacted>");
};
const writeJson = (name: string, value: unknown) =>
  NodeFS.writeFileSync(
    NodePath.join(outputDir, name),
    `${JSON.stringify(value, (_key, item: unknown) => (typeof item === "string" ? clean(item) : item), 2)}\n`,
  );
const hashFile = async (file: string) => {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
const record = (value: unknown): Record<string, unknown> => {
  NodeAssert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected a JSON object.",
  );
  return value as Record<string, unknown>;
};
const readJson = (file: string): unknown => JSON.parse(NodeFS.readFileSync(file, "utf8"));

const home = NodePath.join(scratch, "home");
const t3Home = NodePath.join(home, ".t3codejp");
const stateDir = NodePath.join(t3Home, "userdata");
const binDir = NodePath.join(t3Home, "cli-bin");
const tempDir = NodePath.join(scratch, "tmp");
const workDir = NodePath.join(scratch, "workspace");
for (const directory of [home, stateDir, binDir, tempDir, workDir])
  NodeFS.mkdirSync(directory, { recursive: true });
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const systemBin = NodePath.join(systemRoot, "System32");
const systemPath =
  platform === "win32"
    ? [systemBin, systemRoot, NodePath.join(systemBin, "WindowsPowerShell/v1.0")].join(
        NodePath.delimiter,
      )
    : "/usr/bin:/bin:/usr/sbin:/sbin";
// Credentials, provider homes, NODE_OPTIONS, and all ambient T3 variables are deliberately absent.
const env: NodeJS.ProcessEnv = {
  PATH: `${binDir}${NodePath.delimiter}${systemPath}`,
  HOME: home,
  USERPROFILE: home,
  APPDATA: NodePath.join(home, "AppData/Roaming"),
  LOCALAPPDATA: NodePath.join(home, "AppData/Local"),
  XDG_CONFIG_HOME: NodePath.join(home, ".config"),
  XDG_DATA_HOME: NodePath.join(home, ".local/share"),
  XDG_CACHE_HOME: NodePath.join(home, ".cache"),
  XDG_STATE_HOME: NodePath.join(home, ".local/state"),
  TMPDIR: tempDir,
  TMP: tempDir,
  TEMP: tempDir,
  T3CODE_HOME: t3Home,
  T3CODE_INSTALL_BIN_DIR: binDir,
  T3CODE_TELEMETRY_ENABLED: "false",
  T3CODE_DISABLE_AUTO_UPDATE: "true",
  T3CODE_DEV_SEED: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: NodePath.join(home, ".gitconfig"),
  NO_COLOR: "1",
  TERM: "dumb",
  CI: "true",
  ...(platform === "win32"
    ? {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        PROCESSOR_ARCHITECTURE: arch === "arm64" ? "ARM64" : "AMD64",
      }
    : {}),
};

function start(command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  cancellation.signal.throwIfAborted();
  const child = NodeChildProcess.spawn(command, args, {
    cwd: workDir,
    env: { ...env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => {
    stdout = (stdout + data.toString()).slice(-4_000_000);
  });
  child.stderr.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-4_000_000);
  });
  const done = new Promise<{ exitCode: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        children.delete(child);
        resolve({ exitCode, signal });
      });
    },
  );
  // Readiness observes early exits; handle spawn errors before its listeners attach.
  void done.catch(() => {});
  return { child, done, output: () => ({ stdout, stderr }) };
}
async function stop(child: NodeChildProcess.ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = NodeChildProcess.spawn(
        NodePath.join(systemBin, "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        {
          env,
          windowsHide: true,
          stdio: "ignore",
        },
      );
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
  } else {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("close", () => resolve())),
      NodeTimersPromises.setTimeout(5_000, undefined, { ref: false }),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
async function run(
  step: string,
  executable: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  expectSuccess = true,
) {
  const process = start(executable, args, extraEnv);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void stop(process.child);
  }, 120_000);
  try {
    const result = await process.done;
    const output = process.output();
    commands.push({ step, ...result, stdout: clean(output.stdout), stderr: clean(output.stderr) });
    writeJson("commands.json", commands);
    cancellation.signal.throwIfAborted();
    NodeAssert.ok(!timedOut, `${step} timed out.`);
    if (expectSuccess)
      NodeAssert.equal(
        result.exitCode,
        0,
        `${step} failed: ${clean(output.stdout + output.stderr)}`,
      );
    return { ...result, ...output };
  } finally {
    clearTimeout(timer);
  }
}
const cli = (step: string, args: string[], expectSuccess = true) =>
  platform === "win32"
    ? run(
        step,
        NodePath.join(systemBin, "cmd.exe"),
        ["/d", "/s", "/c", ["t3", ...args].join(" ")],
        {},
        expectSuccess,
      )
    : run(step, "t3", args, {}, expectSuccess);
const versionDir = (version: string) => NodePath.join(t3Home, "runtime/versions", version);
const runtimeExe = (version: string) =>
  NodePath.join(versionDir(version), platform === "win32" ? "t3.exe" : "t3");
const launcher = NodePath.join(binDir, platform === "win32" ? "t3.cmd" : "t3");

async function stagedRelease(directory: string, version: string): Promise<StagedRelease> {
  directory = NodeFS.realpathSync(NodePath.resolve(directory));
  NodeAssert.ok(
    !inside(directory, outputDir) && !inside(outputDir, directory),
    "Inputs and output must be disjoint.",
  );
  const archive = `t3-${version}-${platformKey}.${platform === "win32" ? "zip" : "tar.gz"}`;
  const checksums = new Map<string, string>();
  for (const line of NodeFS.readFileSync(NodePath.join(directory, "SHA256SUMS"), "utf8").split(
    /\r?\n/,
  )) {
    if (line === "") continue;
    const match = /^([a-fA-F0-9]{64})  \*?([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    NodeAssert.ok(match?.[1] && match[2], "Malformed staged checksum entry.");
    NodeAssert.ok(!checksums.has(match[2]), "Duplicate staged checksum entry.");
    checksums.set(match[2], match[1].toLowerCase());
  }
  for (const name of [archive, "install.sh", "install.ps1", "t3code-release.json"]) {
    const file = NodePath.join(directory, name);
    NodeAssert.ok(
      NodeFS.lstatSync(file).isFile(),
      `Required staged asset is not a regular file: ${name}`,
    );
    NodeAssert.equal(
      await hashFile(file),
      checksums.get(name),
      `Staged checksum mismatch: ${name}`,
    );
  }
  const metadata = readJson(NodePath.join(directory, "t3code-release.json"));
  NodeAssert.equal(record(metadata).version, version, "Staged release version mismatch.");
  const migration = record(record(metadata).t3code).databaseMigration;
  NodeAssert.ok(
    typeof migration === "number" && Number.isSafeInteger(migration) && migration >= 0,
    "Missing staged migration ID.",
  );
  return {
    directory,
    version,
    archive,
    sha256: checksums.get(archive)!,
    metadata: { version, t3code: { databaseMigration: migration } },
  };
}

async function listen(server: NodeNet.Server) {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  NodeAssert.ok(address !== null && typeof address !== "string");
  return address.port;
}

async function networkFixtures(baseline: StagedRelease, candidate: StagedRelease) {
  const ca = NodePath.join(scratch, "ca.pem");
  const caKey = NodePath.join(scratch, "ca-key.pem");
  const key = NodePath.join(scratch, "api-key.pem");
  const cert = NodePath.join(scratch, "api.pem");
  const csr = NodePath.join(scratch, "api.csr");
  const extensions = NodePath.join(scratch, "api.ext");
  NodeFS.writeFileSync(
    extensions,
    "subjectAltName=DNS:api.github.com\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n",
  );
  const openssl = findOpenSsl();
  await run("create synthetic CA", openssl, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    ca,
    "-days",
    "1",
    "-subj",
    "/CN=T3 CLI distribution proof CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  await run("create API certificate request", openssl, [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    csr,
    "-subj",
    "/CN=api.github.com",
  ]);
  await run("sign API certificate", openssl, [
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    ca,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    cert,
    "-days",
    "1",
    "-extfile",
    extensions,
  ]);
  const decoy = Buffer.from("synthetic upstream same-version archive: must never be installed\n");
  const decoyHash = NodeCrypto.createHash("sha256").update(decoy).digest("hex");
  NodeAssert.notEqual(decoyHash, candidate.sha256);
  const mirror = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const queryPreserved = url.search.slice(1) === MIRROR_QUERY;
    const parts = /^\/(download|upstream)\/v(1\.0\.[01])\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
    const release = parts?.[2] === BASELINE ? baseline : candidate;
    const name = parts?.[3];
    let status =
      !parts || !name || !queryPreserved || request.method !== "GET"
        ? 400
        : mirrorMode === "offline"
          ? 503
          : 200;
    const isCandidateArchive = parts?.[2] === CANDIDATE && name === candidate.archive;
    if (isCandidateArchive && mirrorMode === "missing") status = 404;
    const allowed = [
      release.archive,
      "install.sh",
      "install.ps1",
      "t3code-release.json",
      "SHA256SUMS",
    ];
    if (name && !allowed.includes(name)) status = 404;
    requests.push({
      phase,
      kind: parts?.[1] === "upstream" ? "upstream-decoy-asset" : "archive",
      method: request.method ?? "",
      path: url.pathname,
      status,
      queryPreserved,
    });
    response.statusCode = status;
    if (status !== 200) {
      response.end("synthetic unavailable asset\n");
      return;
    }
    if (parts?.[1] === "upstream") {
      response.end(decoy);
      return;
    }
    if (isCandidateArchive && mirrorMode === "corrupt") {
      response.end("intentionally corrupt candidate archive\n");
      return;
    }
    const file = NodePath.join(release.directory, name!);
    response.setHeader("Content-Length", NodeFS.statSync(file).size);
    const stream = NodeFS.createReadStream(file);
    stream.on("error", () => response.destroy());
    response.once("close", () => stream.destroy());
    stream.pipe(response);
  });
  const mirrorPort = await listen(mirror);
  const mirrorOrigin = `http://127.0.0.1:${mirrorPort}`;
  const releaseIndex = (upstream: boolean) => [
    {
      tag_name: `v${CANDIDATE}`,
      draft: false,
      prerelease: false,
      html_url: `https://github.com/${upstream ? "pingdotgg/t3code" : "YmSaki/t3codeJP"}/releases/tag/v${CANDIDATE}`,
      assets: [
        {
          name: candidate.archive,
          browser_download_url: `${mirrorOrigin}/${upstream ? "upstream" : "download"}/v${CANDIDATE}/${candidate.archive}?${MIRROR_QUERY}`,
        },
      ],
    },
  ];
  writeJson("synthetic-release-index.json", {
    fork: releaseIndex(false),
    upstreamDecoy: releaseIndex(true),
    upstreamDecoySha256: decoyHash,
  });
  const api = NodeHttps.createServer(
    { key: NodeFS.readFileSync(key), cert: NodeFS.readFileSync(cert) },
    (request, response) => {
      const url = new URL(request.url ?? "/", "https://api.github.com");
      const upstream = url.pathname === UPSTREAM_PATH;
      const valid =
        (url.pathname === RELEASES_PATH || upstream) &&
        request.method === "GET" &&
        request.headers.host === "api.github.com" &&
        url.searchParams.get("per_page") === "100" &&
        url.searchParams.get("page") === "1";
      const status = mirrorMode === "offline" ? 503 : valid ? 200 : 404;
      requests.push({
        phase,
        kind: upstream ? "upstream-decoy-index" : "github-api",
        method: request.method ?? "",
        path: url.pathname + url.search,
        status,
      });
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          status === 200 ? releaseIndex(upstream) : { message: "fixture refused request" },
        ),
      );
    },
  );
  const apiPort = await listen(api);
  const proxy = NodeHttp.createServer((request, response) => {
    requests.push({
      phase,
      kind: "blocked-proxy-request",
      method: request.method ?? "",
      path: "/blocked",
      status: 502,
    });
    response.writeHead(502).end();
  });
  proxy.on("connect", (request, client, head) => {
    if (request.url !== "api.github.com:443" || mirrorMode === "offline") {
      requests.push({
        phase,
        kind: "blocked-connect",
        method: "CONNECT",
        path: request.url === "api.github.com:443" ? "api.github.com:443" : "<unexpected-host>",
        status: 502,
      });
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    const upstream = NodeNet.connect(apiPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  Object.assign(env, {
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    NODE_EXTRA_CA_CERTS: ca,
    T3CODE_RELEASE_BASE_URL: `${mirrorOrigin}/download/?${MIRROR_QUERY}`,
  });
}

function findOpenSsl() {
  if (platform !== "win32") return "/usr/bin/openssl";
  const isFile = (path: string) => {
    try {
      return NodeFS.statSync(path).isFile();
    } catch {
      return false;
    }
  };
  const roots = new Set(
    [
      process.env.ProgramFiles,
      process.env.ProgramW6432,
      process.env["ProgramFiles(x86)"],
      "C:\\Program Files",
      "C:\\Program Files (x86)",
    ]
      .filter(
        (directory): directory is string =>
          directory !== undefined && NodePath.isAbsolute(directory),
      )
      .map((directory) => NodePath.join(directory, "Git")),
  );
  // Inspect Git locations on the runner's PATH without passing that PATH to children.
  for (const entry of (process.env.PATH ?? process.env.Path ?? "").split(NodePath.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (NodePath.isAbsolute(directory) && isFile(NodePath.join(directory, "git.exe"))) {
      roots.add(directory);
      roots.add(NodePath.dirname(directory));
      roots.add(NodePath.dirname(NodePath.dirname(directory)));
    }
  }
  const executable = [...roots]
    .flatMap((root) =>
      ["usr/bin", "mingw64/bin", "clangarm64/bin"].map((bin) =>
        NodePath.join(root, bin, "openssl.exe"),
      ),
    )
    .find(isFile);
  NodeAssert.ok(
    executable,
    "Git for Windows OpenSSL was not found in Program Files or runner Git locations.",
  );
  return NodeFS.realpathSync(executable);
}

function stringField(value: unknown) {
  NodeAssert.ok(typeof value === "string", "Expected a string in the V2 projection payload.");
  return value;
}
function databaseSnapshot(file = NodePath.join(stateDir, "statev2.sqlite")) {
  const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    NodeAssert.equal(db.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
    return {
      threads: db
        .prepare(
          "SELECT thread_id, project_id, title, payload_json FROM orchestration_v2_projection_threads ORDER BY thread_id",
        )
        .all()
        .map((row) => {
          const payload = record(JSON.parse(stringField(row.payload_json)));
          NodeAssert.equal(payload.id, row.thread_id);
          NodeAssert.equal(payload.projectId, row.project_id);
          NodeAssert.equal(payload.title, row.title);
          return {
            id: stringField(payload.id),
            projectId: stringField(payload.projectId),
            title: stringField(payload.title),
          };
        }),
      messages: db
        .prepare(
          "SELECT message_id, thread_id, role, payload_json FROM orchestration_v2_projection_messages ORDER BY message_id",
        )
        .all()
        .map((row) => {
          const payload = record(JSON.parse(stringField(row.payload_json)));
          NodeAssert.equal(payload.id, row.message_id);
          NodeAssert.equal(payload.threadId, row.thread_id);
          NodeAssert.equal(payload.role, row.role);
          return {
            id: stringField(payload.id),
            threadId: stringField(payload.threadId),
            role: stringField(payload.role),
            text: stringField(payload.text),
          };
        }),
    };
  } finally {
    db.close();
  }
}
const settings = {
  telemetryEnabled: false,
  compactIdleThreads: false,
  idleCompaction: "off",
  enableProviderUpdateChecks: false,
  continueThreadsAfterServerUpdate: false,
} satisfies ServerSettingsPatch;
function assertSettings() {
  const actual = record(decodeSettings(readJson(NodePath.join(stateDir, "settings.json"))));
  for (const [key, value] of Object.entries(settings))
    NodeAssert.equal(actual[key], value, `Setting ${key} was not preserved.`);
  const clientSettings = record(readJson(NodePath.join(stateDir, "client-settings.json")));
  NodeAssert.equal(clientSettings.language, "ja");
  NodeAssert.equal(clientSettings.fontSizeInterface, 17);
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(stateDir, "attachments/cli-proof.txt"), "utf8"),
    "Preserve this synthetic CLI attachment.\n",
  );
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(home, ".config/t3-proof/config.txt"), "utf8"),
    "synthetic configuration must survive\n",
  );
}
async function install(release: StagedRelease, step: string) {
  const script = NodePath.join(
    release.directory,
    platform === "win32" ? "install.ps1" : "install.sh",
  );
  if (platform === "win32") {
    await run(
      step,
      NodePath.join(systemBin, "WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { T3CODE_VERSION: release.version },
    );
  } else {
    await run(step, "/bin/sh", [script], { T3CODE_VERSION: release.version });
  }
}
async function assertVersion(version: string) {
  const output = await cli(`t3 --version (${version})`, ["--version"]);
  NodeAssert.ok(
    [version, `t3 v${version}`, `t3 ${version}`].includes(clean(output.stdout).trim()),
    "PATH-resolved t3 has the wrong version.",
  );
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(versionDir(version), ".install-complete"), "utf8").trim(),
    version,
  );
  NodeAssert.ok(
    NodeFS.readFileSync(launcher, "utf8").includes(runtimeExe(version)),
    "Launcher does not select the expected runtime.",
  );
}
function assertDiscovery(currentPhase: Phase) {
  NodeAssert.ok(
    requests.some(
      (request) =>
        request.phase === currentPhase &&
        request.kind === "github-api" &&
        request.path.startsWith(`${RELEASES_PATH}?`) &&
        request.status === 200,
    ),
    `${currentPhase}: no real API-client request to the fork release index.`,
  );
  NodeAssert.ok(
    !requests.some((request) => request.kind.startsWith("upstream-decoy")),
    "The updater contacted the same-version upstream decoy.",
  );
}
async function httpJson(origin: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    signal: AbortSignal.any([
      cancellation.signal,
      AbortSignal.timeout(2_000),
      ...(init.signal ? [init.signal] : []),
    ]),
  });
  NodeAssert.equal(response.status, 200, `Backend request failed: ${path}`);
  return response.json();
}
async function ready(version: string, expected: ReturnType<typeof databaseSnapshot>) {
  const reservation = NodeNet.createServer();
  const port = await listen(reservation);
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const origin = `http://127.0.0.1:${port}`;
  // Start the executable directly so the recorded PID is the server even on Windows.
  const server = start(runtimeExe(version), [
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--no-browser",
  ]);
  try {
    const credential = await new Promise<string>((resolve, reject) => {
      const watcher = NodeFS.watch(stateDir);
      let credential: string | undefined;
      let ownedRuntime = false;
      let settled = false;
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              "serve did not publish its owned runtime record and bootstrap credential within 60 seconds.",
            ),
          ),
        60_000,
      );
      function finish(error?: unknown) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        watcher.close();
        server.child.stdout.off("data", onOutput);
        server.child.stderr.off("data", onOutput);
        cancellation.signal.removeEventListener("abort", onAbort);
        if (error !== undefined) reject(error);
        else resolve(credential!);
      }
      function checkReady() {
        if (ownedRuntime && credential) finish();
      }
      function onOutput() {
        // Require the newline so a split stdout chunk cannot publish a partial token.
        credential = /(?:^|\n)[ \t]*Token:[ \t]*([^\r\n \t]+)[ \t]*\r?\n/.exec(
          server.output().stdout,
        )?.[1];
        if (credential) secrets.add(credential);
        checkReady();
      }
      function onRuntime() {
        try {
          const runtime = record(readJson(NodePath.join(stateDir, "server-runtime.json")));
          ownedRuntime =
            runtime.pid === server.child.pid &&
            runtime.serverVersion === version &&
            runtime.port === port &&
            runtime.origin === origin;
          checkReady();
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
            finish(error);
        }
      }
      function onAbort() {
        finish(cancellation.signal.reason);
      }
      watcher.on("change", (_event, name) => {
        if (name === null || name === "server-runtime.json") onRuntime();
      });
      watcher.once("error", finish);
      server.child.stdout.on("data", onOutput);
      server.child.stderr.on("data", onOutput);
      cancellation.signal.addEventListener("abort", onAbort, { once: true });
      void server.done.then(() => finish(new Error("serve exited before readiness.")), finish);
      if (cancellation.signal.aborted) onAbort();
      // Register first, then inspect once to cover publication before the listeners attached.
      onRuntime();
      onOutput();
    });
    const descriptor = decodeDescriptor(await httpJson(origin, "/.well-known/t3/environment"));
    NodeAssert.equal(descriptor.serverVersion, version);
    NodeAssert.equal(descriptor.orchestrationProtocolVersion, ORCHESTRATION_PROTOCOL_VERSION);
    const response = await fetch(`${origin}/api/auth/browser-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ credential }),
      signal: AbortSignal.timeout(10_000),
    });
    NodeAssert.equal(response.status, 200, "Startup bootstrap failed.");
    const bootstrap = decodeBootstrap(await response.json());
    NodeAssert.equal(bootstrap.authenticated, true);
    const cookie = response.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    NodeAssert.ok(cookie, "Startup bootstrap did not create a browser session.");
    secrets.add(cookie);
    const headers = {
      Cookie: cookie,
      [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
    };
    const shell = decodeShell(await httpJson(origin, "/api/orchestration/shell", { headers }));
    for (const thread of expected.threads) {
      NodeAssert.ok(
        shell.threads.some(
          (actual) =>
            actual.id === thread.id &&
            actual.projectId === thread.projectId &&
            actual.title === thread.title,
        ),
        "A seeded thread is absent from the backend shell.",
      );
      const snapshot = decodeThread(
        await httpJson(origin, `/api/orchestration/threads/${encodeURIComponent(thread.id)}`, {
          headers,
        }),
      );
      NodeAssert.equal(snapshot.projection.thread.id, thread.id);
      NodeAssert.deepEqual(
        snapshot.projection.messages
          .map(({ id, threadId, role, text }) => ({ id, threadId, role, text }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        expected.messages
          .filter((message) => message.threadId === thread.id)
          .sort((a, b) => a.id.localeCompare(b.id)),
        "V2 backend messages differ from the persisted fixture.",
      );
    }
    const html = await fetch(origin, { signal: AbortSignal.timeout(2_000) });
    NodeAssert.equal(html.status, 200);
    NodeAssert.ok((await html.text()).includes("<html"), "Packaged client did not serve HTML.");
    writeJson(`${phase}-bootstrap.json`, {
      version: descriptor.serverVersion,
      orchestrationProtocolVersion: descriptor.orchestrationProtocolVersion,
      authenticated: true,
      persistence: "orchestration_v2_projection_threads/messages",
      threads: expected.threads,
      messages: expected.messages,
      clientStatus: 200,
    });
  } finally {
    await stop(server.child);
    await server.done;
    const credential = /(?:^|\n)\s*Token:\s*(\S+)/.exec(
      server.output().stdout + server.output().stderr,
    )?.[1];
    if (credential) secrets.add(credential);
    commands.push({
      step: `${phase}: serve and bootstrap`,
      exitCode: server.child.exitCode,
      signal: server.child.signalCode,
      stdout: clean(server.output().stdout),
      stderr: clean(server.output().stderr),
    });
    writeJson("commands.json", commands);
  }
  NodeAssert.deepEqual(databaseSnapshot(), expected, "serve changed the seeded conversation data.");
  assertSettings();
}

try {
  decodeProofSettings(settings);
  baseline = await stagedRelease(values["baseline-dir"], BASELINE);
  candidate = await stagedRelease(values["candidate-dir"], CANDIDATE);
  writeJson(
    "staged-assets.json",
    [baseline, candidate].map(({ version, archive, sha256, metadata }) => ({
      version,
      archive,
      sha256,
      metadata,
    })),
  );
  await networkFixtures(baseline, candidate);
  phase = "fresh";
  await install(baseline, "fresh exact baseline install");
  await assertVersion(BASELINE);
  NodeAssert.ok(
    !requests.some((request) => request.kind === "github-api"),
    "Exact installer unexpectedly performed latest discovery.",
  );
  NodeAssert.ok(
    requests.some(
      (request) => request.path.endsWith(`/${baseline!.archive}`) && request.status === 200,
    ),
    "Fresh install did not download the actual baseline archive.",
  );
  checks.push("native fresh install from actual baseline archive via exact T3CODE_VERSION");

  NodeFS.copyFileSync(FIXTURE_DB, NodePath.join(stateDir, "statev2.sqlite"));
  const fixture = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "statev2.sqlite"));
  try {
    const [project] = fixture.prepare("SELECT workspace_root FROM projection_projects").all();
    NodeAssert.ok(project && typeof project.workspace_root === "string");
    fixture.prepare("UPDATE projection_projects SET workspace_root = ?").run(workDir);
    fixture
      .prepare("UPDATE orchestration_events SET payload_json = replace(payload_json, ?, ?)")
      .run(
        JSON.stringify(project.workspace_root).slice(1, -1),
        JSON.stringify(workDir).slice(1, -1),
      );
  } finally {
    fixture.close();
  }
  NodeFS.writeFileSync(NodePath.join(stateDir, "settings.json"), `${JSON.stringify(settings)}\n`);
  NodeFS.writeFileSync(
    NodePath.join(stateDir, "client-settings.json"),
    JSON.stringify({
      language: "ja",
      fontSizeInterface: 17,
    }),
  );
  NodeFS.mkdirSync(NodePath.join(stateDir, "attachments"));
  NodeFS.writeFileSync(
    NodePath.join(stateDir, "attachments/cli-proof.txt"),
    "Preserve this synthetic CLI attachment.\n",
  );
  NodeFS.mkdirSync(NodePath.join(home, ".config/t3-proof"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(home, ".config/t3-proof/config.txt"),
    "synthetic configuration must survive\n",
  );
  const expected = databaseSnapshot();
  NodeAssert.equal(expected.threads.length, 2);
  NodeAssert.equal(expected.messages.length, 3);
  phase = "baseline-ready";
  await ready(BASELINE, expected);
  checks.push("baseline backend, client, startup bootstrap and two threads / three messages");
  const baselineLauncherHash = await hashFile(launcher);
  for (const mode of ["missing", "corrupt"] as const) {
    phase = mode;
    mirrorMode = mode;
    const result = await cli(`${mode} candidate: t3 update --yes`, ["update", "--yes"], false);
    NodeAssert.notEqual(result.exitCode, 0, `Accepted ${mode} candidate.`);
    NodeAssert.equal(result.signal, null, "Refusal must be a CLI exit, not a timeout or signal.");
    NodeAssert.match(
      result.stdout + result.stderr,
      mode === "missing" ? /No release archive|downloading the t3 release archive/i : /checksum/i,
      "CLI failed for a reason other than the intended refusal.",
    );
    assertDiscovery(phase);
    NodeAssert.ok(
      requests.some(
        (request) =>
          request.phase === phase &&
          request.path.endsWith(`/${candidate!.archive}`) &&
          request.status === (mode === "missing" ? 404 : 200),
      ),
      "Refusal did not exercise the candidate archive request.",
    );
    NodeAssert.equal(
      await hashFile(launcher),
      baselineLauncherHash,
      "Refusal changed the launcher.",
    );
    NodeAssert.ok(
      !NodeFS.existsSync(NodePath.join(versionDir(CANDIDATE), ".install-complete")),
      "Refusal published the candidate runtime.",
    );
    await assertVersion(BASELINE);
    NodeAssert.deepEqual(databaseSnapshot(), expected);
    assertSettings();
    checks.push(
      `${mode} candidate refused; baseline launcher and conversation/configuration preserved`,
    );
  }
  phase = "update";
  mirrorMode = "normal";
  await cli("unqualified t3 update --yes", ["update", "--yes"]);
  assertDiscovery(phase);
  NodeAssert.ok(
    requests.some(
      (request) =>
        request.phase === phase &&
        request.path.endsWith(`/${candidate!.archive}`) &&
        request.status === 200,
    ),
    "Update did not fetch the real candidate archive.",
  );
  await assertVersion(CANDIDATE);
  NodeAssert.deepEqual(databaseSnapshot(), expected);
  assertSettings();
  checks.push("unqualified update selected fork latest despite same-version upstream decoy");
  phase = "candidate-ready";
  await ready(CANDIDATE, expected);
  checks.push(
    "updated backend/client/bootstrap ready; all seeded conversation data and settings preserved",
  );

  phase = "offline";
  mirrorMode = "offline";
  const requestCount = requests.length;
  await install(baseline, "offline cached baseline installer reuse");
  await assertVersion(BASELINE);
  await cli("offline cached t3 update 1.0.1 --yes", ["update", CANDIDATE, "--yes"]);
  await assertVersion(CANDIDATE);
  NodeAssert.equal(
    requests.length,
    requestCount,
    "Cached exact-version reuse contacted a release fixture.",
  );
  NodeAssert.deepEqual(databaseSnapshot(), expected);
  assertSettings();
  checks.push(
    "offline cached installer/runtime reuse with explicit versions (latest discovery requires network)",
  );
  NodeAssert.ok(
    requests
      .filter((request) => request.kind === "archive")
      .every((request) => request.queryPreserved),
    "Archive mirror dropped the query.",
  );
  NodeAssert.ok(
    !requests.some((request) => request.kind.startsWith("upstream-decoy")),
    "Updater selected the upstream decoy.",
  );
  NodeAssert.ok(
    !requests.some(
      (request) =>
        request.kind.startsWith("blocked") &&
        ["fresh", "missing", "corrupt", "update", "offline"].includes(request.phase),
    ),
    "Distribution command attempted an unexpected outbound request.",
  );
} catch (error) {
  failure = clean(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
} finally {
  for (const child of children) await stop(child);
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    servers
      .filter((server) => server.listening)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  writeJson("requests.json", requests);
  writeJson("commands.json", commands);
  writeJson("result.json", {
    status: failure ? "failed" : "passed",
    platform: platformKey,
    baseline: BASELINE,
    candidate: CANDIDATE,
    phase,
    checks,
    releaseIndexPath: RELEASES_PATH,
    runtimeHomesUploaded: false,
    ssh: "separate helper required",
    ...(failure ? { failure } : {}),
  });
  // scratch is a captured mkdtemp child of RUNNER_TEMP, never an input or output path.
  NodeFS.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
if (failure) console.error(failure);
else
  console.log(`CLI distribution proof passed for ${platformKey}; sanitized evidence: ${outputDir}`);

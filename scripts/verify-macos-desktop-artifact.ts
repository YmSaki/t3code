// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

const { values } = NodeUtil.parseArgs({
  options: {
    executable: { type: "string" },
    version: { type: "string" },
    "expected-home": { type: "string" },
    "home-dir": { type: "string" },
    "output-dir": { type: "string" },
    fresh: { type: "boolean", default: false },
    official: { type: "boolean", default: false },
  },
});
const executable = values.executable;
const expectedHome = values["expected-home"];
const outputDir = values["output-dir"];
if (!executable || !values.version || !expectedHome || !outputDir) {
  throw new Error("Pass --executable, --version, --expected-home, and --output-dir.");
}
NodeAssert.equal(HostProcess.Platform.defaultValue(), "darwin", "Run on native macOS.");
NodeAssert.ok(process.env.HOME, "The runner must provide its real HOME for the login keychain.");
NodeFS.mkdirSync(outputDir, { recursive: true });

const STEP_TIMEOUT_MS = 60_000;
const FORK_BUNDLE_ID = "io.github.ymsaki.t3codejp";
const runtimeFile = NodePath.join(expectedHome, "userdata/server-runtime.json");
const databasePath = NodePath.join(expectedHome, "userdata/statev2.sqlite");
const runtimePublished = Promise.withResolvers<{ pid: number }>();
// The watcher can fail while Playwright is still launching; handle that rejection immediately.
void runtimePublished.promise.catch(() => {});
let runtimeWatcher: NodeFS.FSWatcher | undefined;
let app: ElectronApplication | undefined;
let child: NodeChildProcess.ChildProcess | undefined;
let page: Page | undefined;
let step = "watching backend runtime publication";
let stdout = Buffer.alloc(0);
let stderr = Buffer.alloc(0);
const LOG_LIMIT = 64 * 1024;
const appendLog = (previous: Buffer, chunk: Buffer) =>
  Buffer.concat([previous, chunk]).subarray(-LOG_LIMIT);
const diagnostics = (text: string) =>
  text
    .split("\n")
    .map((line) =>
      /token|secret|password|authorization|cookie|api.?key|pairing|credential|sk-[a-z0-9]/i.test(
        line,
      )
        ? "[credential-bearing line redacted]"
        : line.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[URL redacted]"),
    )
    .join("\n");

const writeFailure = (error: unknown) => {
  NodeFS.writeFileSync(
    NodePath.join(outputDir, "failure.txt"),
    diagnostics(
      `Desktop validation failed while ${step}.\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    ),
  );
  NodeFS.writeFileSync(
    NodePath.join(outputDir, "electron-main.stdout.log"),
    diagnostics(stdout.toString("utf8")),
  );
  NodeFS.writeFileSync(
    NodePath.join(outputDir, "electron-main.stderr.log"),
    diagnostics(stderr.toString("utf8")),
  );
  console.error(diagnostics(String(error)));
  process.exitCode = 1;
};

async function mainWindow(application: ElectronApplication) {
  const ready = Promise.withResolvers<Page>();
  const inspect = (candidate: Page) => {
    // A connecting splash may be the first window and close before the real app is ready.
    void candidate
      .locator("#root")
      .waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS })
      .then(() => ready.resolve(candidate))
      .catch(() => {});
  };
  application.on("window", inspect);
  try {
    for (const candidate of application.windows()) inspect(candidate);
    return await Promise.race([
      ready.promise,
      NodeTimersPromises.setTimeout(STEP_TIMEOUT_MS, undefined, { ref: false }).then(() => {
        throw new Error("No desktop app window became ready.");
      }),
    ]);
  } finally {
    application.off("window", inspect);
  }
}

try {
  const previousRuntime = NodeFS.existsSync(runtimeFile)
    ? (JSON.parse(NodeFS.readFileSync(runtimeFile, "utf8")) as { pid: number })
    : undefined;
  NodeFS.mkdirSync(NodePath.dirname(runtimeFile), { recursive: true });
  runtimeWatcher = NodeFS.watch(NodePath.dirname(runtimeFile), (_event, name) => {
    if (name !== null && name !== "server-runtime.json") return;
    try {
      if (!NodeFS.existsSync(runtimeFile)) return;
      const runtime = JSON.parse(NodeFS.readFileSync(runtimeFile, "utf8")) as { pid: number };
      NodeAssert.ok(Number.isInteger(runtime.pid) && runtime.pid > 0, "Invalid runtime PID.");
      if (runtime.pid !== previousRuntime?.pid) runtimePublished.resolve({ pid: runtime.pid });
    } catch (error) {
      runtimePublished.reject(error);
    }
  });
  runtimeWatcher.on("error", runtimePublished.reject);

  step = "launching the packaged app";
  app = await _electron.launch({
    executablePath: executable,
    // HOME stays real: a synthetic HOME has no macOS login keychain for safeStorage.
    env: {
      ...process.env,
      T3CODE_HOME: values["home-dir"] ?? "",
      T3CODE_TELEMETRY_ENABLED: "false",
      T3CODE_DISABLE_AUTO_UPDATE: "true",
    },
    timeout: STEP_TIMEOUT_MS,
  });
  child = app.process();
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = appendLog(stdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = appendLog(stderr, chunk);
  });

  step = "waiting for the desktop app window";
  page = await mainWindow(app);
  if (!values.fresh) {
    step = "opening the synthetic fixture thread";
    const thread = page.locator("li[data-thread-item]", { hasText: "Release launch check" });
    await thread.waitFor({ timeout: STEP_TIMEOUT_MS });
    await thread.click();
    await page.getByText("The release opens and shows this thread.").waitFor({
      timeout: STEP_TIMEOUT_MS,
    });
  }

  step = "checking the running app and its bundle identity";
  const metadata = await app.evaluate(({ app: electronApp }) => ({
    version: electronApp.getVersion(),
    name: electronApp.getName(),
    profile: electronApp.getPath("userData"),
    executable: electronApp.getPath("exe"),
    isPackaged: electronApp.isPackaged,
    electronPid: process.pid,
    arch: process.getBuiltinModule("process").arch,
  }));
  NodeAssert.equal(metadata.version, values.version);
  NodeAssert.equal(
    metadata.arch,
    HostProcess.Architecture.defaultValue(),
    "Launch the native artifact for this runner.",
  );
  NodeAssert.equal(metadata.isPackaged, true);
  NodeAssert.equal(metadata.electronPid, child.pid);
  NodeAssert.equal(NodeFS.realpathSync(metadata.executable), NodeFS.realpathSync(executable));
  NodeAssert.ok(metadata.name);
  NodeAssert.ok(NodePath.isAbsolute(metadata.profile));
  const contentsDir = NodePath.dirname(NodePath.dirname(metadata.executable));
  NodeAssert.equal(NodePath.basename(NodePath.dirname(metadata.executable)), "MacOS");
  NodeAssert.equal(NodePath.basename(contentsDir), "Contents");
  const infoPlist = NodePath.join(contentsDir, "Info.plist");
  const bundleId = NodeChildProcess.execFileSync(
    "/usr/bin/plutil",
    ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
  ).trim();
  NodeAssert.ok(bundleId, "The app bundle must declare CFBundleIdentifier.");
  if (values.official) NodeAssert.notEqual(bundleId, FORK_BUNDLE_ID);
  else NodeAssert.equal(bundleId, FORK_BUNDLE_ID);

  step = "waiting for the backend runtime in the expected home";
  const runtime = await Promise.race([
    runtimePublished.promise,
    NodeTimersPromises.setTimeout(STEP_TIMEOUT_MS, undefined, { ref: false }).then(() => {
      throw new Error(`Server did not publish runtime state in ${expectedHome}`);
    }),
  ]);
  process.kill(runtime.pid, 0);
  NodeAssert.ok(NodeFS.statSync(databasePath).isFile(), "The backend must create statev2.sqlite.");

  step = "capturing the desktop window";
  await page.screenshot({ path: NodePath.join(outputDir, "window.png"), timeout: 10_000 });
  const result = {
    ...metadata,
    bundleId,
    infoPlist,
    dataHome: expectedHome,
    runtimePid: runtime.pid,
    databasePath,
    databaseExists: true,
  };
  NodeFS.writeFileSync(NodePath.join(outputDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  writeFailure(error);
  const failurePage =
    page && !page.isClosed() ? page : app?.windows().find((item) => !item.isClosed());
  if (failurePage) {
    await failurePage
      .screenshot({ path: NodePath.join(outputDir, "failure.png"), timeout: 10_000 })
      .catch(() => {});
  }
} finally {
  runtimeWatcher?.close();
  if (app && child) {
    // Capture the child before closing: Playwright drops its process handle on app shutdown.
    const capturedChild = child;
    const exited = new Promise<void>((resolve) => {
      if (capturedChild.exitCode !== null || capturedChild.signalCode !== null) resolve();
      else capturedChild.once("exit", () => resolve());
    });
    void app.close().catch(() => {});
    await Promise.race([exited, NodeTimersPromises.setTimeout(10_000, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        exited,
        NodeTimersPromises.setTimeout(10_000, undefined, { ref: false }).then(() => {
          throw new Error("Captured Electron child did not exit after SIGKILL.");
        }),
      ]).catch((error) => {
        step = "stopping the captured Electron child";
        writeFailure(error);
      });
    }
  }
}

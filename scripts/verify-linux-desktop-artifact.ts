import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import { _electron, type ElectronApplication } from "playwright-core";

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
NodeAssert.equal(HostProcess.Platform.defaultValue(), "linux");
NodeFS.mkdirSync(outputDir, { recursive: true });
const runtimeFile = NodePath.join(expectedHome, "userdata/server-runtime.json");
const previousRuntime = NodeFS.existsSync(runtimeFile)
  ? (JSON.parse(NodeFS.readFileSync(runtimeFile, "utf8")) as { pid: number })
  : undefined;
NodeFS.mkdirSync(NodePath.dirname(runtimeFile), { recursive: true });
const runtimePublished = Promise.withResolvers<{ pid: number }>();
const runtimeWatcher = NodeFS.watch(NodePath.dirname(runtimeFile), (_event, name) => {
  if (name !== "server-runtime.json" || !NodeFS.existsSync(runtimeFile)) return;
  try {
    const runtime = JSON.parse(NodeFS.readFileSync(runtimeFile, "utf8")) as { pid: number };
    if (runtime.pid !== previousRuntime?.pid) runtimePublished.resolve(runtime);
  } catch (error) {
    runtimePublished.reject(error);
  }
});
let app: ElectronApplication | undefined;
try {
  app = await _electron.launch({
    executablePath: executable,
    args: ["--no-sandbox", "--disable-gpu", "--ozone-platform=x11", "--password-store=basic"],
    env: {
      ...process.env,
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      T3CODE_HOME: values["home-dir"] ?? "",
      T3CODE_TELEMETRY_ENABLED: "false",
      T3CODE_DISABLE_AUTO_UPDATE: "true",
      XDG_SESSION_TYPE: "x11",
      XDG_CURRENT_DESKTOP: "",
      WAYLAND_DISPLAY: "",
      APPIMAGE_EXTRACT_AND_RUN: "1",
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.locator("#root").waitFor({ state: "visible", timeout: 60_000 });
  if (!values.fresh) {
    const thread = page.locator("li[data-thread-item]", { hasText: "Release launch check" });
    await thread.waitFor({ timeout: 60_000 });
    await thread.click();
    await page.getByText("The release opens and shows this thread.").waitFor({ timeout: 60_000 });
  }
  const metadata = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("No desktop window");
    const packageJson = JSON.parse(
      process
        .getBuiltinModule("fs")
        .readFileSync(
          process.getBuiltinModule("path").join(electronApp.getAppPath(), "package.json"),
          "utf8",
        ),
    ) as { desktopName?: string };
    return {
      version: electronApp.getVersion(),
      name: electronApp.getName(),
      profile: electronApp.getPath("userData"),
      desktopName: packageJson.desktopName,
      windowId: window.getNativeWindowHandle().readUInt32LE(0),
      appImageDir: process.env.APPDIR,
    };
  });
  NodeAssert.equal(metadata.version, values.version);
  const windowClass = NodeChildProcess.execFileSync(
    "xprop",
    ["-id", String(metadata.windowId), "WM_CLASS"],
    { encoding: "utf8" },
  ).trim();
  if (!values.official) {
    NodeAssert.match(windowClass, /io\.github\.ymsaki\.t3codejp/);
    const home = process.env.HOME;
    NodeAssert.ok(home);
    const portalEntry = NodeFS.readFileSync(
      NodePath.join(home, ".local/share/applications/io.github.ymsaki.t3codejp.desktop"),
      "utf8",
    );
    NodeAssert.match(portalEntry, /^NoDisplay=true$/m);
    if (metadata.appImageDir) {
      NodeAssert.ok(NodeFS.existsSync(NodePath.join(metadata.appImageDir, "t3codejp.desktop")));
    }
  }
  const runtime = await Promise.race([
    runtimePublished.promise,
    NodeTimersPromises.setTimeout(60_000, undefined, { ref: false }).then(() => {
      throw new Error(`Server did not publish runtime state in ${expectedHome}`);
    }),
  ]);
  NodeAssert.notEqual(runtime.pid, previousRuntime?.pid);
  process.kill(runtime.pid, 0);
  NodeAssert.ok(NodeFS.existsSync(NodePath.join(expectedHome, "userdata/statev2.sqlite")));
  await page.screenshot({ path: NodePath.join(outputDir, "window.png") });
  const result = { ...metadata, windowClass, dataHome: expectedHome, runtimePid: runtime.pid };
  NodeFS.writeFileSync(NodePath.join(outputDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  NodeFS.writeFileSync(NodePath.join(outputDir, "failure.txt"), String(error));
  const page = app?.windows()[0];
  if (page)
    await page
      .screenshot({ path: NodePath.join(outputDir, "failure.png"), timeout: 10_000 })
      .catch(() => {});
  throw error;
} finally {
  runtimeWatcher.close();
  if (app) {
    const child = app.process();
    await Promise.race([
      app.close().catch(() => {}),
      NodeTimersPromises.setTimeout(10_000, undefined, { ref: false }),
    ]);
    child.kill("SIGKILL");
  }
}

/// <reference lib="dom" />
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

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
const FIXTURE_MESSAGE = "The release opens and shows this thread.";
const MESSAGE_SELECTOR =
  '[data-assistant-citation-viewport] .messages-timeline-scroll [data-timeline-row-kind="message"]';
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

function observePaintedContent(
  element: Element,
  { expected, viewportSelector }: { expected: string; viewportSelector: string },
) {
  let intersectionVisible = false;
  let armed = false;
  const ready = Promise.withResolvers<ReturnType<typeof snapshot>>();
  // Failure diagnostics may be requested before the host awaits readiness.
  void ready.promise.catch(() => {});
  let invalidated: ReturnType<typeof snapshot> | null = null;
  const box = (rect: DOMRect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  function snapshot() {
    const viewport = element.closest(viewportSelector);
    const viewportRect = viewport?.getBoundingClientRect();
    const clip = {
      left: Math.max(0, viewportRect?.left ?? 0),
      top: Math.max(0, viewportRect?.top ?? 0),
      right: Math.min(innerWidth, viewportRect?.right ?? 0),
      bottom: Math.min(innerHeight, viewportRect?.bottom ?? 0),
    };
    const ancestors = [];
    let opaque = true;
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const rect = ancestor.getBoundingClientRect();
      opaque &&=
        Number(style.opacity) >= 0.99 &&
        style.visibility === "visible" &&
        style.display !== "none" &&
        ancestor.getAttribute("aria-hidden") !== "true" &&
        !ancestor.hasAttribute("inert");
      if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
        clip.left = Math.max(clip.left, rect.left);
        clip.right = Math.min(clip.right, rect.right);
      }
      if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
        clip.top = Math.max(clip.top, rect.top);
        clip.bottom = Math.min(clip.bottom, rect.bottom);
      }
      if (ancestors.length < 24) {
        ancestors.push({
          tag: ancestor.tagName,
          class: ancestor.getAttribute("class")?.slice(0, 160),
          opacity: style.opacity,
          visibility: style.visibility,
          pointerEvents: style.pointerEvents,
          bounds: box(rect),
        });
      }
    }
    const range = document.createRange();
    range.selectNodeContents(element);
    const textRects = [...range.getClientRects()].filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    const inViewport =
      viewport !== null &&
      textRects.length > 0 &&
      textRects.every(
        (rect) =>
          rect.left >= clip.left - 0.5 &&
          rect.right <= clip.right + 0.5 &&
          rect.top >= clip.top - 0.5 &&
          rect.bottom <= clip.bottom + 0.5,
      );
    const unobscured = textRects.every((rect) => {
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit !== null && element.contains(hit);
    });
    const syncPhases = [...document.querySelectorAll("[data-composer-sync-status]")]
      .slice(0, 4)
      .map((status) => status.getAttribute("data-composer-sync-status"));
    return {
      documentId: performance.timeOrigin,
      visibilityState: document.visibilityState,
      connected: element.isConnected,
      text: element.textContent?.slice(0, 160),
      bounds: box(element.getBoundingClientRect()),
      viewport: viewport ? box(viewport.getBoundingClientRect()) : null,
      textBounds: textRects.slice(0, 8).map(box),
      opaque,
      inViewport,
      unobscured,
      intersectionVisible,
      syncPhases,
      ancestors,
      visible:
        element.isConnected &&
        element.textContent?.replace(/\s+/g, " ").trim() === expected &&
        document.visibilityState === "visible" &&
        opaque &&
        inViewport &&
        unobscured &&
        intersectionVisible &&
        syncPhases.length === 0,
    };
  }
  const check = () => {
    const state = snapshot();
    if (armed && !state.visible) invalidated ??= state;
    if (!armed && state.visible) {
      armed = true;
      ready.resolve(state);
    }
  };
  // Visibility tracking includes opacity and occlusion; ordinary Playwright visibility does not.
  const options = { threshold: 1, trackVisibility: true, delay: 100 };
  const intersection = new IntersectionObserver(([entry]) => {
    intersectionVisible =
      entry !== undefined &&
      entry.intersectionRatio >= 0.999 &&
      "isVisible" in entry &&
      entry.isVisible === true;
    check();
  }, options);
  const mutations = new MutationObserver(check);
  const resize = new ResizeObserver(check);
  const dispose = () => {
    intersection.disconnect();
    mutations.disconnect();
    resize.disconnect();
    document.removeEventListener("scroll", check, true);
    document.removeEventListener("visibilitychange", check);
  };
  intersection.observe(element);
  mutations.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    childList: true,
    characterData: true,
  });
  resize.observe(element);
  document.addEventListener("scroll", check, true);
  document.addEventListener("visibilitychange", check);
  AbortSignal.timeout(60_000).addEventListener(
    "abort",
    () => {
      dispose();
      ready.reject(new Error("Expected UI content never became visible in its viewport."));
    },
    { once: true },
  );
  return { ready: ready.promise, snapshot, invalidated: () => invalidated, dispose };
}

const capturePaintedContent = async (
  target: Page,
  content: Locator,
  expected: string,
  viewportSelector: string,
  failureLabel: string,
) => {
  await target.evaluate(async () => {
    await document.fonts.ready;
  });
  const observation = await content.evaluateHandle(observePaintedContent, {
    expected,
    viewportSelector,
  });
  try {
    const before = await observation.evaluate((monitor) => monitor.ready);
    NodeFS.writeFileSync(
      NodePath.join(outputDir, "ui-before.json"),
      JSON.stringify(before, null, 2),
    );
    await target.screenshot({ path: NodePath.join(outputDir, "window.png"), timeout: 10_000 });
    const after = await observation.evaluate((monitor) => ({
      current: monitor.snapshot(),
      invalidated: monitor.invalidated(),
    }));
    NodeFS.writeFileSync(NodePath.join(outputDir, "ui-after.json"), JSON.stringify(after, null, 2));
    NodeAssert.equal(
      after.current.documentId,
      before.documentId,
      "The document reloaded during capture.",
    );
    NodeAssert.equal(
      after.current.visible,
      true,
      "Expected UI content is not visible in the captured viewport.",
    );
    NodeAssert.equal(
      after.invalidated,
      null,
      "Expected UI content stopped being visible during capture.",
    );
  } catch (error) {
    const state = await observation.evaluate((monitor) => monitor.snapshot()).catch(() => null);
    NodeFS.writeFileSync(
      NodePath.join(outputDir, `${failureLabel}.json`),
      JSON.stringify(state, null, 2),
    );
    throw error;
  } finally {
    await observation.evaluate((monitor) => monitor.dispose()).catch(() => {});
    await observation.dispose();
  }
};

const recordUiEvidence = async (target: Page, label: string) => {
  const state = await target.evaluate(
    ({ selector, expected }) => ({
      documentId: performance.timeOrigin,
      visibilityState: document.visibilityState,
      headings: [...document.querySelectorAll('main h1, [role="main"] h1')]
        .slice(0, 4)
        .map((node) => ({
          text: node.textContent?.slice(0, 160),
          bounds: node.getBoundingClientRect().toJSON(),
        })),
      syncPhases: [...document.querySelectorAll("[data-composer-sync-status]")]
        .slice(0, 4)
        .map((node) => node.getAttribute("data-composer-sync-status")),
      candidates: [...document.querySelectorAll(selector)]
        .filter((node) => node.textContent?.includes(expected))
        .slice(0, 8)
        .map((node) => ({
          rowKind: node.getAttribute("data-timeline-row-kind"),
          bounds: node.getBoundingClientRect().toJSON(),
        })),
    }),
    { selector: MESSAGE_SELECTOR, expected: FIXTURE_MESSAGE },
  );
  const textMatches = await target
    .getByText(FIXTURE_MESSAGE, { exact: true })
    .evaluateAll((elements) =>
      elements.slice(0, 8).map((element) => {
        const ancestors = [];
        for (
          let node: Element | null = element;
          node && ancestors.length < 24;
          node = node.parentElement
        ) {
          const style = getComputedStyle(node);
          ancestors.push({
            tag: node.tagName,
            class: node.getAttribute("class")?.slice(0, 160),
            opacity: style.opacity,
            visibility: style.visibility,
            bounds: node.getBoundingClientRect().toJSON(),
          });
        }
        return { ancestors };
      }),
    );
  NodeFS.writeFileSync(
    NodePath.join(outputDir, `${label}.json`),
    JSON.stringify({ ...state, textMatches }, null, 2),
  );
};

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
  const window = await app.browserWindow(page);
  await window.evaluate((nativeWindow) => {
    if (nativeWindow.isMinimized()) nativeWindow.restore();
    nativeWindow.show();
    nativeWindow.focus();
  });
  await page.bringToFront();
  if (values.fresh) {
    step = "waiting for the fresh-install welcome page and agent setup control";
    const welcome = page.getByRole("main");
    const heading = welcome.getByRole("heading", {
      level: 1,
      name: /^(?:Welcome to T3 Code|T3 Code へようこそ)$/,
    });
    await heading.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
    await welcome
      .getByRole("button", {
        name: /^(?:Set up an agent|Add more agents|エージェントをセットアップ|エージェントを追加)$/,
      })
      .waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
    step = "verifying fresh-install welcome content is painted throughout capture";
    await capturePaintedContent(
      page,
      heading,
      await heading.innerText(),
      '[data-workspace-area="home"]',
      "ui-fresh-failure",
    );
  } else {
    step = "waiting for the synthetic fixture message";
    const message = page.locator(MESSAGE_SELECTOR).getByText(FIXTURE_MESSAGE, { exact: true });
    await message.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
    step = "dismissing the expected missing-Codex provider banner";
    const providerBanner = page
      .getByRole("alert")
      .filter({ hasText: "Could not start Codex CLI (`codex`)." });
    const dismissProviderBanner = providerBanner.getByRole("button", {
      name: /^(?:Codex プロバイダーのエラーを閉じる|Dismiss Codex provider error)$/,
    });
    await dismissProviderBanner.waitFor({ state: "visible", timeout: 10_000 });
    const bannerEvidence = {
      reason: "Codex CLI is intentionally absent on the native validation runner.",
      button: await dismissProviderBanner.getAttribute("aria-label"),
      bounds: await providerBanner.boundingBox(),
    };
    await dismissProviderBanner.click({ timeout: 10_000 });
    await providerBanner.waitFor({ state: "hidden", timeout: 10_000 });
    NodeFS.writeFileSync(
      NodePath.join(outputDir, "ui-provider-banner.json"),
      JSON.stringify({ ...bannerEvidence, dismissed: true }, null, 2),
    );
    step = "verifying fixture text is painted in the chat viewport throughout capture";
    await capturePaintedContent(
      page,
      message,
      FIXTURE_MESSAGE,
      ".messages-timeline-scroll",
      "ui-message-failure",
    );
  }
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
    await recordUiEvidence(failurePage, "ui-failure").catch(() => {});
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

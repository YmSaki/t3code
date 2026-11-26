// @effect-diagnostics nodeBuiltinImport:off -- Intercepts the spawn electron-updater requires natively.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { autoUpdater } from "electron-updater";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import { vi } from "vite-plus/test";

// electron-updater requires Electron natively, outside vi.mock's reach, and builds its
// autoUpdater singleton as soon as it is imported.
vi.hoisted(() => {
  const NodeModule = process.getBuiltinModule("node:module");
  const NodeEvents = process.getBuiltinModule("node:events");
  const require = NodeModule.createRequire(import.meta.url);
  const electronPath = NodeModule.createRequire(require.resolve("electron-updater")).resolve(
    "electron",
  );
  const electronModule = new NodeModule.Module(electronPath);
  electronModule.filename = electronPath;
  electronModule.loaded = true;
  electronModule.exports = {
    app: {
      getVersion: () => "1.0.0",
      getName: () => "T3 Code",
      isPackaged: true,
      quit: () => undefined,
      once: () => undefined,
      relaunch: (options: { execPath: string; args: ReadonlyArray<string> }) => {
        const child = process
          .getBuiltinModule("node:child_process")
          .spawn(options.execPath, options.args, {
            env: process.env,
            stdio: "ignore",
            windowsHide: true,
          });
        child.unref();
      },
    },
    autoUpdater: new NodeEvents.EventEmitter(),
  };
  require.cache[electronPath] = electronModule;
});

import * as ElectronUpdater from "./ElectronUpdater.ts";

const childProcess = NodeModule.createRequire(import.meta.url)("node:child_process") as {
  spawn: (
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ) => NodeChildProcess.ChildProcess;
};

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
  "ElectronUpdater NSIS install",
  () => {
    it.live("relaunches after installation with the original home environment", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const environment = yield* HostProcess.Environment;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-nsis-'install-" });
        const installer = path.join(root, "installer.exe");
        const app = path.join(root, "app.exe");
        const report = path.join(root, "home.txt");
        const source = `
using System;
using System.IO;
using System.Diagnostics;
public class UpdateFixture {
  public static void Main(string[] args) {
    if (Path.GetFileNameWithoutExtension(Process.GetCurrentProcess().MainModule.FileName) == "installer") {
      if (Array.IndexOf(args, "--force-run") >= 0 || Environment.CommandLine.Contains(${JSON.stringify(' "/S"')})) {
        var start = new ProcessStartInfo(${JSON.stringify(app)}) { UseShellExecute = false };
        start.EnvironmentVariables["T3CODE_HOME"] = "wrong-home";
        Process.Start(start).WaitForExit();
      }
    } else {
      File.WriteAllText(${JSON.stringify(`${report}.tmp`)}, Environment.GetEnvironmentVariable("T3CODE_HOME") ?? "missing-home");
      File.Move(${JSON.stringify(`${report}.tmp`)}, ${JSON.stringify(report)});
    }
  }
}`;
        yield* Effect.sync(() =>
          NodeChildProcess.execFileSync(
            `${environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Add-Type -TypeDefinition $env:T3_TEST_SOURCE -OutputAssembly $env:T3_TEST_EXECUTABLE -OutputType ConsoleApplication",
            ],
            {
              env: { ...environment, T3_TEST_SOURCE: source, T3_TEST_EXECUTABLE: installer },
              windowsHide: true,
            },
          ),
        );
        yield* fs.copyFile(installer, app);
        const relaunched = yield* Deferred.make<void>();
        yield* Effect.acquireRelease(
          Effect.sync(() => vi.stubEnv("T3CODE_HOME", "original custom home")),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeFS.watch(root, (_, name) => {
              if (name === "home.txt") Deferred.doneUnsafe(relaunched, Effect.void);
            }),
          ),
          (watcher) => Effect.sync(() => watcher.close()),
        );
        autoUpdater.logger = null;
        Object.assign(autoUpdater, {
          downloadedUpdateHelper: {
            file: installer,
            downloadedFileInfo: { isAdminRightsRequired: false },
          },
        });
        const updater = yield* ElectronUpdater.ElectronUpdater;
        yield* updater.quitAndInstall({ isSilent: true, isForceRunAfter: true }).pipe(
          Effect.provideService(HostProcess.ExecutablePath, app),
          Effect.provideService(HostProcess.Environment, {
            ...environment,
            T3CODE_HOME: "original custom home",
          }),
        );
        yield* Deferred.await(relaunched);
        assert.equal((yield* fs.readFileString(report)).trim(), "original custom home");
      }).pipe(Effect.provide([ElectronUpdater.layer, NodeServices.layer])),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "ElectronUpdater AppImage install",
  () => {
    it.live("relaunches the installed AppImage without the updating process's descriptors", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-appimage-install-" });
        const appImagePath = path.join(dir, "T3-Code.AppImage");
        const stagedPath = path.join(dir, "T3-Code-1.0.1.AppImage");
        const fdReportPath = path.join(dir, "relaunched-fds.txt");
        yield* fileSystem.writeFileString(appImagePath, "old AppImage");
        yield* fileSystem.writeFileString(
          stagedPath,
          `#!/bin/sh\nls /proc/self/fd > '${fdReportPath}'\n`,
        );
        yield* fileSystem.chmod(stagedPath, 0o755);

        yield* Effect.acquireRelease(
          Effect.sync(() => vi.stubEnv("APPIMAGE", appImagePath)),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );

        autoUpdater.logger = null;
        Object.assign(autoUpdater, {
          downloadedUpdateHelper: {
            file: stagedPath,
            downloadedFileInfo: { isAdminRightsRequired: false },
          },
        });

        // Electron's main process holds the AppImage runtime's keepalive pipe and some
        // Chromium files without O_CLOEXEC. Node cannot hold such a descriptor, so the
        // relaunch runs with fd 7 opened that way to stand in for them.
        const relaunched = yield* Deferred.make<void>();
        const realSpawn = childProcess.spawn;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            childProcess.spawn = (command, args, options) => {
              const child = realSpawn(
                "bash",
                ["-c", 'exec 7</dev/null; exec "$@"', "leaky-parent", command, ...args],
                options,
              );
              child.once("exit", () => Deferred.doneUnsafe(relaunched, Effect.void));
              return child;
            };
            NodeModule.syncBuiltinESMExports();
          }),
          () =>
            Effect.sync(() => {
              childProcess.spawn = realSpawn;
              NodeModule.syncBuiltinESMExports();
            }),
        );

        const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
        yield* electronUpdater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
        yield* Deferred.await(relaunched);

        const descriptors = (yield* fileSystem.readFileString(fdReportPath)).trim().split("\n");
        assert.notInclude(
          descriptors,
          "7",
          `relaunched AppImage inherited the updating process's fd 7 (open fds: ${descriptors.join(" ")})`,
        );
      }).pipe(Effect.provide([ElectronUpdater.layer, NodeServices.layer])),
    );
  },
);

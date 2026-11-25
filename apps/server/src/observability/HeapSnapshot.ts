// @effect-diagnostics nodeBuiltinImport:off - v8.writeHeapSnapshot has no Effect equivalent.
import * as NodePath from "node:path";
import * as NodeV8 from "node:v8";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const SNAPSHOT_SUFFIX = ".heapsnapshot";
const RETAINED_SNAPSHOTS = 2;

class HeapSnapshotWriteError extends Schema.TaggedError<HeapSnapshotWriteError>()(
  "HeapSnapshotWriteError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not write a heap snapshot to ${this.path}.`;
  }
}

export const writeHeapSnapshot = Effect.fn("server.heapSnapshot", { root: true })(
  function* (directory: string, write: (path: string) => unknown = NodeV8.writeHeapSnapshot) {
    const fs = yield* FileSystem.FileSystem;
    // Snapshots hold every secret in server memory; keep them owner-only.
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* fs.chmod(directory, 0o700);
    const timestamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
    const path = NodePath.join(directory, `server-${process.pid}-${timestamp}${SNAPSHOT_SUFFIX}`);
    yield* Effect.annotateCurrentSpan({ path });
    yield* Effect.try({
      try: () => write(path),
      catch: (cause) => new HeapSnapshotWriteError({ path, cause }),
    }).pipe(
      Effect.andThen(fs.chmod(path, 0o600)),
      Effect.tapError(() => fs.remove(path, { force: true }).pipe(Effect.ignore)),
    );
    yield* Effect.logInfo("Wrote heap snapshot.", { path });

    const snapshots = yield* Effect.forEach(
      (yield* fs.readDirectory(directory)).filter((name) => name.endsWith(SNAPSHOT_SUFFIX)),
      (name) =>
        fs.stat(NodePath.join(directory, name)).pipe(
          Effect.map((info) => ({
            name,
            mtime: Option.getOrUndefined(info.mtime)?.getTime() ?? 0,
          })),
        ),
    );
    snapshots.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
    yield* Effect.forEach(snapshots.slice(RETAINED_SNAPSHOTS), ({ name }) =>
      fs.remove(NodePath.join(directory, name), { force: true }),
    );
  },
  Effect.catch((cause) => Effect.logWarning("Failed to write heap snapshot.", { cause })),
);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const { heapSnapshotsDir } = yield* ServerConfig.ServerConfig;
    const runFork = Effect.runForkWith(yield* Effect.context<FileSystem.FileSystem>());
    const onSignal = () => void runFork(writeHeapSnapshot(heapSnapshotsDir));
    yield* Effect.acquireRelease(
      Effect.sync(() => process.on("SIGUSR2", onSignal)),
      () => Effect.sync(() => process.off("SIGUSR2", onSignal)),
    );
  }),
);

// @effect-diagnostics nodeBuiltinImport:off - stands in for the synchronous v8 snapshot writer.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { writeHeapSnapshot } from "./HeapSnapshot.ts";

describe("HeapSnapshot", () => {
  it.effect("writes owner-only snapshots and keeps the latest two", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-heap-snapshot-" });
      const directory = path.join(root, "diagnostics", "heap");
      const written: Array<string> = [];
      const write = (file: string) => {
        written.push(file);
        return NodeFS.writeFileSync(file, "{}");
      };

      for (let index = 0; index < 3; index++) {
        yield* writeHeapSnapshot(directory, write);
        yield* TestClock.adjust("1 second");
      }

      expect(written.every((file) => path.dirname(file) === directory)).toBe(true);
      expect((yield* fs.readDirectory(directory)).toSorted()).toEqual(
        written.slice(1).map((file) => path.basename(file)),
      );
      if (HostProcess.Platform.defaultValue() !== "win32") {
        expect((yield* fs.stat(directory)).mode & 0o777).toBe(0o700);
        expect((yield* fs.stat(written[2]!)).mode & 0o777).toBe(0o600);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

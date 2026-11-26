import { assert, describe, it } from "@effect/vitest";
import {
  RESOURCE_MONITOR_PROTOCOL_VERSION,
  type ResourceTelemetryProcess,
  type ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { emptyTelemetryCounters, mergeProcesses } from "./Model.ts";
import * as ProcessGroupMetrics from "./ProcessGroupMetrics.ts";
import * as ResourceTelemetry from "./ResourceTelemetry.ts";

const { groupProcesses } = ProcessGroupMetrics;

const process = (
  pid: number,
  ppid: number,
  name: string,
  category: ResourceTelemetryProcess["category"] = "server-child",
  command = name,
) =>
  ({
    identity: { pid, startTimeMs: 1 },
    ppid,
    name,
    command,
    category,
    residentBytes: pid * 1_000,
    cpuPercent: pid,
  }) as ResourceTelemetryProcess;

describe("groupProcesses", () => {
  it("sums each direct child of the server with its whole subtree", () => {
    const { processes: scriptProcesses } = mergeProcesses({
      serverPid: 10,
      sidecarPid: Option.none(),
      fallbackSampledAtMs: 1_000,
      nativeSnapshot: Option.some({
        version: RESOURCE_MONITOR_PROTOCOL_VERSION,
        type: "snapshot",
        sequence: 1,
        sampledAtUnixMs: 1_000,
        collectionDurationMicros: 250,
        scannedProcessCount: 2,
        retainedProcessCount: 2,
        inaccessibleProcessCount: 0,
        processes: (
          [
            [80, "claude"],
            [90, null],
          ] as const
        ).map(([pid, providerHint]) => ({
          pid,
          ppid: 10,
          startTimeMs: 1,
          runTimeMs: 999,
          executableName: "node.exe",
          electronType: null,
          providerHint,
          status: "Running",
          residentBytes: pid * 1_000,
          virtualBytes: 0,
          cpuPercent: pid,
          cpuTimeMs: 0,
          ioReadBytes: 0,
          ioWriteBytes: 0,
          ioSemantics: "storage",
        })),
      }),
      desktopSnapshot: Option.none(),
      previous: new Map(),
      counters: emptyTelemetryCounters(),
      updatePrevious: true,
    });
    assert.deepStrictEqual(
      scriptProcesses.map((process) => process.command),
      ["node.exe [claude]", "node.exe"],
    );
    const totals = groupProcesses([
      process(10, 1, "node", "server"),
      process(11, 10, "t3-resource-mon", "resource-monitor"),
      process(20, 10, "claude"),
      process(21, 20, "bash"),
      process(22, 21, "cargo"),
      process(30, 10, "codex"),
      process(40, 10, "zsh"),
      process(50, 10, "chrome-headless"),
      process(60, 10, "git", "server-child", "git checkout claude/fix"),
      process(70, 99, "orphan"),
      ...scriptProcesses,
      process(100, 10, "node", "server-child", "node [claude] report.js"),
    ]);

    assert.deepStrictEqual(Object.fromEntries(totals), {
      server: { residentBytes: 10_000, cpuPercent: 10, count: 1 },
      "resource-monitor": { residentBytes: 11_000, cpuPercent: 11, count: 1 },
      // The agent's shell and the build it ran belong to the agent, not the terminal group.
      claude: { residentBytes: 143_000, cpuPercent: 143, count: 4 },
      codex: { residentBytes: 30_000, cpuPercent: 30, count: 1 },
      terminal: { residentBytes: 40_000, cpuPercent: 40, count: 1 },
      browser: { residentBytes: 50_000, cpuPercent: 50, count: 1 },
      other: { residentBytes: 320_000, cpuPercent: 320, count: 4 },
    });
  });
});

describe("ProcessGroupMetrics.layer", () => {
  const notRunning = new ResourceTelemetry.ResourceTelemetryRefreshFailed({
    operation: "refresh",
    cause: new Error("Resource monitor is unavailable: sidecar is not running"),
  });
  const logsAfter = (
    refresh: ResourceTelemetry.ResourceTelemetry["Service"]["refresh"],
    afterStart: Effect.Effect<void>,
  ) => {
    const logs: Array<string> = [];
    const logger = Logger.make(({ logLevel, message }) => {
      logs.push(`${logLevel.toUpperCase()} ${String([message].flat()[0])}`);
    });
    const telemetry = { refresh } as unknown as ResourceTelemetry.ResourceTelemetry["Service"];
    return Effect.gen(function* () {
      yield* Layer.build(
        ProcessGroupMetrics.layer.pipe(
          Layer.provide(Layer.succeed(ResourceTelemetry.ResourceTelemetry, telemetry)),
          Layer.provide(
            ServerConfig.layer({
              otlpMetricsUrl: "http://localhost:4318/v1/metrics",
            } as ServerConfig.ServerConfig["Service"]),
          ),
        ),
      );
      yield* afterStart;
      return logs;
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          Logger.layer([logger], { mergeWithExisting: false }),
          Layer.succeed(References.MinimumLogLevel, "Debug"),
        ),
      ),
    );
  };
  const emptySnapshot = { processes: [] } as unknown as ResourceTelemetrySnapshot;

  it.effect("logs the first failed sample and the recovery, not every repeat", () =>
    Effect.gen(function* () {
      const outcomes = yield* Ref.make<ReadonlyArray<"fail" | "ok">>(["fail", "fail", "ok"]);
      const refresh = Ref.modify(outcomes, ([next = "ok", ...rest]) => [next, rest] as const).pipe(
        Effect.flatMap((next) =>
          next === "fail" ? Effect.fail(notRunning) : Effect.succeed(emptySnapshot),
        ),
      );
      const logs = yield* logsAfter(refresh, TestClock.adjust("3 minutes"));
      assert.deepStrictEqual(logs, [
        "WARN process group metrics are not exported: sample failed",
        "DEBUG process group metrics sample failed",
        "INFO process group metrics sample recovered",
      ]);
    }),
  );

  it.effect("does not report the sidecar as failed while it is still starting", () =>
    Effect.gen(function* () {
      // The sidecar answers once its handshake completes, a few seconds after the server starts.
      const refresh = Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          now >= 5_000 ? Effect.succeed(emptySnapshot) : Effect.fail(notRunning),
        ),
      );
      const logs = yield* logsAfter(refresh, TestClock.adjust("1 minute"));
      assert.deepStrictEqual(logs, []);
    }),
  );
});

import { expect, it } from "@effect/vitest";
import {
  AuthMcpClientAccess,
  EnvironmentId,
  PeerLinkError,
  type PeerLinkSummary,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as PeerHealthMonitor from "./PeerHealthMonitor.ts";

const makePeerSummary = (params: {
  readonly id: string;
  readonly label: string;
  readonly status?: "reachable" | "unreachable" | "expired";
  readonly lastError?: string | null;
}): PeerLinkSummary => {
  const epoch = DateTime.makeUnsafe("2026-11-22T00:00:00.000Z");
  return {
    environmentId: EnvironmentId.make(params.id),
    label: params.label,
    urls: ["https://worker.tailnet.ts.net"],
    access: AuthMcpClientAccess.make("full-access"),
    linkedAt: epoch,
    expiresAt: DateTime.add(epoch, { days: 30 }),
    lastReachedAt: epoch,
    lastError: params.lastError ?? null,
    status: params.status ?? "reachable",
  };
};

it.effect("probes all peers, scores node health, and recommends the best worker", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust(Duration.seconds(10));
    const peers: ReadonlyArray<PeerLinkSummary> = [
      makePeerSummary({ id: "env-fast", label: "Fast Worker" }),
      makePeerSummary({ id: "env-busy", label: "Busy Worker" }),
      makePeerSummary({ id: "env-down", label: "Offline Worker", status: "unreachable" }),
    ];

    const monitor = yield* PeerHealthMonitor.PeerHealthMonitor.pipe(
      Effect.provide(
        PeerHealthMonitor.layerWithOptions({
          listPeers: Effect.succeed(peers),
          probePeer: (peer) => {
            if (peer.environmentId === "env-fast") {
              return Effect.succeed({
                online: true,
                latencyMs: 25,
                cpuUsagePercent: 18,
                memoryUsagePercent: 32,
                activeWorkers: 1,
                maxWorkers: 8,
                availableProviders: [
                  ProviderDriverKind.make("codex"),
                  ProviderDriverKind.make("claudeAgent"),
                ],
              });
            }
            if (peer.environmentId === "env-busy") {
              return Effect.succeed({
                online: true,
                latencyMs: 420,
                cpuUsagePercent: 85,
                memoryUsagePercent: 88,
                activeWorkers: 4,
                maxWorkers: 4,
              });
            }
            return Effect.fail(
              new PeerLinkError({
                reason: "unreachable",
                message: "Connection refused",
              }),
            );
          },
        }),
      ),
    );

    const result = yield* monitor.probeAll;
    expect(result.recommendedEnvironmentId).toBe(EnvironmentId.make("env-fast"));
    expect(result.nodes.map((node) => node.environmentId)).toEqual([
      EnvironmentId.make("env-fast"),
      EnvironmentId.make("env-busy"),
      EnvironmentId.make("env-down"),
    ]);

    const fast = result.nodes[0];
    expect(fast?.grade).toBe("healthy");
    expect(fast?.availableProviders).toEqual(["codex", "claudeAgent"]);

    const busy = result.nodes[1];
    expect(busy?.grade).toBe("degraded");
    expect(busy?.reasons).toContain("high_latency");
    expect(busy?.reasons).toContain("worker_capacity_saturated");

    const down = result.nodes[2];
    expect(down?.grade).toBe("offline");
    expect(down?.online).toBe(false);
    expect(down?.lastError).toBe("Connection refused");
  }),
);

it.effect("probeOne updates a single peer and fails for an unknown environmentId", () =>
  Effect.gen(function* () {
    let latency = 40;
    const peer = makePeerSummary({ id: "env-worker-1", label: "Worker 1" });

    const monitor = yield* PeerHealthMonitor.PeerHealthMonitor.pipe(
      Effect.provide(
        PeerHealthMonitor.layerWithOptions({
          listPeers: Effect.succeed([peer]),
          probePeer: () =>
            Effect.succeed({
              online: true,
              latencyMs: latency,
              cpuUsagePercent: 20,
              memoryUsagePercent: 30,
              activeWorkers: 0,
              maxWorkers: 8,
            }),
        }),
      ),
    );

    const initial = yield* monitor.listSnapshots;
    expect(initial.nodes[0]?.latencyMs).toBe(40);

    latency = 600;
    const cached = yield* monitor.listSnapshots;
    expect(cached.nodes[0]?.latencyMs).toBe(40);

    yield* TestClock.adjust(Duration.seconds(5));
    const refreshed = yield* monitor.probeOne(EnvironmentId.make("env-worker-1"));
    expect(refreshed.latencyMs).toBe(600);
    expect(refreshed.grade).toBe("degraded");

    const unknownResult = yield* Effect.result(monitor.probeOne(EnvironmentId.make("env-missing")));
    expect(unknownResult._tag).toBe("Failure");
  }),
);

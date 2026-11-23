import {
  EnvironmentId,
  PeerLinkError,
  type PeerLinkSummary,
  type PeerNodeHealthListResult,
  type PeerNodeHealthSnapshot,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import {
  compareNodeHealthAssessments,
  DEFAULT_NODE_HEALTH_THRESHOLDS,
  evaluateNodeHealth,
  type NodeHealthMetricsInput,
  type NodeHealthThresholds,
  selectBestNodeForAllocation,
} from "@t3tools/shared/nodeHealth.core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as PeerLinks from "./PeerLinks.ts";

export interface PeerProbeMetrics {
  readonly online: boolean;
  readonly latencyMs: number | null;
  readonly cpuUsagePercent?: number | null | undefined;
  readonly memoryUsagePercent?: number | null | undefined;
  readonly activeWorkers?: number | undefined;
  readonly maxWorkers?: number | undefined;
  readonly lastHeartbeatAgeMs?: number | null | undefined;
  readonly availableProviders?: ReadonlyArray<ProviderDriverKind> | undefined;
  readonly lastError?: string | null | undefined;
}

export interface PeerHealthMonitorOptions {
  readonly listPeers?: Effect.Effect<ReadonlyArray<PeerLinkSummary>, PeerLinkError> | undefined;
  readonly probePeer?:
    | ((peer: PeerLinkSummary) => Effect.Effect<PeerProbeMetrics, PeerLinkError>)
    | undefined;
  readonly thresholds?: NodeHealthThresholds | undefined;
}

export class PeerHealthMonitor extends Context.Service<
  PeerHealthMonitor,
  {
    readonly probeOne: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<PeerNodeHealthSnapshot, PeerLinkError>;
    readonly probeAll: Effect.Effect<PeerNodeHealthListResult, PeerLinkError>;
    readonly listSnapshots: Effect.Effect<PeerNodeHealthListResult, PeerLinkError>;
  }
>()("t3/peer/PeerHealthMonitor") {}

const defaultProbeFromSummary = (peer: PeerLinkSummary, nowMs: number): PeerProbeMetrics => {
  const online = peer.status === "reachable";
  const lastReachedMs =
    peer.lastReachedAt === null ? null : DateTime.toEpochMillis(peer.lastReachedAt);
  const lastHeartbeatAgeMs = lastReachedMs === null ? null : Math.max(0, nowMs - lastReachedMs);
  return {
    online,
    latencyMs: online ? 0 : null,
    cpuUsagePercent: null,
    memoryUsagePercent: null,
    activeWorkers: 0,
    lastHeartbeatAgeMs,
    lastError: peer.lastError,
  };
};

const toMetricsInput = (
  environmentId: EnvironmentId,
  metrics: PeerProbeMetrics,
): NodeHealthMetricsInput => ({
  nodeId: environmentId,
  online: metrics.online,
  latencyMs: metrics.latencyMs,
  cpuUsagePercent: metrics.cpuUsagePercent ?? null,
  memoryUsagePercent: metrics.memoryUsagePercent ?? null,
  activeWorkers: metrics.activeWorkers ?? 0,
  ...(metrics.maxWorkers !== undefined ? { maxWorkers: metrics.maxWorkers } : {}),
  ...(metrics.lastHeartbeatAgeMs !== undefined
    ? { lastHeartbeatAgeMs: metrics.lastHeartbeatAgeMs }
    : {}),
});

const buildSnapshot = (
  peer: PeerLinkSummary,
  metrics: PeerProbeMetrics,
  checkedAt: string,
  thresholds: NodeHealthThresholds,
): PeerNodeHealthSnapshot => {
  const assessment = evaluateNodeHealth(toMetricsInput(peer.environmentId, metrics), thresholds);
  return {
    environmentId: peer.environmentId,
    label: peer.label,
    online: assessment.grade !== "offline" && metrics.online,
    grade: assessment.grade,
    recommendedScore: assessment.recommendedScore,
    reasons: [...assessment.reasons],
    latencyMs: assessment.latencyMs,
    ...(metrics.cpuUsagePercent !== undefined ? { cpuUsagePercent: metrics.cpuUsagePercent } : {}),
    ...(metrics.memoryUsagePercent !== undefined
      ? { memoryUsagePercent: metrics.memoryUsagePercent }
      : {}),
    activeWorkers: assessment.activeWorkers,
    maxWorkers: assessment.maxWorkers,
    ...(metrics.availableProviders !== undefined
      ? { availableProviders: [...metrics.availableProviders] }
      : {}),
    checkedAt,
    lastError: metrics.lastError ?? peer.lastError,
  };
};

const sortSnapshots = (
  snapshots: ReadonlyArray<PeerNodeHealthSnapshot>,
): ReadonlyArray<PeerNodeHealthSnapshot> =>
  [...snapshots].sort((left, right) =>
    compareNodeHealthAssessments(
      {
        nodeId: left.environmentId,
        grade: left.grade,
        recommendedScore: left.recommendedScore,
        reasons: left.reasons,
        activeWorkers: left.activeWorkers,
        maxWorkers: left.maxWorkers,
        latencyMs: left.latencyMs,
      },
      {
        nodeId: right.environmentId,
        grade: right.grade,
        recommendedScore: right.recommendedScore,
        reasons: right.reasons,
        activeWorkers: right.activeWorkers,
        maxWorkers: right.maxWorkers,
        latencyMs: right.latencyMs,
      },
    ),
  );

export const make = Effect.fn("PeerHealthMonitor.make")(function* (
  options: PeerHealthMonitorOptions = {},
) {
  const maybePeerLinks = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const thresholds = options.thresholds ?? DEFAULT_NODE_HEALTH_THRESHOLDS;
  const snapshots = new Map<EnvironmentId, PeerNodeHealthSnapshot>();

  const listPeers: Effect.Effect<
    ReadonlyArray<PeerLinkSummary>,
    PeerLinkError
  > = options.listPeers ??
  (Option.isSome(maybePeerLinks) ? maybePeerLinks.value.list : Effect.succeed([]));

  const runProbe = Effect.fn("PeerHealthMonitor.runProbe")(function* (peer: PeerLinkSummary) {
    const now = yield* DateTime.now;
    const checkedAt = DateTime.formatIso(now);
    const nowMs = DateTime.toEpochMillis(now);
    const metrics =
      options.probePeer !== undefined
        ? yield* options.probePeer(peer).pipe(
            Effect.catchTags({
              PeerLinkError: (error) =>
                Effect.succeed<PeerProbeMetrics>({
                  online: false,
                  latencyMs: null,
                  activeWorkers: 0,
                  lastError: error.message,
                }),
            }),
          )
        : defaultProbeFromSummary(peer, nowMs);
    const snapshot = buildSnapshot(peer, metrics, checkedAt, thresholds);
    snapshots.set(peer.environmentId, snapshot);
    return snapshot;
  });

  const summarize = (
    items: ReadonlyArray<PeerNodeHealthSnapshot>,
    checkedAt: string,
  ): PeerNodeHealthListResult => {
    const ordered = sortSnapshots(items);
    const best = selectBestNodeForAllocation(
      ordered.map((node) => ({
        nodeId: node.environmentId,
        online: node.online,
        latencyMs: node.latencyMs,
        cpuUsagePercent: node.cpuUsagePercent ?? null,
        memoryUsagePercent: node.memoryUsagePercent ?? null,
        activeWorkers: node.activeWorkers,
        maxWorkers: node.maxWorkers,
      })),
      thresholds,
    );
    return {
      nodes: [...ordered],
      recommendedEnvironmentId: best === null ? null : EnvironmentId.make(best.nodeId),
      checkedAt,
    };
  };

  const probeOne: PeerHealthMonitor["Service"]["probeOne"] = Effect.fn(
    "PeerHealthMonitor.probeOne",
  )(function* (environmentId) {
    const peers = yield* listPeers;
    const target = peers.find((peer) => peer.environmentId === environmentId);
    if (target === undefined) {
      return yield* new PeerLinkError({
        reason: "unknown_link",
        message: `Linked peer ${environmentId} was not found.`,
      });
    }
    return yield* runProbe(target);
  });

  const probeAll: PeerHealthMonitor["Service"]["probeAll"] = Effect.gen(function* () {
    const peers = yield* listPeers;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const probed = yield* Effect.forEach(peers, (peer) => runProbe(peer), {
      concurrency: "unbounded",
    });
    const currentIds = new Set(peers.map((peer) => peer.environmentId));
    for (const existingId of snapshots.keys()) {
      if (!currentIds.has(existingId)) {
        snapshots.delete(existingId);
      }
    }
    return summarize(probed, checkedAt);
  }).pipe(Effect.withSpan("PeerHealthMonitor.probeAll"));

  const listSnapshots: PeerHealthMonitor["Service"]["listSnapshots"] = Effect.gen(function* () {
    const peers = yield* listPeers;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const items = yield* Effect.forEach(
      peers,
      (peer) => {
        const cached = snapshots.get(peer.environmentId);
        return cached !== undefined ? Effect.succeed(cached) : runProbe(peer);
      },
      { concurrency: "unbounded" },
    );
    return summarize(items, checkedAt);
  }).pipe(Effect.withSpan("PeerHealthMonitor.listSnapshots"));

  return PeerHealthMonitor.of({
    probeOne,
    probeAll,
    listSnapshots,
  });
});

export const layer = Layer.effect(PeerHealthMonitor, make());

export const layerWithOptions = (options: PeerHealthMonitorOptions) =>
  Layer.effect(PeerHealthMonitor, make(options));

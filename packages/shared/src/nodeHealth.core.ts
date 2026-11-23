export type NodeHealthGrade = "healthy" | "degraded" | "offline";

export type NodeHealthDegradationReason =
  | "offline"
  | "stale_heartbeat"
  | "high_latency"
  | "high_cpu"
  | "high_memory"
  | "worker_capacity_saturated";

export interface NodeHealthMetricsInput {
  readonly nodeId: string;
  readonly online: boolean;
  readonly latencyMs: number | null;
  readonly cpuUsagePercent: number | null;
  readonly memoryUsagePercent: number | null;
  readonly activeWorkers: number;
  readonly maxWorkers?: number | undefined;
  readonly lastHeartbeatAgeMs?: number | null | undefined;
}

export interface NodeHealthThresholds {
  readonly degradedLatencyMs: number;
  readonly maxLatencyMs: number;
  readonly degradedCpuPercent: number;
  readonly degradedMemoryPercent: number;
  readonly defaultMaxWorkers: number;
  readonly maxHeartbeatAgeMs: number;
}

export const DEFAULT_NODE_HEALTH_THRESHOLDS: NodeHealthThresholds = {
  degradedLatencyMs: 300,
  maxLatencyMs: 1_500,
  degradedCpuPercent: 80,
  degradedMemoryPercent: 85,
  defaultMaxWorkers: 8,
  maxHeartbeatAgeMs: 60_000,
};

export interface NodeHealthAssessment {
  readonly nodeId: string;
  readonly grade: NodeHealthGrade;
  readonly recommendedScore: number;
  readonly reasons: ReadonlyArray<NodeHealthDegradationReason>;
  readonly activeWorkers: number;
  readonly maxWorkers: number;
  readonly latencyMs: number | null;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const normalizePercent = (value: number | null): number | null => {
  if (value === null || !Number.isFinite(value)) return null;
  return clamp(value, 0, 100);
};

const normalizeNonNegative = (value: number | null): number | null => {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, value);
};

export function evaluateNodeHealth(
  input: NodeHealthMetricsInput,
  thresholds: NodeHealthThresholds = DEFAULT_NODE_HEALTH_THRESHOLDS,
): NodeHealthAssessment {
  const maxWorkers = Math.max(1, Math.trunc(input.maxWorkers ?? thresholds.defaultMaxWorkers));
  const activeWorkers = Math.max(0, Math.trunc(input.activeWorkers));
  const latencyMs = normalizeNonNegative(input.latencyMs);
  const cpuPercent = normalizePercent(input.cpuUsagePercent);
  const memoryPercent = normalizePercent(input.memoryUsagePercent);
  const heartbeatAgeMs = normalizeNonNegative(input.lastHeartbeatAgeMs ?? null);

  if (!input.online) {
    return {
      nodeId: input.nodeId,
      grade: "offline",
      recommendedScore: 0,
      reasons: ["offline"],
      activeWorkers,
      maxWorkers,
      latencyMs,
    };
  }

  if (heartbeatAgeMs !== null && heartbeatAgeMs > thresholds.maxHeartbeatAgeMs) {
    return {
      nodeId: input.nodeId,
      grade: "offline",
      recommendedScore: 0,
      reasons: ["stale_heartbeat"],
      activeWorkers,
      maxWorkers,
      latencyMs,
    };
  }

  const reasons: NodeHealthDegradationReason[] = [];
  if (latencyMs !== null && latencyMs >= thresholds.degradedLatencyMs) {
    reasons.push("high_latency");
  }
  if (cpuPercent !== null && cpuPercent >= thresholds.degradedCpuPercent) {
    reasons.push("high_cpu");
  }
  if (memoryPercent !== null && memoryPercent >= thresholds.degradedMemoryPercent) {
    reasons.push("high_memory");
  }
  if (activeWorkers >= maxWorkers) {
    reasons.push("worker_capacity_saturated");
  }

  const grade: NodeHealthGrade = reasons.length > 0 ? "degraded" : "healthy";

  const cpuHeadroom = cpuPercent === null ? 70 : 100 - cpuPercent;
  const memoryHeadroom = memoryPercent === null ? 70 : 100 - memoryPercent;
  const latencyScore =
    latencyMs === null
      ? 75
      : 100 * (1 - clamp(latencyMs / Math.max(1, thresholds.maxLatencyMs), 0, 1));
  const workerHeadroom = 100 * (1 - clamp(activeWorkers / maxWorkers, 0, 1));

  let rawScore =
    cpuHeadroom * 0.35 + memoryHeadroom * 0.3 + latencyScore * 0.2 + workerHeadroom * 0.15;

  if (activeWorkers >= maxWorkers) {
    rawScore = Math.min(rawScore, 25);
  } else if (grade === "degraded") {
    rawScore = Math.min(rawScore, 65);
  }

  const recommendedScore = clamp(Math.round(rawScore), 1, 100);

  return {
    nodeId: input.nodeId,
    grade,
    recommendedScore,
    reasons,
    activeWorkers,
    maxWorkers,
    latencyMs,
  };
}

const GRADE_RANK: Readonly<Record<NodeHealthGrade, number>> = {
  healthy: 0,
  degraded: 1,
  offline: 2,
};

export function compareNodeHealthAssessments(
  left: NodeHealthAssessment,
  right: NodeHealthAssessment,
): number {
  const gradeDiff = GRADE_RANK[left.grade] - GRADE_RANK[right.grade];
  if (gradeDiff !== 0) return gradeDiff;

  const scoreDiff = right.recommendedScore - left.recommendedScore;
  if (scoreDiff !== 0) return scoreDiff;

  const workerDiff = left.activeWorkers - right.activeWorkers;
  if (workerDiff !== 0) return workerDiff;

  const leftLatency = left.latencyMs ?? Number.POSITIVE_INFINITY;
  const rightLatency = right.latencyMs ?? Number.POSITIVE_INFINITY;
  if (leftLatency !== rightLatency) return leftLatency - rightLatency;

  return left.nodeId.localeCompare(right.nodeId);
}

export function rankNodesByHealth(
  nodes: ReadonlyArray<NodeHealthMetricsInput>,
  thresholds: NodeHealthThresholds = DEFAULT_NODE_HEALTH_THRESHOLDS,
): ReadonlyArray<NodeHealthAssessment> {
  return nodes
    .map((node) => evaluateNodeHealth(node, thresholds))
    .sort(compareNodeHealthAssessments);
}

export function selectBestNodeForAllocation(
  nodes: ReadonlyArray<NodeHealthMetricsInput>,
  thresholds: NodeHealthThresholds = DEFAULT_NODE_HEALTH_THRESHOLDS,
): NodeHealthAssessment | null {
  const ranked = rankNodesByHealth(nodes, thresholds);
  const best = ranked[0];
  return best !== undefined && best.grade !== "offline" ? best : null;
}

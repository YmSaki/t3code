import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_NODE_HEALTH_THRESHOLDS,
  evaluateNodeHealth,
  rankNodesByHealth,
  selectBestNodeForAllocation,
} from "./nodeHealth.core.ts";

describe("nodeHealth.core", () => {
  it("evaluates an online node with low load as healthy with high score", () => {
    const assessment = evaluateNodeHealth({
      nodeId: "node-a",
      online: true,
      latencyMs: 25,
      cpuUsagePercent: 15,
      memoryUsagePercent: 30,
      activeWorkers: 1,
      maxWorkers: 8,
    });

    expect(assessment.grade).toBe("healthy");
    expect(assessment.reasons).toEqual([]);
    expect(assessment.recommendedScore).toBeGreaterThanOrEqual(80);
    expect(assessment.recommendedScore).toBeLessThanOrEqual(100);
  });

  it("marks offline or stale-heartbeat nodes as offline with zero score", () => {
    const offline = evaluateNodeHealth({
      nodeId: "node-off",
      online: false,
      latencyMs: 10,
      cpuUsagePercent: 10,
      memoryUsagePercent: 10,
      activeWorkers: 0,
    });
    expect(offline.grade).toBe("offline");
    expect(offline.recommendedScore).toBe(0);
    expect(offline.reasons).toEqual(["offline"]);

    const stale = evaluateNodeHealth({
      nodeId: "node-stale",
      online: true,
      latencyMs: 10,
      cpuUsagePercent: 10,
      memoryUsagePercent: 10,
      activeWorkers: 0,
      lastHeartbeatAgeMs: DEFAULT_NODE_HEALTH_THRESHOLDS.maxHeartbeatAgeMs + 1,
    });
    expect(stale.grade).toBe("offline");
    expect(stale.recommendedScore).toBe(0);
    expect(stale.reasons).toEqual(["stale_heartbeat"]);
  });

  it("detects degraded conditions for latency, CPU, memory, and saturated workers", () => {
    const degraded = evaluateNodeHealth({
      nodeId: "node-busy",
      online: true,
      latencyMs: 450,
      cpuUsagePercent: 88,
      memoryUsagePercent: 90,
      activeWorkers: 8,
      maxWorkers: 8,
    });

    expect(degraded.grade).toBe("degraded");
    expect(degraded.reasons).toEqual([
      "high_latency",
      "high_cpu",
      "high_memory",
      "worker_capacity_saturated",
    ]);
    expect(degraded.recommendedScore).toBeLessThanOrEqual(25);
    expect(degraded.recommendedScore).toBeGreaterThanOrEqual(1);
  });

  it("sorts nodes deterministically by health grade, score, workers, latency, and nodeId", () => {
    const nodes = [
      {
        nodeId: "node-offline",
        online: false,
        latencyMs: 5,
        cpuUsagePercent: 5,
        memoryUsagePercent: 5,
        activeWorkers: 0,
      },
      {
        nodeId: "node-degraded",
        online: true,
        latencyMs: 350,
        cpuUsagePercent: 85,
        memoryUsagePercent: 75,
        activeWorkers: 3,
      },
      {
        nodeId: "node-healthy-b",
        online: true,
        latencyMs: 20,
        cpuUsagePercent: 20,
        memoryUsagePercent: 25,
        activeWorkers: 1,
      },
      {
        nodeId: "node-healthy-a",
        online: true,
        latencyMs: 20,
        cpuUsagePercent: 20,
        memoryUsagePercent: 25,
        activeWorkers: 1,
      },
    ];

    const ranked = rankNodesByHealth(nodes);
    expect(ranked.map((item) => item.nodeId)).toEqual([
      "node-healthy-a",
      "node-healthy-b",
      "node-degraded",
      "node-offline",
    ]);

    const best = selectBestNodeForAllocation(nodes);
    expect(best?.nodeId).toBe("node-healthy-a");
    expect(selectBestNodeForAllocation([nodes[0]!])).toBeNull();
  });
});

import { describe, expect, it } from "vite-plus/test";

import type { WorklogCoreEntry } from "./worklogGrouping.core.ts";
import {
  calculateWorklogRangeStats,
  computeMaxConcurrency,
  computeMaxConcurrencyWithPeak,
} from "./worklogStats.core.ts";

function makeEntry(
  overrides: Partial<WorklogCoreEntry> & { readonly id: string },
): WorklogCoreEntry {
  return {
    source: "t3_run",
    environmentId: "env-1",
    projectId: "proj-1",
    projectTitle: "T3 Core",
    threadId: `thread-${overrides.id}`,
    runId: `run-${overrides.id}`,
    threadRole: "worker",
    provider: "codex",
    title: `Work ${overrides.id}`,
    status: "completed",
    startedAt: "2026-11-22T01:00:00.000Z",
    endedAt: "2026-11-22T02:00:00.000Z",
    turnCount: 2,
    stats: {
      changedFilesCount: 3,
      commandsCount: 5,
      inputTokens: 4000,
      outputTokens: 1000,
      cachedTokens: 2000,
      estimatedCostUsd: 0.2,
    },
    ...overrides,
  };
}

describe("worklogStats.core", () => {
  it("computes max concurrency using event sweep and treats touching endpoints as sequential", () => {
    // Sequential touching intervals: [10, 20] and [20, 30] -> maxConcurrency = 1
    expect(
      computeMaxConcurrency([
        { startMs: 10, endMs: 20 },
        { startMs: 20, endMs: 30 },
      ]),
    ).toBe(1);

    // 3 overlapping intervals peaking at t=150
    const peak = computeMaxConcurrencyWithPeak([
      { startMs: 100, endMs: 300 },
      { startMs: 120, endMs: 250 },
      { startMs: 150, endMs: 200 },
      { startMs: 260, endMs: 350 },
    ]);
    expect(peak.maxConcurrency).toBe(3);
    expect(peak.peakTimestampMs).toBe(150);
  });

  it("calculates range totals, daily breakdown, provider ratios/costs, top projects, and max concurrency", () => {
    const entries: ReadonlyArray<WorklogCoreEntry> = [
      makeEntry({
        id: "e1",
        provider: "codex",
        projectId: "proj-alpha",
        projectTitle: "Alpha",
        startedAt: "2026-11-22T01:00:00.000Z",
        endedAt: "2026-11-22T03:00:00.000Z", // 2h
        turnCount: 4,
        stats: {
          changedFilesCount: 5,
          commandsCount: 10,
          inputTokens: 10000,
          outputTokens: 2000,
          cachedTokens: 5000,
          estimatedCostUsd: 0.6,
        },
      }),
      makeEntry({
        id: "e2",
        provider: "claudeAgent",
        projectId: "proj-alpha",
        projectTitle: "Alpha",
        startedAt: "2026-11-22T02:00:00.000Z",
        endedAt: "2026-11-22T04:00:00.000Z", // 2h (overlaps e1 from 02:00 to 03:00)
        turnCount: 3,
        stats: {
          changedFilesCount: 2,
          commandsCount: 4,
          inputTokens: 8000,
          outputTokens: 1500,
          cachedTokens: 3000,
          estimatedCostUsd: 0.3,
        },
      }),
      makeEntry({
        id: "e3",
        provider: "codex",
        projectId: "proj-beta",
        projectTitle: "Beta",
        startedAt: "2026-11-22T02:30:00.000Z",
        endedAt: "2026-11-22T03:30:00.000Z", // 1h (overlaps both e1 and e2 from 02:30 to 03:00 -> concurrency 3!)
        turnCount: 1,
        stats: {
          changedFilesCount: 1,
          commandsCount: 2,
          inputTokens: 2000,
          outputTokens: 500,
          cachedTokens: 1000,
          estimatedCostUsd: 0.1,
        },
      }),
    ];

    const summary = calculateWorklogRangeStats(entries, {
      since: "2026-11-22T00:00:00.000Z",
      until: "2026-11-23T00:00:00.000Z",
      timeZone: "UTC",
      topProjectsLimit: 5,
    });

    // Total parallel duration: 2h + 2h + 1h = 5h
    expect(summary.totalDurationMs).toBe(5 * 3_600_000);
    // Total union duration: 01:00 to 04:00 = 3h
    expect(summary.totalUnionDurationMs).toBe(3 * 3_600_000);
    expect(summary.totalEntriesCount).toBe(3);
    expect(summary.totalTurnsCount).toBe(8);
    expect(summary.maxConcurrency).toBe(3);
    expect(summary.totals.estimatedCostUsd).toBe(1.0);
    expect(summary.totals.changedFilesCount).toBe(8);

    // Provider breakdown: codex = 3h (ratio 0.6, cost $0.7 -> 0.7), claudeAgent = 2h (ratio 0.4, cost $0.3 -> 0.3)
    expect(summary.byProvider).toHaveLength(2);
    expect(summary.byProvider[0]?.provider).toBe("codex");
    expect(summary.byProvider[0]?.totalDurationMs).toBe(3 * 3_600_000);
    expect(summary.byProvider[0]?.durationRatio).toBe(0.6);
    expect(summary.byProvider[0]?.costRatio).toBe(0.7);

    expect(summary.byProvider[1]?.provider).toBe("claudeAgent");
    expect(summary.byProvider[1]?.totalDurationMs).toBe(2 * 3_600_000);
    expect(summary.byProvider[1]?.durationRatio).toBe(0.4);
    expect(summary.byProvider[1]?.costRatio).toBe(0.3);

    // Top projects: Alpha = 4h (0.8), Beta = 1h (0.2)
    expect(summary.topProjects).toHaveLength(2);
    expect(summary.topProjects[0]?.projectId).toBe("proj-alpha");
    expect(summary.topProjects[0]?.totalDurationMs).toBe(4 * 3_600_000);
    expect(summary.topProjects[0]?.durationRatio).toBe(0.8);
    expect(summary.topProjects[1]?.projectId).toBe("proj-beta");
    expect(summary.topProjects[1]?.totalDurationMs).toBe(1 * 3_600_000);
    expect(summary.topProjects[1]?.durationRatio).toBe(0.2);

    // Daily stats
    expect(summary.daily).toHaveLength(1);
    expect(summary.daily[0]?.day).toBe("2026-11-22");
    expect(summary.daily[0]?.maxConcurrency).toBe(3);
  });
});

import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AgentWorklogEntry,
  IcalFeedConfig,
  MergedWorklogBlock,
  WorklogError,
  WorklogFilter,
  WorklogRangeStats,
  WorklogStatsSummary,
} from "./worklog.ts";

const decodeStatsSummary = Schema.decodeUnknownSync(WorklogStatsSummary);
const decodeEntry = Schema.decodeUnknownSync(AgentWorklogEntry);
const decodeBlock = Schema.decodeUnknownSync(MergedWorklogBlock);
const decodeFilter = Schema.decodeUnknownSync(WorklogFilter);
const decodeFeedConfig = Schema.decodeUnknownSync(IcalFeedConfig);
const decodeRangeStats = Schema.decodeUnknownSync(WorklogRangeStats);

describe("worklog contracts", () => {
  const sampleStats = {
    changedFilesCount: 5,
    commandsCount: 12,
    inputTokens: 15000,
    outputTokens: 3200,
    cachedTokens: 8000,
    estimatedCostUsd: 0.42,
  };

  it("decodes valid AgentWorklogEntry and rejects negative metrics", () => {
    const entry = decodeEntry({
      id: "wl-1",
      source: "t3_run",
      environmentId: "env-local",
      projectId: "proj-1",
      projectTitle: "T3 Code",
      threadId: "thread-1",
      runId: "run-1",
      threadRole: "pm",
      provider: "codex",
      providerInstanceId: "codex",
      model: "gpt-6-astra",
      title: "Implement worklog calendar",
      summary: "Created core contracts and pure functions",
      status: "completed",
      startedAt: "2026-11-22T01:00:00.000Z",
      endedAt: "2026-11-22T01:45:00.000Z",
      durationMs: 2_700_000,
      turnCount: 3,
      stats: sampleStats,
      threadUrl: "https://app.t3.codes/threads/thread-1",
    });

    expect(entry.id).toBe("wl-1");
    expect(entry.source).toBe("t3_run");
    expect(entry.threadRole).toBe("pm");
    expect(entry.stats.estimatedCostUsd).toBe(0.42);

    expect(() =>
      decodeStatsSummary({
        ...sampleStats,
        changedFilesCount: -1,
      }),
    ).toThrow();

    expect(() =>
      decodeStatsSummary({
        ...sampleStats,
        estimatedCostUsd: -0.01,
      }),
    ).toThrow();
  });

  it("decodes MergedWorklogBlock and requires at least one entryId", () => {
    const block = decodeBlock({
      id: "block-1",
      entryIds: ["wl-1", "wl-2"],
      source: "imported_cli",
      environmentId: "env-local",
      projectId: null,
      threadId: null,
      threadRole: "worker",
      provider: "claudeAgent",
      title: "Investigate test failure",
      status: "interrupted",
      startedAt: "2026-11-22T02:00:00.000Z",
      endedAt: "2026-11-22T02:30:00.000Z",
      durationMs: 1_800_000,
      activeDurationMs: 1_500_000,
      turnCount: 4,
      gapToleranceMinutes: 5,
      stats: sampleStats,
    });

    expect(block.entryIds).toEqual(["wl-1", "wl-2"]);
    expect(block.gapToleranceMinutes).toBe(5);

    expect(() =>
      decodeBlock({
        id: "block-empty",
        entryIds: [],
        source: "t3_run",
        environmentId: "env-local",
        projectId: null,
        threadId: null,
        threadRole: "standard",
        provider: "codex",
        title: "Empty block",
        status: "completed",
        startedAt: "2026-11-22T02:00:00.000Z",
        endedAt: "2026-11-22T02:30:00.000Z",
        durationMs: 1_800_000,
        turnCount: 1,
        gapToleranceMinutes: 0,
        stats: sampleStats,
      }),
    ).toThrow();
  });

  it("decodes IcalFeedConfig and WorklogFilter", () => {
    const filter = decodeFilter({
      since: "2026-11-01T00:00:00.000Z",
      until: "2026-11-30T23:59:59.000Z",
      providers: ["codex", "claudeAgent"],
      sources: ["t3_run"],
      threadRoles: ["pm", "worker"],
      statuses: ["completed"],
      minDurationMs: 60_000,
    });
    expect(filter.providers).toEqual(["codex", "claudeAgent"]);

    const feed = decodeFeedConfig({
      id: "feed-1",
      name: "My Agent Worklog",
      enabled: true,
      token: "secret-feed-token",
      timeZone: "Asia/Tokyo",
      gapToleranceMinutes: 15,
      filter,
      includeStatsInDescription: true,
      includeThreadUrl: true,
      createdAt: "2026-11-22T00:00:00.000Z",
      updatedAt: "2026-11-22T00:00:00.000Z",
    });

    expect(feed.id).toBe("feed-1");
    expect(feed.timeZone).toBe("Asia/Tokyo");
  });

  it("decodes WorklogRangeStats and WorklogError", () => {
    const rangeStats = decodeRangeStats({
      since: "2026-11-22T00:00:00.000Z",
      until: "2026-11-23T00:00:00.000Z",
      timeZone: "Asia/Tokyo",
      totalDurationMs: 119_160_000,
      totalUnionDurationMs: 54_000_000,
      totalEntriesCount: 8,
      totalTurnsCount: 24,
      maxConcurrency: 3,
      totals: sampleStats,
      daily: [
        {
          day: "2026-11-22",
          totalDurationMs: 119_160_000,
          unionDurationMs: 54_000_000,
          entriesCount: 8,
          turnsCount: 24,
          maxConcurrency: 3,
          estimatedCostUsd: 0.42,
        },
      ],
      byProvider: [
        {
          provider: "codex",
          totalDurationMs: 119_160_000,
          unionDurationMs: 54_000_000,
          durationRatio: 1,
          entriesCount: 8,
          turnsCount: 24,
          stats: sampleStats,
          costRatio: 1,
        },
      ],
      topProjects: [
        {
          projectId: "proj-1",
          projectTitle: "T3 Code",
          totalDurationMs: 119_160_000,
          unionDurationMs: 54_000_000,
          durationRatio: 1,
          entriesCount: 8,
          turnsCount: 24,
          stats: sampleStats,
        },
      ],
    });

    expect(rangeStats.maxConcurrency).toBe(3);
    expect(rangeStats.daily[0]?.day).toBe("2026-11-22");

    const error = new WorklogError({
      reason: "feedNotFound",
      message: "iCal feed was not found",
    });
    expect(error._tag).toBe("WorklogError");
    expect(error.reason).toBe("feedNotFound");
  });
});

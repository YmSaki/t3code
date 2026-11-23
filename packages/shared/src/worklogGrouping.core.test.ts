import { describe, expect, it } from "vite-plus/test";

import {
  deduplicateWorklogEntries,
  groupWorklogEntries,
  splitWorklogBlocksByDay,
  summarizeWorklogByDay,
  type WorklogCoreEntry,
  type WorklogCoreStats,
} from "./worklogGrouping.core.ts";

const baseStats: WorklogCoreStats = {
  changedFilesCount: 2,
  commandsCount: 4,
  inputTokens: 1000,
  outputTokens: 500,
  cachedTokens: 200,
  estimatedCostUsd: 0.05,
};

function makeEntry(overrides: Partial<WorklogCoreEntry> & { readonly id: string }): WorklogCoreEntry {
  return {
    source: "t3_run",
    environmentId: "env-1",
    projectId: "proj-1",
    projectTitle: "T3 Code",
    threadId: "thread-1",
    runId: `run-${overrides.id}`,
    threadRole: "worker",
    provider: "codex",
    title: `Task ${overrides.id}`,
    status: "completed",
    startedAt: "2026-11-22T01:00:00.000Z",
    endedAt: "2026-11-22T01:10:00.000Z",
    turnCount: 1,
    stats: baseStats,
    ...overrides,
  };
}

describe("worklogGrouping.core", () => {
  it("excludes imported CLI entries that overlap with T3 runs on the same provider/environment", () => {
    const t3Entry = makeEntry({
      id: "t3-1",
      source: "t3_run",
      provider: "codex",
      startedAt: "2026-11-22T10:00:00.000Z",
      endedAt: "2026-11-22T10:30:00.000Z",
    });
    const overlappingImported = makeEntry({
      id: "cli-overlap",
      source: "imported_cli",
      provider: "codex",
      threadId: null,
      runId: null,
      startedAt: "2026-11-22T10:05:00.000Z",
      endedAt: "2026-11-22T10:25:00.000Z",
    });
    const differentProviderImported = makeEntry({
      id: "cli-claude",
      source: "imported_cli",
      provider: "claudeAgent",
      threadId: null,
      runId: null,
      startedAt: "2026-11-22T10:05:00.000Z",
      endedAt: "2026-11-22T10:25:00.000Z",
    });
    const nonOverlappingImported = makeEntry({
      id: "cli-later",
      source: "imported_cli",
      provider: "codex",
      threadId: null,
      runId: null,
      startedAt: "2026-11-22T11:00:00.000Z",
      endedAt: "2026-11-22T11:20:00.000Z",
    });

    const result = deduplicateWorklogEntries([
      t3Entry,
      overlappingImported,
      differentProviderImported,
      nonOverlappingImported,
    ]);

    expect(result.entries.map((e) => e.id)).toEqual(["t3-1", "cli-claude", "cli-later"]);
    expect(result.excludedEntryIds).toEqual(["cli-overlap"]);
  });

  it("supports raw mode and gap-based thread merging (0m, 5m, 15m)", () => {
    const entries: ReadonlyArray<WorklogCoreEntry> = [
      makeEntry({
        id: "r1",
        threadId: "thread-a",
        startedAt: "2026-11-22T01:00:00.000Z",
        endedAt: "2026-11-22T01:10:00.000Z",
        turnCount: 2,
      }),
      makeEntry({
        id: "r2",
        threadId: "thread-a",
        startedAt: "2026-11-22T01:14:00.000Z",
        endedAt: "2026-11-22T01:20:00.000Z",
        turnCount: 3,
      }),
      makeEntry({
        id: "r3",
        threadId: "thread-a",
        startedAt: "2026-11-22T01:32:00.000Z",
        endedAt: "2026-11-22T01:40:00.000Z",
        turnCount: 1,
      }),
    ];

    const rawBlocks = groupWorklogEntries(entries, { mode: "raw" });
    expect(rawBlocks).toHaveLength(3);

    const zeroMinBlocks = groupWorklogEntries(entries, { mode: "merged", gapToleranceMinutes: 0 });
    expect(zeroMinBlocks).toHaveLength(3);

    const fiveMinBlocks = groupWorklogEntries(entries, { mode: "merged", gapToleranceMinutes: 5 });
    expect(fiveMinBlocks).toHaveLength(2);
    expect(fiveMinBlocks[0]?.entryIds).toEqual(["r1", "r2"]);
    expect(fiveMinBlocks[0]?.turnCount).toBe(5);
    expect(fiveMinBlocks[0]?.durationMs).toBe(20 * 60_000);
    expect(fiveMinBlocks[0]?.activeDurationMs).toBe(16 * 60_000);
    expect(fiveMinBlocks[0]?.stats.changedFilesCount).toBe(4);
    expect(fiveMinBlocks[1]?.entryIds).toEqual(["r3"]);

    const fifteenMinBlocks = groupWorklogEntries(entries, {
      mode: "merged",
      gapToleranceMinutes: 15,
    });
    expect(fifteenMinBlocks).toHaveLength(1);
    expect(fifteenMinBlocks[0]?.entryIds).toEqual(["r1", "r2", "r3"]);
    expect(fifteenMinBlocks[0]?.turnCount).toBe(6);
  });

  it("splits midnight-crossing blocks in an IANA timezone and computes parallel daily hours (e.g. 33.1h)", () => {
    // Asia/Tokyo is UTC+9.
    // 2026-11-22 22:00 JST = 2026-11-22T13:00:00.000Z
    // 2026-11-23 03:00 JST = 2026-11-22T18:00:00.000Z
    const crossMidnightEntry = makeEntry({
      id: "cross-1",
      threadId: "thread-cross",
      startedAt: "2026-11-22T13:00:00.000Z",
      endedAt: "2026-11-22T18:00:00.000Z",
    });

    const blocks = groupWorklogEntries([crossMidnightEntry], { mode: "raw" });
    const slices = splitWorklogBlocksByDay(blocks, "Asia/Tokyo");

    expect(slices).toHaveLength(2);
    expect(slices[0]?.dayKey).toBe("2026-11-22");
    expect(slices[0]?.startMinuteOfDay).toBe(22 * 60);
    expect(slices[0]?.endMinuteOfDay).toBe(24 * 60);
    expect(slices[0]?.durationMs).toBe(2 * 3_600_000);
    expect(slices[0]?.isClippedStart).toBe(false);
    expect(slices[0]?.isClippedEnd).toBe(true);

    expect(slices[1]?.dayKey).toBe("2026-11-23");
    expect(slices[1]?.startMinuteOfDay).toBe(0);
    expect(slices[1]?.endMinuteOfDay).toBe(3 * 60);
    expect(slices[1]?.durationMs).toBe(3 * 3_600_000);
    expect(slices[1]?.isClippedStart).toBe(true);
    expect(slices[1]?.isClippedEnd).toBe(false);

    // Parallel agents on 2026-11-23 JST totaling 33.1h:
    // crossMidnightEntry contributes 3.0h (00:00 - 03:00 JST)
    // agentB contributes 15.0h (00:00 - 15:00 JST = 2026-11-22T15:00:00Z to 2026-11-23T06:00:00Z)
    // agentC contributes 15.1h (15h 6m: 00:00 - 15:06 JST = 2026-11-22T15:00:00Z to 2026-11-23T06:06:00Z)
    const agentB = makeEntry({
      id: "agent-b",
      threadId: "thread-b",
      startedAt: "2026-11-22T15:00:00.000Z",
      endedAt: "2026-11-23T06:00:00.000Z",
    });
    const agentC = makeEntry({
      id: "agent-c",
      threadId: "thread-c",
      startedAt: "2026-11-22T15:00:00.000Z",
      endedAt: "2026-11-23T06:06:00.000Z",
    });

    const allBlocks = groupWorklogEntries([crossMidnightEntry, agentB, agentC], { mode: "raw" });
    const summaries = summarizeWorklogByDay(allBlocks, "+09:00");
    const day23 = summaries.find((d) => d.dayKey === "2026-11-23");

    expect(day23).toBeDefined();
    expect(day23?.parallelHours).toBe(33.1);
    expect(day23?.unionHours).toBe(15.1);
  });
});

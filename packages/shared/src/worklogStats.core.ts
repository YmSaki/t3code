import * as DateTime from "effect/DateTime";

import {
  calculateMergedIntervalDurationMs,
  deduplicateWorklogEntries,
  groupWorklogEntries,
  splitWorklogBlocksByDay,
  sumWorklogStats,
  type WorklogCoreEntry,
  type WorklogCoreStats,
} from "./worklogGrouping.core.ts";

export interface TimeIntervalMs {
  readonly startMs: number;
  readonly endMs: number;
}

export interface MaxConcurrencyResult {
  readonly maxConcurrency: number;
  readonly peakTimestampMs: number | null;
}

export interface WorklogDailyStatSummary {
  readonly day: string;
  readonly totalDurationMs: number;
  readonly unionDurationMs: number;
  readonly entriesCount: number;
  readonly turnsCount: number;
  readonly maxConcurrency: number;
  readonly estimatedCostUsd: number;
}

export interface WorklogProviderStatSummary {
  readonly provider: string;
  readonly totalDurationMs: number;
  readonly unionDurationMs: number;
  readonly durationRatio: number;
  readonly entriesCount: number;
  readonly turnsCount: number;
  readonly stats: WorklogCoreStats;
  readonly costRatio: number;
}

export interface WorklogProjectStatSummary {
  readonly projectId: string | null;
  readonly projectTitle: string;
  readonly totalDurationMs: number;
  readonly unionDurationMs: number;
  readonly durationRatio: number;
  readonly entriesCount: number;
  readonly turnsCount: number;
  readonly stats: WorklogCoreStats;
}

export interface WorklogRangeStatsOptions {
  readonly since?: string | number | undefined;
  readonly until?: string | number | undefined;
  readonly timeZone?: string | undefined;
  readonly topProjectsLimit?: number | undefined;
  readonly deduplicateImported?: boolean | undefined;
  readonly overlapToleranceMs?: number | undefined;
}

export interface WorklogRangeStatsSummary {
  readonly since: string;
  readonly until: string;
  readonly timeZone: string;
  readonly totalDurationMs: number;
  readonly totalUnionDurationMs: number;
  readonly totalEntriesCount: number;
  readonly totalTurnsCount: number;
  readonly maxConcurrency: number;
  readonly peakConcurrencyAtMs: number | null;
  readonly totals: WorklogCoreStats;
  readonly daily: ReadonlyArray<WorklogDailyStatSummary>;
  readonly byProvider: ReadonlyArray<WorklogProviderStatSummary>;
  readonly topProjects: ReadonlyArray<WorklogProjectStatSummary>;
}

export function computeMaxConcurrencyWithPeak(
  intervals: ReadonlyArray<TimeIntervalMs>,
): MaxConcurrencyResult {
  interface SweepEvent {
    readonly timeMs: number;
    readonly delta: 1 | -1;
  }

  const events: Array<SweepEvent> = [];
  for (const interval of intervals) {
    if (interval.endMs > interval.startMs) {
      events.push({ timeMs: interval.startMs, delta: 1 });
      events.push({ timeMs: interval.endMs, delta: -1 });
    }
  }

  if (events.length === 0) {
    return { maxConcurrency: 0, peakTimestampMs: null };
  }

  events.sort((a, b) => a.timeMs - b.timeMs || a.delta - b.delta);

  let current = 0;
  let maxConcurrency = 0;
  let peakTimestampMs: number | null = null;

  for (const event of events) {
    current += event.delta;
    if (current > maxConcurrency) {
      maxConcurrency = current;
      peakTimestampMs = event.timeMs;
    }
  }

  return { maxConcurrency, peakTimestampMs };
}

export function computeMaxConcurrency(intervals: ReadonlyArray<TimeIntervalMs>): number {
  return computeMaxConcurrencyWithPeak(intervals).maxConcurrency;
}

function parseOptionalBoundMs(bound: string | number | undefined): number | null {
  if (bound === undefined) return null;
  const ms = typeof bound === "number" ? bound : Date.parse(bound);
  return Number.isFinite(ms) ? ms : null;
}

function roundRatio(numerator: number, denominator: number): number {
  if (denominator <= 0 || numerator <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, numerator / denominator));
  return Math.round(ratio * 1_000_000) / 1_000_000;
}

export function calculateWorklogRangeStats(
  entries: ReadonlyArray<WorklogCoreEntry>,
  options?: WorklogRangeStatsOptions,
): WorklogRangeStatsSummary {
  const timeZone = options?.timeZone ?? "UTC";
  const topProjectsLimit = Math.max(1, options?.topProjectsLimit ?? 10);
  const shouldDeduplicate = options?.deduplicateImported ?? true;

  const sourceEntries = shouldDeduplicate
    ? deduplicateWorklogEntries(entries, { overlapToleranceMs: options?.overlapToleranceMs })
        .entries
    : entries;

  const sinceBoundMs = parseOptionalBoundMs(options?.since);
  const untilBoundMs = parseOptionalBoundMs(options?.until);

  interface ClampedEntry {
    readonly entry: WorklogCoreEntry;
    readonly startMs: number;
    readonly endMs: number;
    readonly durationMs: number;
  }

  const clampedEntries: Array<ClampedEntry> = [];
  let minObservedMs = Number.POSITIVE_INFINITY;
  let maxObservedMs = Number.NEGATIVE_INFINITY;

  for (const entry of sourceEntries) {
    const rawStart = Date.parse(entry.startedAt);
    const rawEnd = Date.parse(entry.endedAt);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;

    const entryStartMs = rawStart;
    const entryEndMs = Math.max(entryStartMs, rawEnd);

    if (sinceBoundMs !== null && entryEndMs <= sinceBoundMs && entryStartMs < sinceBoundMs) {
      continue;
    }
    if (untilBoundMs !== null && entryStartMs >= untilBoundMs && entryEndMs > untilBoundMs) {
      continue;
    }

    const clampedStartMs =
      sinceBoundMs !== null ? Math.max(sinceBoundMs, entryStartMs) : entryStartMs;
    const clampedEndMs = untilBoundMs !== null ? Math.min(untilBoundMs, entryEndMs) : entryEndMs;
    if (clampedEndMs < clampedStartMs) continue;

    const durationMs = Math.max(0, clampedEndMs - clampedStartMs);
    if (clampedStartMs < minObservedMs) minObservedMs = clampedStartMs;
    if (clampedEndMs > maxObservedMs) maxObservedMs = clampedEndMs;

    clampedEntries.push({
      entry: {
        ...entry,
        startedAt: DateTime.formatIso(DateTime.makeUnsafe(clampedStartMs)),
        endedAt: DateTime.formatIso(DateTime.makeUnsafe(clampedEndMs)),
        durationMs,
      },
      startMs: clampedStartMs,
      endMs: clampedEndMs,
      durationMs,
    });
  }

  const resolvedSinceIso =
    sinceBoundMs !== null
      ? DateTime.formatIso(DateTime.makeUnsafe(sinceBoundMs))
      : Number.isFinite(minObservedMs)
        ? DateTime.formatIso(DateTime.makeUnsafe(minObservedMs))
        : "1970-01-01T00:00:00.000Z";

  const resolvedUntilIso =
    untilBoundMs !== null
      ? DateTime.formatIso(DateTime.makeUnsafe(untilBoundMs))
      : Number.isFinite(maxObservedMs)
        ? DateTime.formatIso(DateTime.makeUnsafe(maxObservedMs))
        : resolvedSinceIso;

  let totalDurationMs = 0;
  let totalTurnsCount = 0;
  const allIntervals: Array<TimeIntervalMs> = [];
  const allStats: Array<WorklogCoreStats> = [];

  for (const item of clampedEntries) {
    totalDurationMs += item.durationMs;
    totalTurnsCount += item.entry.turnCount;
    allIntervals.push({ startMs: item.startMs, endMs: item.endMs });
    allStats.push(item.entry.stats);
  }

  const totalUnionDurationMs = calculateMergedIntervalDurationMs(allIntervals);
  const totals = sumWorklogStats(allStats);
  const { maxConcurrency, peakTimestampMs } = computeMaxConcurrencyWithPeak(allIntervals);

  const rawBlocks = groupWorklogEntries(
    clampedEntries.map((c) => c.entry),
    { mode: "raw", deduplicateImported: false },
  );
  const daySlices = splitWorklogBlocksByDay(rawBlocks, timeZone);
  const slicesByDay = new Map<string, Array<(typeof daySlices)[number]>>();

  for (const slice of daySlices) {
    const bucket = slicesByDay.get(slice.dayKey);
    if (bucket) {
      bucket.push(slice);
    } else {
      slicesByDay.set(slice.dayKey, [slice]);
    }
  }

  const daily: Array<WorklogDailyStatSummary> = [];
  const sortedDayKeys = [...slicesByDay.keys()].sort();

  for (const day of sortedDayKeys) {
    const slices = slicesByDay.get(day)!;
    let dayTotalDurationMs = 0;
    let dayTurnsCount = 0;
    let dayCostUsd = 0;
    const dayIntervals: Array<TimeIntervalMs> = [];

    for (const s of slices) {
      dayTotalDurationMs += s.durationMs;
      dayTurnsCount += s.turnCount;
      dayCostUsd += s.stats.estimatedCostUsd;
      dayIntervals.push({ startMs: s.sliceStartMs, endMs: s.sliceEndMs });
    }

    daily.push({
      day,
      totalDurationMs: dayTotalDurationMs,
      unionDurationMs: calculateMergedIntervalDurationMs(dayIntervals),
      entriesCount: slices.length,
      turnsCount: dayTurnsCount,
      maxConcurrency: computeMaxConcurrency(dayIntervals),
      estimatedCostUsd: Math.round(dayCostUsd * 1_000_000) / 1_000_000,
    });
  }

  const byProviderMap = new Map<string, Array<ClampedEntry>>();
  for (const item of clampedEntries) {
    const list = byProviderMap.get(item.entry.provider);
    if (list) {
      list.push(item);
    } else {
      byProviderMap.set(item.entry.provider, [item]);
    }
  }

  const byProvider: Array<WorklogProviderStatSummary> = [];
  for (const [provider, items] of byProviderMap.entries()) {
    let providerDurationMs = 0;
    let providerTurns = 0;
    const providerIntervals: Array<TimeIntervalMs> = [];
    const providerStatsList: Array<WorklogCoreStats> = [];

    for (const item of items) {
      providerDurationMs += item.durationMs;
      providerTurns += item.entry.turnCount;
      providerIntervals.push({ startMs: item.startMs, endMs: item.endMs });
      providerStatsList.push(item.entry.stats);
    }

    const providerStats = sumWorklogStats(providerStatsList);
    byProvider.push({
      provider,
      totalDurationMs: providerDurationMs,
      unionDurationMs: calculateMergedIntervalDurationMs(providerIntervals),
      durationRatio: roundRatio(providerDurationMs, totalDurationMs),
      entriesCount: items.length,
      turnsCount: providerTurns,
      stats: providerStats,
      costRatio: roundRatio(providerStats.estimatedCostUsd, totals.estimatedCostUsd),
    });
  }

  byProvider.sort(
    (a, b) => b.totalDurationMs - a.totalDurationMs || a.provider.localeCompare(b.provider),
  );

  const byProjectMap = new Map<
    string,
    {
      readonly projectId: string | null;
      readonly projectTitle: string;
      readonly items: Array<ClampedEntry>;
    }
  >();

  for (const item of clampedEntries) {
    const projectId = item.entry.projectId;
    const projectTitle =
      item.entry.projectTitle !== undefined && item.entry.projectTitle.trim().length > 0
        ? item.entry.projectTitle.trim()
        : (projectId ?? "Unassigned");
    const key = projectId !== null ? `id:${projectId}` : `title:${projectTitle}`;
    const existing = byProjectMap.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      byProjectMap.set(key, { projectId, projectTitle, items: [item] });
    }
  }

  const allProjects: Array<WorklogProjectStatSummary> = [];
  for (const group of byProjectMap.values()) {
    let projectDurationMs = 0;
    let projectTurns = 0;
    const projectIntervals: Array<TimeIntervalMs> = [];
    const projectStatsList: Array<WorklogCoreStats> = [];

    for (const item of group.items) {
      projectDurationMs += item.durationMs;
      projectTurns += item.entry.turnCount;
      projectIntervals.push({ startMs: item.startMs, endMs: item.endMs });
      projectStatsList.push(item.entry.stats);
    }

    allProjects.push({
      projectId: group.projectId,
      projectTitle: group.projectTitle,
      totalDurationMs: projectDurationMs,
      unionDurationMs: calculateMergedIntervalDurationMs(projectIntervals),
      durationRatio: roundRatio(projectDurationMs, totalDurationMs),
      entriesCount: group.items.length,
      turnsCount: projectTurns,
      stats: sumWorklogStats(projectStatsList),
    });
  }

  allProjects.sort(
    (a, b) => b.totalDurationMs - a.totalDurationMs || a.projectTitle.localeCompare(b.projectTitle),
  );

  return {
    since: resolvedSinceIso,
    until: resolvedUntilIso,
    timeZone,
    totalDurationMs,
    totalUnionDurationMs,
    totalEntriesCount: clampedEntries.length,
    totalTurnsCount,
    maxConcurrency,
    peakConcurrencyAtMs: peakTimestampMs,
    totals,
    daily,
    byProvider,
    topProjects: allProjects.slice(0, topProjectsLimit),
  };
}

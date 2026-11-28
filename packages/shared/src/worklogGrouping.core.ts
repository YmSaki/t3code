import * as DateTime from "effect/DateTime";

import { getLocalDateTimeParts, parseFixedOffsetMs } from "./localDateTime.ts";

export { getLocalDateTimeParts, type LocalDateTimeParts } from "./localDateTime.ts";

export type WorklogCoreSource = "t3_run" | "imported_cli";
export type WorklogCoreThreadRole = "pm" | "worker" | "standard";
export type WorklogCoreEntryStatus =
  | "running"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled";

export interface WorklogCoreStats {
  readonly changedFilesCount: number;
  readonly commandsCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly estimatedCostUsd: number;
}

export interface WorklogCoreEntry {
  readonly id: string;
  readonly source: WorklogCoreSource;
  readonly environmentId: string;
  readonly projectId: string | null;
  readonly projectTitle?: string | undefined;
  readonly threadId: string | null;
  readonly runId?: string | null | undefined;
  readonly threadRole: WorklogCoreThreadRole;
  readonly provider: string;
  readonly providerInstanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly status: WorklogCoreEntryStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs?: number | undefined;
  readonly turnCount: number;
  readonly stats: WorklogCoreStats;
  readonly threadUrl?: string | undefined;
}

export interface MergedWorklogCoreBlock {
  readonly id: string;
  readonly entryIds: ReadonlyArray<string>;
  readonly source: WorklogCoreSource;
  readonly environmentId: string;
  readonly projectId: string | null;
  readonly projectTitle?: string | undefined;
  readonly threadId: string | null;
  readonly threadRole: WorklogCoreThreadRole;
  readonly provider: string;
  readonly providerInstanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly status: WorklogCoreEntryStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly durationMs: number;
  readonly activeDurationMs: number;
  readonly turnCount: number;
  readonly gapToleranceMinutes: number;
  readonly stats: WorklogCoreStats;
  readonly threadUrl?: string | undefined;
}

export interface DeduplicateWorklogOptions {
  readonly overlapToleranceMs?: number | undefined;
}

export interface DeduplicateWorklogResult {
  readonly entries: ReadonlyArray<WorklogCoreEntry>;
  readonly excludedEntryIds: ReadonlyArray<string>;
}

export interface GroupWorklogEntriesOptions {
  readonly mode?: "raw" | "merged" | undefined;
  readonly gapToleranceMinutes?: number | null | undefined;
  readonly deduplicateImported?: boolean | undefined;
  readonly overlapToleranceMs?: number | undefined;
}

export interface WorklogDaySlice {
  readonly sliceId: string;
  readonly blockId: string;
  readonly entryIds: ReadonlyArray<string>;
  readonly dayKey: string;
  readonly dayStartMs: number;
  readonly dayEndMs: number;
  readonly sliceStartMs: number;
  readonly sliceEndMs: number;
  readonly durationMs: number;
  readonly startMinuteOfDay: number;
  readonly endMinuteOfDay: number;
  readonly isClippedStart: boolean;
  readonly isClippedEnd: boolean;
  readonly source: WorklogCoreSource;
  readonly environmentId: string;
  readonly projectId: string | null;
  readonly projectTitle?: string | undefined;
  readonly threadId: string | null;
  readonly threadRole: WorklogCoreThreadRole;
  readonly provider: string;
  readonly model?: string | undefined;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly status: WorklogCoreEntryStatus;
  readonly turnCount: number;
  readonly stats: WorklogCoreStats;
  readonly threadUrl?: string | undefined;
}

export interface DailyWorklogDurationSummary {
  readonly dayKey: string;
  readonly parallelDurationMs: number;
  readonly parallelHours: number;
  readonly unionDurationMs: number;
  readonly unionHours: number;
  readonly sliceCount: number;
  readonly slices: ReadonlyArray<WorklogDaySlice>;
}

function getInstantOffsetMs(utcMs: number, timeZone: string): number {
  const fixedOffsetMs = parseFixedOffsetMs(timeZone);
  if (fixedOffsetMs !== null) return fixedOffsetMs;
  const parts = getLocalDateTimeParts(utcMs, timeZone);
  const msRemainder = ((utcMs % 1000) + 1000) % 1000;
  const baseUtcMs = utcMs - msRemainder;
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0,
  );
  return localAsUtc - baseUtcMs;
}

function getLocalMidnightUtcMs(year: number, month: number, day: number, timeZone: string): number {
  const targetLocalAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const fixedOffsetMs = parseFixedOffsetMs(timeZone);
  if (fixedOffsetMs !== null) {
    return targetLocalAsUtc - fixedOffsetMs;
  }
  const firstGuess = targetLocalAsUtc - getInstantOffsetMs(targetLocalAsUtc, timeZone);
  return targetLocalAsUtc - getInstantOffsetMs(firstGuess, timeZone);
}

export function getDayBoundsForTimestamp(
  utcMs: number,
  timeZone: string,
): {
  readonly dayKey: string;
  readonly dayStartMs: number;
  readonly dayEndMs: number;
} {
  const parts = getLocalDateTimeParts(utcMs, timeZone);
  const dayStartMs = getLocalMidnightUtcMs(parts.year, parts.month, parts.day, timeZone);
  const nextDate = DateTime.toPartsUtc(
    DateTime.makeUnsafe(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 0, 0, 0, 0)),
  );
  const dayEndMs = getLocalMidnightUtcMs(nextDate.year, nextDate.month, nextDate.day, timeZone);
  return {
    dayKey: parts.dayKey,
    dayStartMs,
    dayEndMs,
  };
}

function parseTimestampBounds(entry: { readonly startedAt: string; readonly endedAt: string }): {
  readonly startMs: number;
  readonly endMs: number;
} {
  const rawStart = Date.parse(entry.startedAt);
  const rawEnd = Date.parse(entry.endedAt);
  const startMs = Number.isFinite(rawStart) ? rawStart : 0;
  const endMs = Number.isFinite(rawEnd) ? Math.max(startMs, rawEnd) : startMs;
  return { startMs, endMs };
}

export function sumWorklogStats(statsList: ReadonlyArray<WorklogCoreStats>): WorklogCoreStats {
  let changedFilesCount = 0;
  let commandsCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let estimatedCostUsd = 0;

  for (const s of statsList) {
    changedFilesCount += s.changedFilesCount;
    commandsCount += s.commandsCount;
    inputTokens += s.inputTokens;
    outputTokens += s.outputTokens;
    cachedTokens += s.cachedTokens;
    estimatedCostUsd += s.estimatedCostUsd;
  }

  return {
    changedFilesCount,
    commandsCount,
    inputTokens,
    outputTokens,
    cachedTokens,
    estimatedCostUsd: Math.round(estimatedCostUsd * 1_000_000) / 1_000_000,
  };
}

export function calculateMergedIntervalDurationMs(
  intervals: ReadonlyArray<{ readonly startMs: number; readonly endMs: number }>,
): number {
  const valid = intervals
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  if (valid.length === 0) return 0;

  let totalMs = 0;
  let currentStart = valid[0]!.startMs;
  let currentEnd = valid[0]!.endMs;

  for (let i = 1; i < valid.length; i++) {
    const item = valid[i]!;
    if (item.startMs <= currentEnd) {
      if (item.endMs > currentEnd) {
        currentEnd = item.endMs;
      }
    } else {
      totalMs += currentEnd - currentStart;
      currentStart = item.startMs;
      currentEnd = item.endMs;
    }
  }
  totalMs += currentEnd - currentStart;
  return totalMs;
}

export function deduplicateWorklogEntries(
  entries: ReadonlyArray<WorklogCoreEntry>,
  options?: DeduplicateWorklogOptions,
): DeduplicateWorklogResult {
  const toleranceMs = Math.max(0, options?.overlapToleranceMs ?? 0);
  const t3Runs: Array<{
    readonly entry: WorklogCoreEntry;
    readonly startMs: number;
    readonly endMs: number;
  }> = [];

  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (entry.source === "t3_run" && !seenIds.has(entry.id)) {
      const { startMs, endMs } = parseTimestampBounds(entry);
      t3Runs.push({ entry, startMs, endMs });
    }
  }

  const kept: Array<WorklogCoreEntry> = [];
  const excludedEntryIds: Array<string> = [];

  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      excludedEntryIds.push(entry.id);
      continue;
    }

    if (entry.source === "t3_run") {
      seenIds.add(entry.id);
      kept.push(entry);
      continue;
    }

    const { startMs, endMs } = parseTimestampBounds(entry);
    const isOverlappingWithT3Run = t3Runs.some((t3) => {
      if (
        entry.runId !== undefined &&
        entry.runId !== null &&
        t3.entry.runId !== undefined &&
        t3.entry.runId !== null &&
        entry.runId === t3.entry.runId
      ) {
        return true;
      }

      if (entry.provider !== t3.entry.provider) return false;
      if (
        entry.environmentId.length > 0 &&
        t3.entry.environmentId.length > 0 &&
        entry.environmentId !== t3.entry.environmentId
      ) {
        return false;
      }
      if (
        entry.projectId !== null &&
        t3.entry.projectId !== null &&
        entry.projectId !== t3.entry.projectId
      ) {
        return false;
      }
      if (
        entry.threadId !== null &&
        t3.entry.threadId !== null &&
        entry.threadId !== t3.entry.threadId
      ) {
        return false;
      }

      const t3WindowStart = t3.startMs - toleranceMs;
      const t3WindowEnd = t3.endMs + toleranceMs;
      if (startMs === endMs && t3.startMs === t3.endMs) {
        return Math.abs(startMs - t3.startMs) <= toleranceMs;
      }
      return startMs < t3WindowEnd && t3WindowStart < endMs;
    });

    if (isOverlappingWithT3Run) {
      excludedEntryIds.push(entry.id);
    } else {
      seenIds.add(entry.id);
      kept.push(entry);
    }
  }

  return {
    entries: kept,
    excludedEntryIds,
  };
}

function buildBlockFromCluster(
  cluster: ReadonlyArray<{
    readonly entry: WorklogCoreEntry;
    readonly startMs: number;
    readonly endMs: number;
  }>,
  gapToleranceMinutes: number,
): MergedWorklogCoreBlock {
  const first = cluster[0]!;
  const last = cluster[cluster.length - 1]!;

  let minStartMs = first.startMs;
  let minStartedAt = first.entry.startedAt;
  let maxEndMs = first.endMs;
  let maxEndedAt = first.entry.endedAt;
  let status: WorklogCoreEntryStatus = last.entry.status;
  let turnCount = 0;
  let latestSummary: string | undefined;
  let latestThreadUrl: string | undefined;
  let latestProjectTitle: string | undefined;
  let latestModel: string | undefined;

  const entryIds: Array<string> = [];
  const statsList: Array<WorklogCoreStats> = [];
  const intervals: Array<{ readonly startMs: number; readonly endMs: number }> = [];

  for (const item of cluster) {
    entryIds.push(item.entry.id);
    statsList.push(item.entry.stats);
    intervals.push({ startMs: item.startMs, endMs: item.endMs });
    turnCount += Math.max(1, item.entry.turnCount);

    if (item.startMs < minStartMs) {
      minStartMs = item.startMs;
      minStartedAt = item.entry.startedAt;
    }
    if (item.endMs >= maxEndMs) {
      maxEndMs = item.endMs;
      maxEndedAt = item.entry.endedAt;
      status = item.entry.status;
    }
    if (item.entry.summary !== undefined && item.entry.summary.trim().length > 0) {
      latestSummary = item.entry.summary;
    }
    if (item.entry.threadUrl !== undefined) {
      latestThreadUrl = item.entry.threadUrl;
    }
    if (item.entry.projectTitle !== undefined) {
      latestProjectTitle = item.entry.projectTitle;
    }
    if (item.entry.model !== undefined) {
      latestModel = item.entry.model;
    }
  }

  if (cluster.some((item) => item.entry.status === "running")) {
    status = "running";
  }

  const durationMs = Math.max(0, maxEndMs - minStartMs);
  const activeDurationMs = calculateMergedIntervalDurationMs(intervals);
  const blockId =
    cluster.length === 1 ? first.entry.id : `merged:${first.entry.id}:${cluster.length}`;

  return {
    id: blockId,
    entryIds,
    source: first.entry.source,
    environmentId: first.entry.environmentId,
    projectId: first.entry.projectId,
    ...(latestProjectTitle !== undefined ? { projectTitle: latestProjectTitle } : {}),
    threadId: first.entry.threadId,
    threadRole: first.entry.threadRole,
    provider: first.entry.provider,
    ...(first.entry.providerInstanceId !== undefined
      ? { providerInstanceId: first.entry.providerInstanceId }
      : {}),
    ...(latestModel !== undefined ? { model: latestModel } : {}),
    title: first.entry.title,
    ...(latestSummary !== undefined ? { summary: latestSummary } : {}),
    status,
    startedAt: minStartedAt,
    endedAt: maxEndedAt,
    startedAtMs: minStartMs,
    endedAtMs: maxEndMs,
    durationMs,
    activeDurationMs,
    turnCount,
    gapToleranceMinutes,
    stats: sumWorklogStats(statsList),
    ...(latestThreadUrl !== undefined ? { threadUrl: latestThreadUrl } : {}),
  };
}

export function groupWorklogEntries(
  entries: ReadonlyArray<WorklogCoreEntry>,
  options?: GroupWorklogEntriesOptions,
): ReadonlyArray<MergedWorklogCoreBlock> {
  const shouldDeduplicate = options?.deduplicateImported ?? true;
  const sourceEntries = shouldDeduplicate
    ? deduplicateWorklogEntries(entries, { overlapToleranceMs: options?.overlapToleranceMs })
        .entries
    : entries;

  const isRawMode = options?.mode === "raw" || options?.gapToleranceMinutes === null;
  const gapToleranceMinutes = isRawMode ? 0 : Math.max(0, options?.gapToleranceMinutes ?? 5);
  const gapToleranceMs = gapToleranceMinutes * 60_000;

  const decorated = sourceEntries
    .map((entry) => {
      const { startMs, endMs } = parseTimestampBounds(entry);
      return { entry, startMs, endMs };
    })
    .sort(
      (a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.entry.id.localeCompare(b.entry.id),
    );

  if (isRawMode) {
    return decorated.map((item) => buildBlockFromCluster([item], 0));
  }

  const groupsByThreadKey = new Map<
    string,
    Array<{
      readonly entry: WorklogCoreEntry;
      readonly startMs: number;
      readonly endMs: number;
    }>
  >();
  const standaloneBlocks: Array<MergedWorklogCoreBlock> = [];

  for (const item of decorated) {
    if (item.entry.threadId === null || item.entry.threadId.trim().length === 0) {
      standaloneBlocks.push(buildBlockFromCluster([item], gapToleranceMinutes));
      continue;
    }
    const key = `${item.entry.environmentId}\0${item.entry.provider}\0${item.entry.threadId}`;
    const bucket = groupsByThreadKey.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      groupsByThreadKey.set(key, [item]);
    }
  }

  const mergedBlocks: Array<MergedWorklogCoreBlock> = [...standaloneBlocks];

  for (const threadItems of groupsByThreadKey.values()) {
    let currentCluster: Array<{
      readonly entry: WorklogCoreEntry;
      readonly startMs: number;
      readonly endMs: number;
    }> = [threadItems[0]!];
    let currentClusterMaxEndMs = threadItems[0]!.endMs;

    for (let i = 1; i < threadItems.length; i++) {
      const candidate = threadItems[i]!;
      if (candidate.startMs <= currentClusterMaxEndMs + gapToleranceMs) {
        currentCluster.push(candidate);
        if (candidate.endMs > currentClusterMaxEndMs) {
          currentClusterMaxEndMs = candidate.endMs;
        }
      } else {
        mergedBlocks.push(buildBlockFromCluster(currentCluster, gapToleranceMinutes));
        currentCluster = [candidate];
        currentClusterMaxEndMs = candidate.endMs;
      }
    }
    mergedBlocks.push(buildBlockFromCluster(currentCluster, gapToleranceMinutes));
  }

  return mergedBlocks.sort(
    (a, b) =>
      a.startedAtMs - b.startedAtMs || a.endedAtMs - b.endedAtMs || a.id.localeCompare(b.id),
  );
}

function splitWorklogBlockByDay(
  block: MergedWorklogCoreBlock,
  timeZone: string,
): ReadonlyArray<WorklogDaySlice> {
  const startMs = block.startedAtMs;
  const endMs = Math.max(startMs, block.endedAtMs);

  if (endMs === startMs) {
    const bounds = getDayBoundsForTimestamp(startMs, timeZone);
    const dayLengthMs = Math.max(1, bounds.dayEndMs - bounds.dayStartMs);
    const minuteOfDay = ((startMs - bounds.dayStartMs) / dayLengthMs) * 1440;
    return [
      {
        sliceId: `${block.id}@${bounds.dayKey}`,
        blockId: block.id,
        entryIds: block.entryIds,
        dayKey: bounds.dayKey,
        dayStartMs: bounds.dayStartMs,
        dayEndMs: bounds.dayEndMs,
        sliceStartMs: startMs,
        sliceEndMs: endMs,
        durationMs: 0,
        startMinuteOfDay: Math.max(0, Math.min(1440, minuteOfDay)),
        endMinuteOfDay: Math.max(0, Math.min(1440, minuteOfDay)),
        isClippedStart: false,
        isClippedEnd: false,
        source: block.source,
        environmentId: block.environmentId,
        projectId: block.projectId,
        ...(block.projectTitle !== undefined ? { projectTitle: block.projectTitle } : {}),
        threadId: block.threadId,
        threadRole: block.threadRole,
        provider: block.provider,
        ...(block.model !== undefined ? { model: block.model } : {}),
        title: block.title,
        ...(block.summary !== undefined ? { summary: block.summary } : {}),
        status: block.status,
        turnCount: block.turnCount,
        stats: block.stats,
        ...(block.threadUrl !== undefined ? { threadUrl: block.threadUrl } : {}),
      },
    ];
  }

  const slices: Array<WorklogDaySlice> = [];
  let cursorMs = startMs;

  while (cursorMs < endMs) {
    const bounds = getDayBoundsForTimestamp(cursorMs, timeZone);
    const nextBoundaryMs = bounds.dayEndMs > cursorMs ? bounds.dayEndMs : cursorMs + 86_400_000;
    const sliceStartMs = cursorMs;
    const sliceEndMs = Math.min(endMs, nextBoundaryMs);
    const durationMs = Math.max(0, sliceEndMs - sliceStartMs);
    const dayLengthMs = Math.max(1, bounds.dayEndMs - bounds.dayStartMs);

    const startMinuteOfDay = Math.max(
      0,
      Math.min(1440, ((sliceStartMs - bounds.dayStartMs) / dayLengthMs) * 1440),
    );
    const endMinuteOfDay = Math.max(
      startMinuteOfDay,
      Math.min(1440, ((sliceEndMs - bounds.dayStartMs) / dayLengthMs) * 1440),
    );

    slices.push({
      sliceId: `${block.id}@${bounds.dayKey}`,
      blockId: block.id,
      entryIds: block.entryIds,
      dayKey: bounds.dayKey,
      dayStartMs: bounds.dayStartMs,
      dayEndMs: bounds.dayEndMs,
      sliceStartMs,
      sliceEndMs,
      durationMs,
      startMinuteOfDay,
      endMinuteOfDay,
      isClippedStart: sliceStartMs > startMs,
      isClippedEnd: sliceEndMs < endMs,
      source: block.source,
      environmentId: block.environmentId,
      projectId: block.projectId,
      ...(block.projectTitle !== undefined ? { projectTitle: block.projectTitle } : {}),
      threadId: block.threadId,
      threadRole: block.threadRole,
      provider: block.provider,
      ...(block.model !== undefined ? { model: block.model } : {}),
      title: block.title,
      ...(block.summary !== undefined ? { summary: block.summary } : {}),
      status: block.status,
      turnCount: block.turnCount,
      stats: block.stats,
      ...(block.threadUrl !== undefined ? { threadUrl: block.threadUrl } : {}),
    });

    cursorMs = sliceEndMs;
  }

  return slices;
}

export function splitWorklogBlocksByDay(
  blocks: ReadonlyArray<MergedWorklogCoreBlock>,
  timeZone: string,
): ReadonlyArray<WorklogDaySlice> {
  const allSlices: Array<WorklogDaySlice> = [];
  for (const block of blocks) {
    allSlices.push(...splitWorklogBlockByDay(block, timeZone));
  }
  return allSlices.sort(
    (a, b) =>
      a.dayKey.localeCompare(b.dayKey) ||
      a.sliceStartMs - b.sliceStartMs ||
      a.sliceEndMs - b.sliceEndMs ||
      a.sliceId.localeCompare(b.sliceId),
  );
}

function roundHoursOneDecimal(durationMs: number): number {
  return Math.round((durationMs / 3_600_000) * 10) / 10;
}

export function summarizeWorklogByDay(
  blocks: ReadonlyArray<MergedWorklogCoreBlock>,
  timeZone: string,
): ReadonlyArray<DailyWorklogDurationSummary> {
  const slices = splitWorklogBlocksByDay(blocks, timeZone);
  const byDay = new Map<string, Array<WorklogDaySlice>>();

  for (const slice of slices) {
    const existing = byDay.get(slice.dayKey);
    if (existing) {
      existing.push(slice);
    } else {
      byDay.set(slice.dayKey, [slice]);
    }
  }

  const summaries: Array<DailyWorklogDurationSummary> = [];
  const sortedDayKeys = [...byDay.keys()].sort();

  for (const dayKey of sortedDayKeys) {
    const daySlices = byDay.get(dayKey)!;
    let parallelDurationMs = 0;
    const intervals: Array<{ readonly startMs: number; readonly endMs: number }> = [];

    for (const slice of daySlices) {
      parallelDurationMs += slice.durationMs;
      intervals.push({ startMs: slice.sliceStartMs, endMs: slice.sliceEndMs });
    }

    const unionDurationMs = calculateMergedIntervalDurationMs(intervals);
    summaries.push({
      dayKey,
      parallelDurationMs,
      parallelHours: roundHoursOneDecimal(parallelDurationMs),
      unionDurationMs,
      unionHours: roundHoursOneDecimal(unionDurationMs),
      sliceCount: daySlices.length,
      slices: daySlices,
    });
  }

  return summaries;
}

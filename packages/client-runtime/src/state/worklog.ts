import {
  type AgentWorklogEntry,
  type EnvironmentId,
  type WorklogFilter,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  deduplicateWorklogEntries,
  getDayBoundsForTimestamp,
  getLocalDateTimeParts,
  groupWorklogEntries,
  summarizeWorklogByDay,
  type DailyWorklogDurationSummary,
  type MergedWorklogCoreBlock,
  type WorklogCoreEntry,
  type WorklogDaySlice,
} from "@t3tools/shared/worklogGrouping.core";
import { layoutWorklogDaySlices, type WorklogLayoutItem } from "@t3tools/shared/worklogLayout.core";
import {
  calculateWorklogRangeStats,
  type WorklogRangeStatsSummary,
} from "@t3tools/shared/worklogStats.core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export interface MergedWorklogViewModel {
  readonly entries: ReadonlyArray<WorklogCoreEntry>;
  readonly blocks: ReadonlyArray<MergedWorklogCoreBlock>;
  readonly dailySummaries: ReadonlyArray<DailyWorklogDurationSummary>;
  readonly dayLayouts: Readonly<Record<string, ReadonlyArray<WorklogLayoutItem<WorklogDaySlice>>>>;
  readonly stats: WorklogRangeStatsSummary;
}

export interface WorklogDayHeaderDescriptor {
  readonly dayKey: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekdayIndex: number;
  readonly dayStartMs: number;
  readonly dayEndMs: number;
  readonly dateLabel: string;
}

export interface WorklogWindowRange {
  readonly viewMode: "week" | "day";
  readonly sinceIso: string;
  readonly untilIso: string;
  readonly days: ReadonlyArray<WorklogDayHeaderDescriptor>;
}

export function createWorklogEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const worklogRevision = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`environment-data:worklog:revision:${environmentId}`)),
  );
  const icalFeedRevision = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`environment-data:worklog:ical-revision:${environmentId}`)),
  );

  const bumpWorklog = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
    Effect.sync(() => {
      registry.update(worklogRevision(environmentId), (n) => n + 1);
    });

  const bumpIcalFeeds = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
    Effect.sync(() => {
      registry.update(icalFeedRevision(environmentId), (n) => n + 1);
    });

  const query = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:worklog:query",
    tag: WS_METHODS.worklogQuery,
    staleTimeMs: 15_000,
    refreshTrigger: ({ environmentId }) => worklogRevision(environmentId),
  });

  const stats = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:worklog:stats",
    tag: WS_METHODS.worklogGetStats,
    staleTimeMs: 15_000,
    refreshTrigger: ({ environmentId }) => worklogRevision(environmentId),
  });

  const listIcalFeeds = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:worklog:list-ical-feeds",
    tag: WS_METHODS.worklogListIcalFeeds,
    staleTimeMs: 15_000,
    refreshTrigger: ({ environmentId }) => icalFeedRevision(environmentId),
  });

  return {
    query,
    stats,
    listIcalFeeds,
    backfill: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:worklog:backfill",
      tag: WS_METHODS.worklogBackfill,
      onSuccess: ({ environmentId }, registry) => bumpWorklog(registry, environmentId),
    }),
    createIcalFeed: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:worklog:create-ical-feed",
      tag: WS_METHODS.worklogCreateIcalFeed,
      onSuccess: ({ environmentId }, registry) => bumpIcalFeeds(registry, environmentId),
    }),
    rotateIcalFeedToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:worklog:rotate-ical-feed-token",
      tag: WS_METHODS.worklogRotateIcalFeedToken,
      onSuccess: ({ environmentId }, registry) => bumpIcalFeeds(registry, environmentId),
    }),
    deleteIcalFeed: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:worklog:delete-ical-feed",
      tag: WS_METHODS.worklogDeleteIcalFeed,
      onSuccess: ({ environmentId }, registry) => bumpIcalFeeds(registry, environmentId),
    }),
  };
}

function agentWorklogEntryToCore(entry: AgentWorklogEntry): WorklogCoreEntry {
  return {
    id: entry.id,
    source: entry.source,
    environmentId: entry.environmentId,
    projectId: entry.projectId,
    ...(entry.projectTitle !== undefined ? { projectTitle: entry.projectTitle } : {}),
    threadId: entry.threadId,
    runId: entry.runId,
    threadRole: entry.threadRole,
    provider: entry.provider,
    ...(entry.providerInstanceId !== undefined
      ? { providerInstanceId: entry.providerInstanceId }
      : {}),
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    title: entry.title,
    ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
    status: entry.status,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    durationMs: entry.durationMs,
    turnCount: entry.turnCount,
    stats: entry.stats,
    ...(entry.threadUrl !== undefined ? { threadUrl: entry.threadUrl } : {}),
  };
}

function matchesClientWorklogFilter(entry: WorklogCoreEntry, filter?: WorklogFilter): boolean {
  if (!filter) return true;
  if (filter.since !== undefined && entry.endedAt < filter.since) {
    return false;
  }
  if (filter.until !== undefined && entry.startedAt > filter.until) {
    return false;
  }
  if (
    filter.environmentIds !== undefined &&
    filter.environmentIds.length > 0 &&
    !(filter.environmentIds as ReadonlyArray<string>).includes(entry.environmentId)
  ) {
    return false;
  }
  if (
    filter.projectIds !== undefined &&
    filter.projectIds.length > 0 &&
    (entry.projectId === null ||
      !(filter.projectIds as ReadonlyArray<string>).includes(entry.projectId))
  ) {
    return false;
  }
  if (
    filter.threadIds !== undefined &&
    filter.threadIds.length > 0 &&
    (entry.threadId === null ||
      !(filter.threadIds as ReadonlyArray<string>).includes(entry.threadId))
  ) {
    return false;
  }
  if (
    filter.providers !== undefined &&
    filter.providers.length > 0 &&
    !(filter.providers as ReadonlyArray<string>).includes(entry.provider)
  ) {
    return false;
  }
  if (
    filter.sources !== undefined &&
    filter.sources.length > 0 &&
    !filter.sources.includes(entry.source)
  ) {
    return false;
  }
  if (
    filter.threadRoles !== undefined &&
    filter.threadRoles.length > 0 &&
    !filter.threadRoles.includes(entry.threadRole)
  ) {
    return false;
  }
  if (
    filter.statuses !== undefined &&
    filter.statuses.length > 0 &&
    !filter.statuses.includes(entry.status)
  ) {
    return false;
  }
  if (
    filter.minDurationMs !== undefined &&
    entry.durationMs !== undefined &&
    entry.durationMs < filter.minDurationMs
  ) {
    return false;
  }
  if (filter.searchQuery !== undefined && filter.searchQuery.trim().length > 0) {
    const needle = filter.searchQuery.trim().toLowerCase();
    const fields = [
      entry.title,
      entry.summary ?? "",
      entry.projectTitle ?? "",
      entry.provider,
      entry.model ?? "",
    ];
    if (!fields.some((f) => f.toLowerCase().includes(needle))) {
      return false;
    }
  }
  return true;
}

export function mergeEnvironmentWorklogs(input: {
  readonly entriesByEnvironment: ReadonlyArray<ReadonlyArray<AgentWorklogEntry>>;
  readonly mode?: "raw" | "merged" | undefined;
  readonly gapToleranceMinutes?: number | null | undefined;
  readonly timeZone: string;
  readonly filter?: WorklogFilter | undefined;
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  readonly topProjectsLimit?: number | undefined;
}): MergedWorklogViewModel {
  const byCompositeKey = new Map<string, WorklogCoreEntry>();
  for (const envEntries of input.entriesByEnvironment) {
    for (const entry of envEntries) {
      const core = agentWorklogEntryToCore(entry);
      if (!matchesClientWorklogFilter(core, input.filter)) {
        continue;
      }
      const key = `${core.environmentId}:${core.source}:${core.runId ?? core.id}`;
      const existing = byCompositeKey.get(key);
      if (!existing || core.endedAt >= existing.endedAt) {
        byCompositeKey.set(key, core);
      }
    }
  }

  const deduped = deduplicateWorklogEntries([...byCompositeKey.values()]);
  const entries = [...deduped.entries].sort(
    (a, b) =>
      a.startedAt.localeCompare(b.startedAt) ||
      a.endedAt.localeCompare(b.endedAt) ||
      a.id.localeCompare(b.id),
  );

  const blocks = groupWorklogEntries(entries, {
    mode: input.mode,
    gapToleranceMinutes: input.gapToleranceMinutes,
    deduplicateImported: false,
  });

  const dailySummaries = summarizeWorklogByDay(blocks, input.timeZone);
  const dayLayouts: Record<string, ReadonlyArray<WorklogLayoutItem<WorklogDaySlice>>> = {};
  for (const summary of dailySummaries) {
    dayLayouts[summary.dayKey] = layoutWorklogDaySlices(summary.slices);
  }

  const stats = calculateWorklogRangeStats(entries, {
    since: input.since ?? input.filter?.since,
    until: input.until ?? input.filter?.until,
    timeZone: input.timeZone,
    topProjectsLimit: input.topProjectsLimit,
    deduplicateImported: false,
  });

  return {
    entries,
    blocks,
    dailySummaries,
    dayLayouts,
    stats,
  };
}

export function buildWorklogWindowRange(input: {
  readonly anchorMs: number;
  readonly viewMode: "week" | "day";
  readonly timeZone: string;
  readonly weekStartsOn?: 0 | 1 | undefined;
}): WorklogWindowRange {
  const anchorParts = getLocalDateTimeParts(input.anchorMs, input.timeZone);
  const anchorNoonUtc = DateTime.makeUnsafe({
    year: anchorParts.year,
    month: anchorParts.month,
    day: anchorParts.day,
    hours: 12,
  });
  const anchorWeekday = DateTime.getPartUtc(anchorNoonUtc, "weekDay");
  const weekStartsOn = input.weekStartsOn ?? 1;

  let startOffsetDays = 0;
  let dayCount = 1;
  if (input.viewMode === "week") {
    const diff = (anchorWeekday - weekStartsOn + 7) % 7;
    startOffsetDays = -diff;
    dayCount = 7;
  }

  const days: Array<WorklogDayHeaderDescriptor> = [];
  for (let i = 0; i < dayCount; i++) {
    const targetUtc = DateTime.add(anchorNoonUtc, { days: startOffsetDays + i });
    const bounds = getDayBoundsForTimestamp(DateTime.toEpochMillis(targetUtc), input.timeZone);
    const parts = getLocalDateTimeParts(bounds.dayStartMs + 3_600_000, input.timeZone);
    days.push({
      dayKey: bounds.dayKey,
      year: parts.year,
      month: parts.month,
      day: parts.day,
      weekdayIndex: DateTime.getPartUtc(targetUtc, "weekDay"),
      dayStartMs: bounds.dayStartMs,
      dayEndMs: bounds.dayEndMs,
      dateLabel: `${parts.month}/${parts.day}`,
    });
  }

  const firstDay = days[0]!;
  const lastDay = days[days.length - 1]!;

  return {
    viewMode: input.viewMode,
    sinceIso: DateTime.formatIso(DateTime.makeUnsafe(firstDay.dayStartMs)),
    untilIso: DateTime.formatIso(DateTime.makeUnsafe(lastDay.dayEndMs)),
    days,
  };
}

export function shiftWorklogAnchorMs(
  anchorMs: number,
  direction: -1 | 1,
  viewMode: "week" | "day",
): number {
  const deltaDays = viewMode === "week" ? 7 : 1;
  return anchorMs + direction * deltaDays * 86_400_000;
}

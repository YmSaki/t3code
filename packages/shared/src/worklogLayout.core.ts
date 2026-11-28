import { getAgentShortCode } from "./agentShortCode.ts";

export { getAgentShortCode };

export type WorklogLabelDensity = "detailed" | "normal" | "compact" | "badge_only";

export interface WorklogLayoutSliceInput {
  readonly id?: string | undefined;
  readonly sliceId?: string | undefined;
  readonly provider: string;
  readonly title: string;
  readonly startMinuteOfDay?: number | undefined;
  readonly endMinuteOfDay?: number | undefined;
  readonly sliceStartMs?: number | undefined;
  readonly sliceEndMs?: number | undefined;
  readonly dayStartMs?: number | undefined;
  readonly dayEndMs?: number | undefined;
}

export interface WorklogLayoutOptions {
  readonly minHeightPercent?: number | undefined;
  readonly useMinHeightForCollision?: boolean | undefined;
  readonly compactColumnThreshold?: number | undefined;
  readonly badgeOnlyColumnThreshold?: number | undefined;
  readonly compactHeightPercentThreshold?: number | undefined;
  readonly detailedHeightPercentThreshold?: number | undefined;
}

export interface WorklogLayoutItem<
  TSlice extends WorklogLayoutSliceInput = WorklogLayoutSliceInput,
> {
  readonly id: string;
  readonly slice: TSlice;
  readonly shortCode: string;
  readonly badgeLabel: string;
  readonly displayLabel: string;
  readonly labelDensity: WorklogLabelDensity;
  readonly columnIndex: number;
  readonly columnCount: number;
  readonly topPercent: number;
  readonly heightPercent: number;
  readonly rawHeightPercent: number;
}

export function formatAgentSummaryTitle(provider: string, title: string): string {
  const code = getAgentShortCode(provider);
  const trimmedTitle = title.trim();
  return trimmedTitle.length > 0 ? `[${code}] ${trimmedTitle}` : `[${code}]`;
}

export function doWorklogIntervalsCollide(
  a: { readonly start: number; readonly end: number },
  b: { readonly start: number; readonly end: number },
): boolean {
  if (a.start === a.end && b.start === b.end) {
    return a.start === b.start;
  }
  if (a.start === a.end) {
    return a.start >= b.start && a.start < b.end;
  }
  if (b.start === b.end) {
    return b.start >= a.start && b.start < a.end;
  }
  return a.start < b.end && b.start < a.end;
}

function resolveSlicePercentBounds(
  slice: WorklogLayoutSliceInput,
  minHeightPercent: number,
): {
  readonly rawStartPercent: number;
  readonly rawEndPercent: number;
  readonly rawHeightPercent: number;
  readonly topPercent: number;
  readonly heightPercent: number;
} {
  let startRatio = 0;
  let endRatio = 0;

  if (slice.startMinuteOfDay !== undefined && slice.endMinuteOfDay !== undefined) {
    startRatio = slice.startMinuteOfDay / 1440;
    endRatio = slice.endMinuteOfDay / 1440;
  } else if (
    slice.sliceStartMs !== undefined &&
    slice.sliceEndMs !== undefined &&
    slice.dayStartMs !== undefined
  ) {
    const dayDurationMs =
      slice.dayEndMs !== undefined && slice.dayEndMs > slice.dayStartMs
        ? slice.dayEndMs - slice.dayStartMs
        : 86_400_000;
    startRatio = (slice.sliceStartMs - slice.dayStartMs) / dayDurationMs;
    endRatio = (slice.sliceEndMs - slice.dayStartMs) / dayDurationMs;
  }

  const clampedStart = Math.max(0, Math.min(100, startRatio * 100));
  const clampedEnd = Math.max(clampedStart, Math.min(100, endRatio * 100));
  const rawHeightPercent = clampedEnd - clampedStart;
  const clampedMinHeight = Math.max(0, Math.min(100, minHeightPercent));
  const heightPercent = Math.max(rawHeightPercent, clampedMinHeight);
  const topPercent =
    clampedStart + heightPercent > 100 ? Math.max(0, 100 - heightPercent) : clampedStart;

  return {
    rawStartPercent: clampedStart,
    rawEndPercent: clampedEnd,
    rawHeightPercent: Math.round(rawHeightPercent * 10_000) / 10_000,
    topPercent: Math.round(topPercent * 10_000) / 10_000,
    heightPercent: Math.round(heightPercent * 10_000) / 10_000,
  };
}

function determineWorklogLabelDensity(params: {
  readonly heightPercent: number;
  readonly columnCount: number;
  readonly compactColumnThreshold: number;
  readonly badgeOnlyColumnThreshold: number;
  readonly compactHeightPercentThreshold: number;
  readonly detailedHeightPercentThreshold: number;
}): WorklogLabelDensity {
  if (
    params.columnCount >= params.badgeOnlyColumnThreshold ||
    params.heightPercent < params.compactHeightPercentThreshold * 0.6
  ) {
    return "badge_only";
  }
  if (
    params.columnCount >= params.compactColumnThreshold ||
    params.heightPercent < params.compactHeightPercentThreshold
  ) {
    return "compact";
  }
  if (params.heightPercent >= params.detailedHeightPercentThreshold && params.columnCount <= 2) {
    return "detailed";
  }
  return "normal";
}

export function layoutWorklogDaySlices<TSlice extends WorklogLayoutSliceInput>(
  slices: ReadonlyArray<TSlice>,
  options?: WorklogLayoutOptions,
): ReadonlyArray<WorklogLayoutItem<TSlice>> {
  if (slices.length === 0) return [];

  const minHeightPercent = options?.minHeightPercent ?? 1.25;
  const useMinHeightForCollision = options?.useMinHeightForCollision ?? true;
  const compactColumnThreshold = options?.compactColumnThreshold ?? 4;
  const badgeOnlyColumnThreshold = options?.badgeOnlyColumnThreshold ?? 6;
  const compactHeightPercentThreshold = options?.compactHeightPercentThreshold ?? 2.5;
  const detailedHeightPercentThreshold = options?.detailedHeightPercentThreshold ?? 6.0;

  interface PreparedSlice {
    readonly id: string;
    readonly originalIndex: number;
    readonly slice: TSlice;
    readonly topPercent: number;
    readonly heightPercent: number;
    readonly rawHeightPercent: number;
    readonly collisionStart: number;
    readonly collisionEnd: number;
  }

  const prepared: Array<PreparedSlice> = slices.map((slice, index) => {
    const id = slice.sliceId ?? slice.id ?? `slice-${index}`;
    const bounds = resolveSlicePercentBounds(slice, minHeightPercent);
    const collisionStart = useMinHeightForCollision ? bounds.topPercent : bounds.rawStartPercent;
    const collisionEnd = useMinHeightForCollision
      ? bounds.topPercent + bounds.heightPercent
      : bounds.rawEndPercent;

    return {
      id,
      originalIndex: index,
      slice,
      topPercent: bounds.topPercent,
      heightPercent: bounds.heightPercent,
      rawHeightPercent: bounds.rawHeightPercent,
      collisionStart,
      collisionEnd,
    };
  });

  const sorted = [...prepared].sort(
    (a, b) =>
      a.collisionStart - b.collisionStart ||
      b.collisionEnd - a.collisionEnd ||
      a.id.localeCompare(b.id) ||
      a.originalIndex - b.originalIndex,
  );

  const clusters: Array<Array<PreparedSlice>> = [];
  let currentCluster: Array<PreparedSlice> = [];
  let clusterMaxEnd = -1;

  for (const item of sorted) {
    if (currentCluster.length === 0) {
      currentCluster.push(item);
      clusterMaxEnd = item.collisionEnd;
      continue;
    }

    const collidesWithCluster =
      item.collisionStart < clusterMaxEnd ||
      (item.collisionStart === clusterMaxEnd &&
        currentCluster.some(
          (member) =>
            member.collisionStart === member.collisionEnd &&
            member.collisionStart === item.collisionStart,
        ));

    if (collidesWithCluster) {
      currentCluster.push(item);
      if (item.collisionEnd > clusterMaxEnd) {
        clusterMaxEnd = item.collisionEnd;
      }
    } else {
      clusters.push(currentCluster);
      currentCluster = [item];
      clusterMaxEnd = item.collisionEnd;
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  const layoutResults: Array<WorklogLayoutItem<TSlice>> = [];

  for (const cluster of clusters) {
    const columnEndPercents: Array<number> = [];
    const assignedColumns: Array<{ readonly item: PreparedSlice; readonly columnIndex: number }> =
      [];

    for (const item of cluster) {
      let assignedCol = -1;
      for (let col = 0; col < columnEndPercents.length; col++) {
        const colEnd = columnEndPercents[col]!;
        if (
          !doWorklogIntervalsCollide(
            { start: colEnd - 0.00001, end: colEnd },
            { start: item.collisionStart, end: item.collisionEnd },
          ) &&
          colEnd <= item.collisionStart
        ) {
          assignedCol = col;
          break;
        }
      }

      if (assignedCol === -1) {
        assignedCol = columnEndPercents.length;
        columnEndPercents.push(item.collisionEnd);
      } else {
        columnEndPercents[assignedCol] = item.collisionEnd;
      }

      assignedColumns.push({ item, columnIndex: assignedCol });
    }

    const columnCount = Math.max(1, columnEndPercents.length);

    for (const { item, columnIndex } of assignedColumns) {
      const shortCode = getAgentShortCode(item.slice.provider);
      const badgeLabel = `[${shortCode}]`;
      const fullLabel = formatAgentSummaryTitle(item.slice.provider, item.slice.title);
      const labelDensity = determineWorklogLabelDensity({
        heightPercent: item.heightPercent,
        columnCount,
        compactColumnThreshold,
        badgeOnlyColumnThreshold,
        compactHeightPercentThreshold,
        detailedHeightPercentThreshold,
      });

      const displayLabel = labelDensity === "badge_only" ? badgeLabel : fullLabel;

      layoutResults.push({
        id: item.id,
        slice: item.slice,
        shortCode,
        badgeLabel,
        displayLabel,
        labelDensity,
        columnIndex,
        columnCount,
        topPercent: item.topPercent,
        heightPercent: item.heightPercent,
        rawHeightPercent: item.rawHeightPercent,
      });
    }
  }

  return layoutResults;
}

import { type WorklogDayHeaderDescriptor } from "@t3tools/client-runtime/state/worklog";
import {
  getLocalDateTimeParts,
  type DailyWorklogDurationSummary,
  type MergedWorklogCoreBlock,
  type WorklogDaySlice,
} from "@t3tools/shared/worklogGrouping.core";
import { type WorklogLayoutItem } from "@t3tools/shared/worklogLayout.core";
import { useGT, useLocale } from "gt-react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { type CSSProperties, useRef } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const HOURS = Array.from({ length: 24 }, (_, index) => index);
const HOUR_ROW_HEIGHT_PX = 48;
const GRID_TOTAL_HEIGHT_PX = HOURS.length * HOUR_ROW_HEIGHT_PX;
const SWIPE_THRESHOLD_PX = 48;

interface ProviderPalette {
  readonly bg: string;
  readonly border: string;
  readonly text: string;
}

const KNOWN_PROVIDER_PALETTES: Readonly<Record<string, ProviderPalette>> = {
  codex: {
    bg: "color-mix(in srgb, #10b981 18%, var(--card))",
    border: "color-mix(in srgb, #10b981 55%, var(--border))",
    text: "var(--foreground)",
  },
  claudeagent: {
    bg: "color-mix(in srgb, #d97757 20%, var(--card))",
    border: "color-mix(in srgb, #d97757 60%, var(--border))",
    text: "var(--foreground)",
  },
  cursor: {
    bg: "color-mix(in srgb, #3b82f6 18%, var(--card))",
    border: "color-mix(in srgb, #3b82f6 55%, var(--border))",
    text: "var(--foreground)",
  },
  opencode: {
    bg: "color-mix(in srgb, #8b5cf6 18%, var(--card))",
    border: "color-mix(in srgb, #8b5cf6 55%, var(--border))",
    text: "var(--foreground)",
  },
  antigravity: {
    bg: "color-mix(in srgb, #5b87bf 20%, var(--card))",
    border: "color-mix(in srgb, #5b87bf 60%, var(--border))",
    text: "var(--foreground)",
  },
  pi: {
    bg: "color-mix(in srgb, #ec4899 18%, var(--card))",
    border: "color-mix(in srgb, #ec4899 55%, var(--border))",
    text: "var(--foreground)",
  },
  kiro: {
    bg: "color-mix(in srgb, #06b6d4 18%, var(--card))",
    border: "color-mix(in srgb, #06b6d4 55%, var(--border))",
    text: "var(--foreground)",
  },
};

function getProviderPalette(provider: string): ProviderPalette {
  const normalized = provider.trim().toLowerCase();
  const known = KNOWN_PROVIDER_PALETTES[normalized];
  if (known !== undefined) return known;

  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) % 360;
  }
  const color = `hsl(${hash} 65% 52%)`;
  return {
    bg: `color-mix(in srgb, ${color} 18%, var(--card))`,
    border: `color-mix(in srgb, ${color} 55%, var(--border))`,
    text: "var(--foreground)",
  };
}

function formatHourLabel(hour: number): string {
  const hh = hour < 10 ? `0${hour}` : `${hour}`;
  return `${hh}:00`;
}

function formatSliceStartTime(utcMs: number, timeZone: string): string {
  const parts = getLocalDateTimeParts(utcMs, timeZone);
  const hh = parts.hour < 10 ? `0${parts.hour}` : `${parts.hour}`;
  const mm = parts.minute < 10 ? `0${parts.minute}` : `${parts.minute}`;
  return `${hh}:${mm}`;
}

function formatHoursDecimal(hours: number): string {
  return `${hours.toFixed(1)}h`;
}

function formatWeekdayShort(day: WorklogDayHeaderDescriptor, locale: string): string {
  const sampleDate = new Date(Date.UTC(day.year, day.month - 1, day.day, 12, 0, 0, 0));
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(sampleDate);
}

export interface WorklogCalendarGridProps {
  readonly days: ReadonlyArray<WorklogDayHeaderDescriptor>;
  readonly dailySummaries: ReadonlyArray<DailyWorklogDurationSummary>;
  readonly dayLayouts: Readonly<Record<string, ReadonlyArray<WorklogLayoutItem<WorklogDaySlice>>>>;
  readonly blocksById: ReadonlyMap<string, MergedWorklogCoreBlock>;
  readonly timeZone: string;
  readonly nowMs: number;
  readonly selectedBlockId: string | null;
  readonly onSelectSlice: (slice: WorklogDaySlice, block: MergedWorklogCoreBlock | null) => void;
  readonly onShiftRange: (direction: -1 | 1) => void;
}

export function WorklogCalendarGrid(props: WorklogCalendarGridProps) {
  const gt = useGT();
  const locale = useLocale() || "en-US";
  const touchStartXRef = useRef<number | null>(null);

  const summaryByDay = new Map<string, DailyWorklogDurationSummary>();
  for (const summary of props.dailySummaries) {
    summaryByDay.set(summary.dayKey, summary);
  }

  const nowParts = getLocalDateTimeParts(props.nowMs, props.timeZone);
  const nowMinutes = nowParts.hour * 60 + nowParts.minute;
  const nowTopPercent = (nowMinutes / 1440) * 100;

  const isSingleDay = props.days.length === 1;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card"
      onTouchStart={(event) => {
        const touch = event.changedTouches[0];
        if (touch) {
          touchStartXRef.current = touch.clientX;
        }
      }}
      onTouchEnd={(event) => {
        const startX = touchStartXRef.current;
        touchStartXRef.current = null;
        const touch = event.changedTouches[0];
        if (startX === null || !touch) return;
        const deltaX = touch.clientX - startX;
        if (Math.abs(deltaX) >= SWIPE_THRESHOLD_PX) {
          props.onShiftRange(deltaX > 0 ? -1 : 1);
        }
      }}
    >
      <div className="flex shrink-0 items-stretch border-b border-border bg-muted/40">
        <div className="flex w-14 shrink-0 items-center justify-center border-r border-border px-1 py-2 text-xs font-medium text-muted-foreground">
          {isSingleDay ? (
            <div className="flex items-center gap-0.5">
              <Button
                aria-label={gt("Previous day")}
                size="icon-xs"
                variant="ghost"
                onClick={() => props.onShiftRange(-1)}
              >
                <ChevronLeftIcon className="size-3.5" />
              </Button>
              <Button
                aria-label={gt("Next day")}
                size="icon-xs"
                variant="ghost"
                onClick={() => props.onShiftRange(1)}
              >
                <ChevronRightIcon className="size-3.5" />
              </Button>
            </div>
          ) : (
            <span>24h</span>
          )}
        </div>

        <div className={cn("grid min-w-0 flex-1", isSingleDay ? "grid-cols-1" : "grid-cols-7")}>
          {props.days.map((day) => {
            const summary = summaryByDay.get(day.dayKey);
            const parallelHours = summary?.parallelHours ?? 0;
            const isToday = day.dayKey === nowParts.dayKey;

            return (
              <div
                key={day.dayKey}
                className={cn(
                  "flex min-w-0 flex-col items-center justify-center gap-0.5 border-r border-border px-1.5 py-2 last:border-r-0",
                  isToday && "bg-primary/8",
                )}
              >
                <div className="flex items-baseline gap-1 text-xs">
                  <span
                    className={cn(
                      "font-medium",
                      isToday ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    {formatWeekdayShort(day, locale)}
                  </span>
                  <span
                    className={cn(
                      "font-semibold tabular-nums",
                      isToday ? "text-primary" : "text-foreground",
                    )}
                  >
                    {day.dateLabel}
                  </span>
                </div>
                <div
                  className={cn(
                    "rounded-sm px-1.5 py-0.5 text-xs font-semibold tabular-nums",
                    parallelHours > 0
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {formatHoursDecimal(parallelHours)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative flex w-full" style={{ height: `${GRID_TOTAL_HEIGHT_PX}px` }}>
          <div className="relative w-14 shrink-0 border-r border-border bg-muted/20 select-none">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="relative border-b border-border/50 px-1.5 text-right"
                style={{ height: `${HOUR_ROW_HEIGHT_PX}px` }}
              >
                <span className="block -translate-y-2 text-xs text-muted-foreground tabular-nums">
                  {hour > 0 ? formatHourLabel(hour) : ""}
                </span>
              </div>
            ))}
          </div>

          <div
            className={cn(
              "relative grid min-w-0 flex-1",
              isSingleDay ? "grid-cols-1" : "grid-cols-7",
            )}
          >
            {props.days.map((day) => {
              const layoutItems = props.dayLayouts[day.dayKey] ?? [];
              const isToday = day.dayKey === nowParts.dayKey;

              return (
                <div
                  key={day.dayKey}
                  className={cn(
                    "relative h-full min-w-0 border-r border-border last:border-r-0",
                    isToday && "bg-primary/4",
                  )}
                >
                  {HOURS.map((hour) => (
                    <div
                      key={hour}
                      className="border-b border-border/40"
                      style={{ height: `${HOUR_ROW_HEIGHT_PX}px` }}
                    />
                  ))}

                  {isToday ? (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute right-0 left-0 z-20 flex items-center"
                      style={{ top: `${nowTopPercent}%` }}
                    >
                      <span className="-ml-1 size-2 rounded-full bg-destructive" />
                      <span className="h-0.5 flex-1 bg-destructive" />
                    </div>
                  ) : null}

                  {layoutItems.map((item) => {
                    const palette = getProviderPalette(item.slice.provider);
                    const block = props.blocksById.get(item.slice.blockId) ?? null;
                    const isSelected = props.selectedBlockId === item.slice.blockId;
                    const startLabel = formatSliceStartTime(
                      item.slice.sliceStartMs,
                      props.timeZone,
                    );
                    const laneWidthPercent = 100 / Math.max(1, item.columnCount);
                    const laneLeftPercent = item.columnIndex * laneWidthPercent;

                    const blockStyle: CSSProperties = {
                      top: `${item.topPercent}%`,
                      height: `${item.heightPercent}%`,
                      left: `calc(${laneLeftPercent}% + 2px)`,
                      width: `calc(${laneWidthPercent}% - 4px)`,
                      backgroundColor: palette.bg,
                      borderColor: isSelected ? "var(--ring)" : palette.border,
                      color: palette.text,
                    };

                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => props.onSelectSlice(item.slice, block)}
                        style={blockStyle}
                        aria-label={`${item.badgeLabel} ${startLabel} ${item.slice.title}`}
                        className={cn(
                          "absolute z-10 flex cursor-pointer flex-col overflow-hidden rounded-md border px-1.5 py-0.5 text-left transition-shadow focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none",
                          isSelected && "z-20 ring-2 ring-inset ring-ring",
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-1 leading-tight">
                          <span className="shrink-0 font-mono text-xs font-semibold">
                            {item.badgeLabel}
                          </span>
                          {item.labelDensity !== "badge_only" ? (
                            <>
                              {item.columnCount <= 2 ? (
                                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                  {startLabel}
                                </span>
                              ) : null}
                              <span className="min-w-0 truncate text-xs font-medium">
                                {item.slice.title}
                              </span>
                            </>
                          ) : null}
                        </div>

                        {item.labelDensity === "detailed" ? (
                          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                            {item.slice.projectTitle ? (
                              <span className="truncate">{item.slice.projectTitle}</span>
                            ) : null}
                            <span className="shrink-0 tabular-nums">
                              {`${item.slice.turnCount}t`}
                            </span>
                          </div>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

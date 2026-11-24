import {
  buildWorklogWindowRange,
  shiftWorklogAnchorMs,
} from "@t3tools/client-runtime/state/worklog";
import type {
  EnvironmentId,
  WorklogFilter,
  WorklogSource,
  WorklogThreadRole,
} from "@t3tools/contracts";
import type { MergedWorklogCoreBlock, WorklogDaySlice } from "@t3tools/shared/worklogGrouping.core";
import { getAgentShortCode } from "@t3tools/shared/worklogLayout.core";
import { createFileRoute } from "@tanstack/react-router";
import { useGT, useLocale } from "gt-react";
import {
  BarChart3Icon,
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FilterIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Separator } from "~/components/ui/separator";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { WorklogCalendarGrid } from "~/components/worklog/WorklogCalendarGrid";
import {
  WorklogBlockDetailSheet,
  WorklogIcalDialog,
  WorklogStatsDialog,
} from "~/components/worklog/WorklogDetailAndStats";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useNowMinute } from "~/hooks/useNowMinute";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useMultiEnvironmentWorklog, useWorklogIcalFeeds } from "~/state/worklog";

type GapOption = "raw" | "0" | "5" | "15";

const PROVIDER_FILTER_OPTIONS = [
  "codex",
  "claudeAgent",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "kiro",
] as const;

const SOURCE_OPTIONS: ReadonlyArray<WorklogSource> = ["t3_run", "imported_cli"];
const ROLE_OPTIONS: ReadonlyArray<WorklogThreadRole> = ["pm", "worker", "standard"];

function toggleStringItem<T extends string>(list: ReadonlyArray<T>, item: T): ReadonlyArray<T> {
  return list.includes(item) ? list.filter((v) => v !== item) : [...list, item];
}

function formatRangeHeader(
  days: ReadonlyArray<{ readonly year: number; readonly month: number; readonly day: number }>,
  locale: string,
): string {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return "";
  const formatter = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const firstDate = new Date(Date.UTC(first.year, first.month - 1, first.day, 12, 0, 0, 0));
  if (days.length === 1) {
    return formatter.format(firstDate);
  }
  const lastDate = new Date(Date.UTC(last.year, last.month - 1, last.day, 12, 0, 0, 0));
  return `${formatter.format(firstDate)} - ${formatter.format(lastDate)}`;
}

function resolveClientTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function WorklogCalendarPage() {
  const gt = useGT();
  const locale = useLocale() || "en-US";
  const isMobile = useMediaQuery("max-md");
  const nowMinuteIso = useNowMinute();
  const nowMs = Date.parse(nowMinuteIso);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { backfill } = useWorklogIcalFeeds(primaryEnvironmentId);

  const timeZone = resolveClientTimeZone();

  const [viewModeOverride, setViewModeOverride] = useState<"week" | "day" | null>(null);
  const viewMode: "week" | "day" = viewModeOverride ?? (isMobile ? "day" : "week");
  const [anchorMs, setAnchorMs] = useState<number>(() => Date.parse(nowMinuteIso));
  const [gapOption, setGapOption] = useState<GapOption>("5");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProviders, setSelectedProviders] = useState<ReadonlyArray<string>>([]);
  const [selectedSources, setSelectedSources] = useState<ReadonlyArray<WorklogSource>>([]);
  const [selectedRoles, setSelectedRoles] = useState<ReadonlyArray<WorklogThreadRole>>([]);
  const [selectedEnvIds, setSelectedEnvIds] = useState<ReadonlyArray<EnvironmentId>>([]);

  const [selectedSlice, setSelectedSlice] = useState<{
    readonly slice: WorklogDaySlice;
    readonly block: MergedWorklogCoreBlock | null;
  } | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [icalOpen, setIcalOpen] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const windowRange = buildWorklogWindowRange({
    anchorMs,
    viewMode,
    timeZone,
    weekStartsOn: 1,
  });

  const filter: WorklogFilter = {
    since: windowRange.sinceIso,
    until: windowRange.untilIso,
    ...(selectedEnvIds.length > 0 ? { environmentIds: selectedEnvIds } : {}),
    ...(selectedProviders.length > 0
      ? { providers: selectedProviders as WorklogFilter["providers"] }
      : {}),
    ...(selectedSources.length > 0 ? { sources: selectedSources } : {}),
    ...(selectedRoles.length > 0 ? { threadRoles: selectedRoles } : {}),
    ...(searchQuery.trim().length > 0 ? { searchQuery: searchQuery.trim() } : {}),
  };

  const mode = gapOption === "raw" ? "raw" : "merged";
  const gapToleranceMinutes =
    gapOption === "raw" ? null : gapOption === "0" ? 0 : gapOption === "15" ? 15 : 5;

  const worklog = useMultiEnvironmentWorklog({
    since: windowRange.sinceIso,
    until: windowRange.untilIso,
    timeZone,
    mode,
    gapToleranceMinutes,
    filter,
  });

  const blocksById = new Map<string, MergedWorklogCoreBlock>();
  for (const block of worklog.merged.blocks) {
    blocksById.set(block.id, block);
  }

  const environmentLabels = new Map<string, string>();
  for (const env of worklog.environmentStatuses) {
    environmentLabels.set(env.environmentId, env.label);
  }

  const activeFilterCount =
    selectedProviders.length +
    selectedSources.length +
    selectedRoles.length +
    selectedEnvIds.length +
    (searchQuery.trim().length > 0 ? 1 : 0);

  const handleBackfill = async () => {
    if (!primaryEnvironmentId || backfilling) return;
    setBackfilling(true);
    await backfill(primaryEnvironmentId);
    worklog.refresh();
    setBackfilling(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 sm:p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Button
              aria-label={gt("Previous range")}
              size="icon-sm"
              variant="outline"
              onClick={() => setAnchorMs(shiftWorklogAnchorMs(anchorMs, -1, viewMode))}
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            <Button
              aria-label={gt("Next range")}
              size="icon-sm"
              variant="outline"
              onClick={() => setAnchorMs(shiftWorklogAnchorMs(anchorMs, 1, viewMode))}
            >
              <ChevronRightIcon className="size-4" />
            </Button>
          </div>

          <Button size="sm" variant="outline" onClick={() => setAnchorMs(nowMs)}>
            {gt("Latest")}
          </Button>

          <h1 className="text-sm font-semibold sm:text-base">
            {formatRangeHeader(windowRange.days, locale)}
          </h1>

          {worklog.isPending ? (
            <Badge variant="outline">{gt("Loading...")}</Badge>
          ) : worklog.isPartial ? (
            <Badge variant="secondary">{gt("Syncing PCs...")}</Badge>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            value={[viewMode]}
            onValueChange={(values) => {
              const next = values[0];
              if (next === "week" || next === "day") {
                setViewModeOverride(next);
              }
            }}
          >
            <Toggle value="week">{gt("Week")}</Toggle>
            <Toggle value="day">{gt("Day")}</Toggle>
          </ToggleGroup>

          <Popover>
            <PopoverTrigger
              render={
                <Button size="sm" variant="outline">
                  <FilterIcon className="size-3.5" />
                  <span>{gt("Filter")}</span>
                  {activeFilterCount > 0 ? (
                    <Badge size="sm" variant="secondary">
                      {activeFilterCount}
                    </Badge>
                  ) : null}
                </Button>
              }
            />
            <PopoverPopup align="end" width="lg">
              <div className="space-y-3 text-sm">
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">
                    {gt("Search Title or Project")}
                  </div>
                  <Input
                    placeholder={gt("Search...")}
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">
                    {gt("Block Merging")}
                  </div>
                  <ToggleGroup
                    value={[gapOption]}
                    onValueChange={(values) => {
                      const next = values[0];
                      if (next === "raw" || next === "0" || next === "5" || next === "15") {
                        setGapOption(next);
                      }
                    }}
                  >
                    <Toggle value="raw">{gt("Raw")}</Toggle>
                    <Toggle value="0">{gt("0m")}</Toggle>
                    <Toggle value="5">{gt("5m")}</Toggle>
                    <Toggle value="15">{gt("15m")}</Toggle>
                  </ToggleGroup>
                </div>

                <Separator />

                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">{gt("Agents")}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {PROVIDER_FILTER_OPTIONS.map((provider) => {
                      const active = selectedProviders.includes(provider);
                      return (
                        <Button
                          key={provider}
                          size="xs"
                          variant={active ? "default" : "outline"}
                          onClick={() =>
                            setSelectedProviders(toggleStringItem(selectedProviders, provider))
                          }
                        >
                          {`[${getAgentShortCode(provider)}] ${provider}`}
                        </Button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">{gt("Source")}</div>
                    {SOURCE_OPTIONS.map((source) => (
                      <label
                        key={source}
                        className="flex cursor-pointer items-center gap-2 text-xs"
                      >
                        <Checkbox
                          checked={selectedSources.includes(source)}
                          onCheckedChange={() =>
                            setSelectedSources(toggleStringItem(selectedSources, source))
                          }
                        />
                        <span>{source === "t3_run" ? gt("T3 Run") : gt("Imported CLI")}</span>
                      </label>
                    ))}
                  </div>

                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">{gt("Role")}</div>
                    {ROLE_OPTIONS.map((role) => (
                      <label key={role} className="flex cursor-pointer items-center gap-2 text-xs">
                        <Checkbox
                          checked={selectedRoles.includes(role)}
                          onCheckedChange={() =>
                            setSelectedRoles(toggleStringItem(selectedRoles, role))
                          }
                        />
                        <span>{role}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {worklog.environmentStatuses.length > 1 ? (
                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">
                      {gt("Environments")}
                    </div>
                    <div className="space-y-1">
                      {worklog.environmentStatuses.map((env) => (
                        <label
                          key={env.environmentId}
                          className="flex cursor-pointer items-center gap-2 text-xs"
                        >
                          <Checkbox
                            checked={selectedEnvIds.includes(env.environmentId)}
                            onCheckedChange={() =>
                              setSelectedEnvIds(toggleStringItem(selectedEnvIds, env.environmentId))
                            }
                          />
                          <span className="truncate">{env.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}

                <Separator />

                <div className="flex items-center justify-between gap-2">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setSearchQuery("");
                      setSelectedProviders([]);
                      setSelectedSources([]);
                      setSelectedRoles([]);
                      setSelectedEnvIds([]);
                    }}
                  >
                    {gt("Reset")}
                  </Button>
                  <Button
                    disabled={!primaryEnvironmentId || backfilling}
                    size="xs"
                    variant="outline"
                    onClick={() => void handleBackfill()}
                  >
                    <RefreshCwIcon className="size-3.5" />
                    {backfilling ? gt("Backfilling...") : gt("Backfill History")}
                  </Button>
                </div>
              </div>
            </PopoverPopup>
          </Popover>

          <Button size="sm" variant="outline" onClick={() => setStatsOpen(true)}>
            <BarChart3Icon className="size-3.5" />
            <span>{gt("Stats")}</span>
          </Button>

          <Button size="sm" variant="outline" onClick={() => setIcalOpen(true)}>
            <CalendarIcon className="size-3.5" />
            <span>{gt("iCal")}</span>
          </Button>
        </div>
      </header>

      <WorklogCalendarGrid
        blocksById={blocksById}
        dailySummaries={worklog.merged.dailySummaries}
        dayLayouts={worklog.merged.dayLayouts}
        days={windowRange.days}
        nowMs={nowMs}
        selectedBlockId={selectedSlice?.slice.blockId ?? null}
        timeZone={timeZone}
        onSelectSlice={(slice, block) => setSelectedSlice({ slice, block })}
        onShiftRange={(direction) =>
          setAnchorMs(shiftWorklogAnchorMs(anchorMs, direction, viewMode))
        }
      />

      <WorklogBlockDetailSheet
        block={selectedSlice?.block ?? null}
        environmentLabels={environmentLabels}
        open={selectedSlice !== null}
        slice={selectedSlice?.slice ?? null}
        timeZone={timeZone}
        onOpenChange={(open) => {
          if (!open) setSelectedSlice(null);
        }}
      />

      <WorklogStatsDialog
        open={statsOpen}
        stats={worklog.merged.stats}
        onOpenChange={setStatsOpen}
      />

      <WorklogIcalDialog
        blocks={worklog.merged.blocks}
        defaultEnvironmentId={primaryEnvironmentId}
        environments={worklog.environmentStatuses}
        nowMs={nowMs}
        open={icalOpen}
        timeZone={timeZone}
        onOpenChange={setIcalOpen}
      />
    </div>
  );
}

export const Route = createFileRoute("/_chat/worklog")({
  component: WorklogCalendarPage,
});

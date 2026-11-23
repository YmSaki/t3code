import { type EnvironmentId, type IcalFeedId } from "@t3tools/contracts";
import {
  formatWorklogDurationLabel,
  generateWorklogIcalFeed,
} from "@t3tools/shared/icalGenerator.core";
import {
  type MergedWorklogCoreBlock,
  type WorklogDaySlice,
} from "@t3tools/shared/worklogGrouping.core";
import { getAgentShortCode } from "@t3tools/shared/worklogLayout.core";
import { type WorklogRangeStatsSummary } from "@t3tools/shared/worklogStats.core";
import { useNavigate } from "@tanstack/react-router";
import { useGT, useLocale } from "gt-react";
import {
  CalendarIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import {
  buildIcalSubscriptionUrl,
  type EnvironmentWorklogStatus,
  useWorklogIcalFeeds,
} from "~/state/worklog";

function formatLocalTimestamp(isoOrMs: string | number, timeZone: string, locale: string): string {
  const date = typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(Date.parse(isoOrMs));
  if (Number.isNaN(date.getTime())) return String(isoOrMs);
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatHoursFromMs(durationMs: number): string {
  return `${(durationMs / 3_600_000).toFixed(1)}h`;
}

function triggerIcsDownload(filename: string, content: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export interface WorklogBlockDetailSheetProps {
  readonly open: boolean;
  readonly slice: WorklogDaySlice | null;
  readonly block: MergedWorklogCoreBlock | null;
  readonly timeZone: string;
  readonly environmentLabels: ReadonlyMap<string, string>;
  readonly onOpenChange: (open: boolean) => void;
}

export function WorklogBlockDetailSheet(props: WorklogBlockDetailSheetProps) {
  const gt = useGT();
  const locale = useLocale() || "en-US";
  const navigate = useNavigate();

  const target = props.block ?? props.slice;
  const shortCode = target ? getAgentShortCode(target.provider) : "";
  const environmentId = target?.environmentId ?? "";
  const environmentLabel = props.environmentLabels.get(environmentId) ?? environmentId;
  const threadId = target?.threadId ?? null;
  const durationMs = props.block?.durationMs ?? props.slice?.durationMs ?? 0;

  const statusBadgeVariant =
    target?.status === "completed"
      ? "success"
      : target?.status === "failed"
        ? "error"
        : target?.status === "running"
          ? "info"
          : "warning";

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetPopup side="right">
        {target ? (
          <>
            <SheetHeader>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{`[${shortCode}] ${target.provider}`}</Badge>
                <Badge variant={statusBadgeVariant}>{target.status}</Badge>
                <Badge variant="secondary">{target.threadRole}</Badge>
              </div>
              <SheetTitle>{target.title}</SheetTitle>
              <SheetDescription>
                {target.projectTitle ?? target.projectId ?? gt("Unassigned project")}
              </SheetDescription>
            </SheetHeader>

            <ScrollArea>
              <div className="space-y-4 px-6 pb-6">
                <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                  <div>
                    <div className="text-xs text-muted-foreground">{gt("Duration")}</div>
                    <div className="font-semibold tabular-nums">
                      {formatWorklogDurationLabel(durationMs)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">{gt("Turns")}</div>
                    <div className="font-semibold tabular-nums">{target.turnCount}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">{gt("Started")}</div>
                    <div className="font-medium tabular-nums">
                      {formatLocalTimestamp(
                        props.block ? props.block.startedAtMs : props.slice!.sliceStartMs,
                        props.timeZone,
                        locale,
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">{gt("Ended")}</div>
                    <div className="font-medium tabular-nums">
                      {formatLocalTimestamp(
                        props.block ? props.block.endedAtMs : props.slice!.sliceEndMs,
                        props.timeZone,
                        locale,
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">{gt("Environment")}</div>
                    <div className="truncate font-medium">{environmentLabel}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">{gt("Source")}</div>
                    <div className="font-medium">
                      {target.source === "t3_run" ? gt("T3 Code Run") : gt("Imported CLI")}
                    </div>
                  </div>
                </div>

                {target.model ? (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{gt("Model")}</span>
                    <span className="font-mono text-xs">{target.model}</span>
                  </div>
                ) : null}

                <Separator />

                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">
                    {gt("Execution Metrics")}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-md border border-border px-3 py-2">
                      <div className="text-xs text-muted-foreground">{gt("Changed Files")}</div>
                      <div className="font-semibold tabular-nums">
                        {target.stats.changedFilesCount}
                      </div>
                    </div>
                    <div className="rounded-md border border-border px-3 py-2">
                      <div className="text-xs text-muted-foreground">{gt("Commands")}</div>
                      <div className="font-semibold tabular-nums">{target.stats.commandsCount}</div>
                    </div>
                    <div className="rounded-md border border-border px-3 py-2">
                      <div className="text-xs text-muted-foreground">{gt("Tokens (In / Out)")}</div>
                      <div className="font-semibold tabular-nums">
                        {`${target.stats.inputTokens.toLocaleString(locale)} / ${target.stats.outputTokens.toLocaleString(locale)}`}
                      </div>
                    </div>
                    <div className="rounded-md border border-border px-3 py-2">
                      <div className="text-xs text-muted-foreground">{gt("Estimated Cost")}</div>
                      <div className="font-semibold tabular-nums">
                        {formatUsd(target.stats.estimatedCostUsd)}
                      </div>
                    </div>
                  </div>
                </div>

                {target.summary ? (
                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">{gt("Summary")}</div>
                    <p className="rounded-md border border-border bg-muted/20 p-3 text-sm whitespace-pre-wrap">
                      {target.summary}
                    </p>
                  </div>
                ) : null}

                {threadId !== null && environmentId.length > 0 ? (
                  <div className="pt-2">
                    <Button
                      className="w-full"
                      variant="default"
                      onClick={() => {
                        props.onOpenChange(false);
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: {
                            environmentId: environmentId as EnvironmentId,
                            threadId,
                          },
                        });
                      }}
                    >
                      <ExternalLinkIcon className="size-4" />
                      {gt("Open Thread")}
                    </Button>
                  </div>
                ) : null}
              </div>
            </ScrollArea>
          </>
        ) : null}
      </SheetPopup>
    </Sheet>
  );
}

export interface WorklogStatsDialogProps {
  readonly open: boolean;
  readonly stats: WorklogRangeStatsSummary;
  readonly onOpenChange: (open: boolean) => void;
}

export function WorklogStatsDialog(props: WorklogStatsDialogProps) {
  const gt = useGT();
  const locale = useLocale() || "en-US";
  const { stats } = props;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{gt("Worklog Statistics")}</DialogTitle>
          <DialogDescription>
            {gt(
              "Parallel agent runtime, concurrency, cost, and project distribution for this range.",
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">{gt("Parallel Total")}</div>
              <div className="text-lg font-semibold tabular-nums">
                {formatHoursFromMs(stats.totalDurationMs)}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">{gt("Active Clock")}</div>
              <div className="text-lg font-semibold tabular-nums">
                {formatHoursFromMs(stats.totalUnionDurationMs)}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">{gt("Max Concurrency")}</div>
              <div className="text-lg font-semibold tabular-nums">{stats.maxConcurrency}</div>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">{gt("Estimated Cost")}</div>
              <div className="text-lg font-semibold tabular-nums">
                {formatUsd(stats.totals.estimatedCostUsd)}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">{gt("By Agent")}</h3>
            {stats.byProvider.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {gt("No worklog activity in this range.")}
              </p>
            ) : (
              <div className="space-y-2">
                {stats.byProvider.map((item) => {
                  const pct = Math.round(item.durationRatio * 100);
                  return (
                    <div key={item.provider} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium">
                          {`[${getAgentShortCode(item.provider)}] ${item.provider}`}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          {`${formatHoursFromMs(item.totalDurationMs)} (${pct}%) · ${formatUsd(item.stats.estimatedCostUsd)}`}
                        </span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${Math.max(2, pct)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <h3 className="text-sm font-medium">{gt("Daily Totals")}</h3>
              {stats.daily.length === 0 ? (
                <p className="text-xs text-muted-foreground">{gt("No daily records.")}</p>
              ) : (
                <div className="space-y-1.5">
                  {stats.daily.map((day) => (
                    <div
                      key={day.day}
                      className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-xs"
                    >
                      <span className="font-mono">{day.day}</span>
                      <span className="tabular-nums">
                        {`${formatHoursFromMs(day.totalDurationMs)} · ${day.turnsCount}t`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-medium">{gt("Top Projects")}</h3>
              {stats.topProjects.length === 0 ? (
                <p className="text-xs text-muted-foreground">{gt("No projects.")}</p>
              ) : (
                <div className="space-y-1.5">
                  {stats.topProjects.slice(0, 6).map((project) => (
                    <div
                      key={`${project.projectId ?? "none"}-${project.projectTitle}`}
                      className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
                    >
                      <span className="min-w-0 truncate font-medium">{project.projectTitle}</span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {`${formatHoursFromMs(project.totalDurationMs)} (${project.entriesCount.toLocaleString(locale)})`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            {gt("Close")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export interface WorklogIcalDialogProps {
  readonly open: boolean;
  readonly blocks: ReadonlyArray<MergedWorklogCoreBlock>;
  readonly timeZone: string;
  readonly nowMs: number;
  readonly environments: ReadonlyArray<EnvironmentWorklogStatus>;
  readonly defaultEnvironmentId: EnvironmentId | null;
  readonly onOpenChange: (open: boolean) => void;
}

export function WorklogIcalDialog(props: WorklogIcalDialogProps) {
  const gt = useGT();
  const connectedEnvironments = props.environments.filter((env) => env.isConnected);
  const [selectedEnvId, setSelectedEnvId] = useState<EnvironmentId | null>(
    props.defaultEnvironmentId ?? connectedEnvironments[0]?.environmentId ?? null,
  );
  const effectiveEnvId =
    selectedEnvId ?? props.defaultEnvironmentId ?? connectedEnvironments[0]?.environmentId ?? null;

  const { feeds, isPending, httpBaseUrl, canManage, createFeed, rotateToken, deleteFeed } =
    useWorklogIcalFeeds(effectiveEnvId);

  const [feedName, setFeedName] = useState("");
  const [latestIssuedUrl, setLatestIssuedUrl] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const handleDownloadIcs = () => {
    const ics = generateWorklogIcalFeed(
      props.blocks.map((block) => ({
        id: block.id,
        provider: block.provider,
        title: block.title,
        startedAt: block.startedAt,
        endedAt: block.endedAt,
        durationMs: block.durationMs,
        turnCount: block.turnCount,
        status: block.status,
        source: block.source,
        threadRole: block.threadRole,
        ...(block.projectTitle !== undefined ? { projectTitle: block.projectTitle } : {}),
        ...(block.summary !== undefined ? { summary: block.summary } : {}),
        stats: block.stats,
        ...(block.threadUrl !== undefined ? { threadUrl: block.threadUrl } : {}),
      })),
      {
        calendarName: "T3 Code Agent Worklog",
        timeZone: props.timeZone,
        generatedAt: props.nowMs,
      },
    );
    triggerIcsDownload("t3-agent-worklog.ics", ics);
  };

  const handleCreateFeed = async () => {
    if (!effectiveEnvId) return;
    const resolvedName = feedName.trim() || gt("T3 Code Agent Worklog");
    const res = await createFeed(effectiveEnvId, {
      name: resolvedName,
      timeZone: props.timeZone,
      gapToleranceMinutes: 5,
      includeStatsInDescription: true,
      includeThreadUrl: true,
    });
    if (res._tag === "Success") {
      setFeedName("");
      setLatestIssuedUrl(buildIcalSubscriptionUrl(httpBaseUrl, res.value.rawToken));
      setCopiedUrl(false);
    }
  };

  const handleRotateFeed = async (feedId: IcalFeedId) => {
    if (!effectiveEnvId) return;
    const res = await rotateToken(effectiveEnvId, feedId);
    if (res._tag === "Success") {
      setLatestIssuedUrl(buildIcalSubscriptionUrl(httpBaseUrl, res.value.rawToken));
      setCopiedUrl(false);
    }
  };

  const handleDeleteFeed = async (feedId: IcalFeedId) => {
    if (!effectiveEnvId) return;
    await deleteFeed(effectiveEnvId, feedId);
  };

  const handleCopyUrl = async () => {
    if (!latestIssuedUrl || typeof navigator === "undefined" || !navigator.clipboard) return;
    await navigator.clipboard.writeText(latestIssuedUrl);
    setCopiedUrl(true);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{gt("iCalendar Export & Subscription")}</DialogTitle>
          <DialogDescription>
            {gt(
              "Download an .ics file for the current view or subscribe from Google Calendar / Apple Calendar.",
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">{gt("One-click .ics Export")}</div>
              <div className="text-xs text-muted-foreground">
                {gt("Includes {count} worklog blocks in RFC 5545 format.", {
                  count: props.blocks.length,
                })}
              </div>
            </div>
            <Button size="sm" variant="default" onClick={handleDownloadIcs}>
              <DownloadIcon className="size-4" />
              {gt("Download .ics")}
            </Button>
          </div>

          <Separator />

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <CalendarIcon className="size-4" />
                <span>{gt("Server Subscription Feeds")}</span>
              </div>
              {connectedEnvironments.length > 1 ? (
                <Select
                  value={effectiveEnvId ?? ""}
                  onValueChange={(value) => {
                    if (value) setSelectedEnvId(value as EnvironmentId);
                  }}
                >
                  <SelectTrigger className="w-44" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {connectedEnvironments.map((env) => (
                      <SelectItem key={env.environmentId} value={env.environmentId}>
                        {env.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : null}
            </div>

            {effectiveEnvId === null ? (
              <p className="text-xs text-muted-foreground">
                {gt("Connect an environment to create a live iCal subscription URL.")}
              </p>
            ) : (
              <>
                <div className="flex gap-2">
                  <Input
                    className="flex-1"
                    placeholder={gt("Feed name (e.g. Worklog)")}
                    value={feedName}
                    onChange={(event) => setFeedName(event.target.value)}
                  />
                  <Button
                    disabled={!canManage}
                    size="sm"
                    variant="outline"
                    onClick={() => void handleCreateFeed()}
                  >
                    {gt("Create URL")}
                  </Button>
                </div>

                {latestIssuedUrl ? (
                  <div className="space-y-1.5 rounded-lg border border-border bg-accent/40 p-3">
                    <div className="text-xs font-medium">
                      {gt("Subscription URL (copy now; token is hashed on server)")}
                    </div>
                    <div className="flex items-center gap-2">
                      <Input readOnly className="flex-1" value={latestIssuedUrl} />
                      <Button size="sm" variant="outline" onClick={() => void handleCopyUrl()}>
                        {copiedUrl ? (
                          <CheckIcon className="size-3.5" />
                        ) : (
                          <CopyIcon className="size-3.5" />
                        )}
                        {copiedUrl ? gt("Copied") : gt("Copy")}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {isPending ? (
                  <p className="text-xs text-muted-foreground">{gt("Loading feeds...")}</p>
                ) : feeds.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {gt("No active iCal subscription feeds on this environment.")}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {feeds.map((feed) => (
                      <div
                        key={feed.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">{feed.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {gt("{timeZone} · {minutes}m gap", {
                              timeZone: feed.timeZone,
                              minutes: feed.gapToleranceMinutes,
                            })}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            aria-label={gt("Rotate token")}
                            disabled={!canManage}
                            size="icon-xs"
                            variant="ghost"
                            onClick={() => void handleRotateFeed(feed.id)}
                          >
                            <RefreshCwIcon className="size-3.5" />
                          </Button>
                          <Button
                            aria-label={gt("Delete feed")}
                            disabled={!canManage}
                            size="icon-xs"
                            variant="ghost-destructive"
                            onClick={() => void handleDeleteFeed(feed.id)}
                          >
                            <Trash2Icon className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            {gt("Close")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

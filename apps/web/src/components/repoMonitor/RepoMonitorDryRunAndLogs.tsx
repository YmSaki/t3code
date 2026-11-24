import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  PositiveInt,
  type EnvironmentId,
  type ProjectId,
  type RepoMonitorDryRunResult,
  type RepoMonitorEventOutcome,
  type RepoMonitorEventRecord,
  type RepoMonitorRule,
  type RepoMonitorRuleId,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ExternalLinkIcon, PlayIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react";
import { useState } from "react";

import { m as resolveMessage } from "../../i18n/messages";
import { repoMonitorEnvironment, useRepoMonitorEvents } from "../../state/repoMonitors";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";

export interface RepoMonitorDryRunAndLogsProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly rules: ReadonlyArray<RepoMonitorRule>;
  readonly selectedRuleId?: RepoMonitorRuleId | null | undefined;
  readonly onSelectRuleId?: (ruleId: RepoMonitorRuleId | null) => void;
  readonly onOpenThread?: (ref: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => void;
}

const ALL_RULES_VALUE = "__all__";

function outcomeBadgeVariant(
  outcome: RepoMonitorEventOutcome,
): "success" | "info" | "warning" | "error" | "secondary" {
  switch (outcome) {
    case "triggered":
      return "success";
    case "dry_run":
      return "info";
    case "skipped_cooldown":
    case "skipped_rate_limit":
      return "warning";
    case "skipped_kill_switch":
      return "error";
    case "skipped_disabled":
    case "skipped_loop_guard":
    case "skipped_dedupe":
      return "secondary";
  }
}

export function RepoMonitorDryRunAndLogs({
  environmentId,
  projectId,
  rules,
  selectedRuleId = null,
  onSelectRuleId,
  onOpenThread,
}: RepoMonitorDryRunAndLogsProps) {
  const gt = useGT();
  const [emitOnInitialCursor, setEmitOnInitialCursor] = useState(true);
  const [isDryRunning, setIsDryRunning] = useState(false);
  const [dryRunResults, setDryRunResults] = useState<ReadonlyArray<RepoMonitorDryRunResult> | null>(
    null,
  );
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [expandedPromptIds, setExpandedPromptIds] = useState<ReadonlyArray<string>>([]);

  const runDryRun = useAtomCommand(repoMonitorEnvironment.dryRun, { reportFailure: false });
  const eventsQuery = useRepoMonitorEvents(environmentId, {
    ...(projectId === null ? {} : { projectId }),
    ...(selectedRuleId === null ? {} : { ruleId: selectedRuleId }),
    limit: PositiveInt.make(50),
  });

  const ruleNameById = new Map(rules.map((rule) => [rule.id as string, rule.name]));

  const outcomeLabel = (outcome: RepoMonitorEventOutcome): string => {
    switch (outcome) {
      case "triggered":
        return gt("Triggered");
      case "dry_run":
        return gt("Dry run");
      case "skipped_disabled":
        return gt("Skipped (disabled)");
      case "skipped_kill_switch":
        return gt("Skipped (kill switch)");
      case "skipped_loop_guard":
        return gt("Skipped (loop guard)");
      case "skipped_dedupe":
        return gt("Skipped (duplicate)");
      case "skipped_cooldown":
        return gt("Skipped (cooldown)");
      case "skipped_rate_limit":
        return gt("Skipped (rate limit)");
    }
  };

  const togglePromptExpanded = (id: string) => {
    setExpandedPromptIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const handleDryRun = async () => {
    if (projectId === null || isDryRunning) return;
    setIsDryRunning(true);
    setDryRunError(null);
    const result = await runDryRun({
      environmentId,
      input: {
        projectId,
        ...(selectedRuleId === null ? {} : { ruleId: selectedRuleId }),
        emitOnInitialCursor,
      },
    });
    setIsDryRunning(false);
    if (result._tag === "Success") {
      setDryRunResults(result.value.results);
      toastManager.add({
        type: "success",
        title: gt("Dry run completed"),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const message =
        errorDisplayMessage(squashAtomCommandFailure(result), resolveMessage) ||
        gt("Failed to run repository monitor dry run.");
      setDryRunError(message);
    }
  };

  const renderEventCard = (event: RepoMonitorEventRecord, keyPrefix: string) => {
    const promptKey = `${keyPrefix}:${event.id}`;
    const isExpanded = expandedPromptIds.includes(promptKey);
    const ruleLabel = ruleNameById.get(event.ruleId) ?? event.ruleId;

    return (
      <div
        key={promptKey}
        className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/50 p-3"
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={outcomeBadgeVariant(event.outcome)} size="sm">
                {outcomeLabel(event.outcome)}
              </Badge>
              <Badge variant="outline" size="sm">
                {event.eventKind}
              </Badge>
              <span className="truncate text-xs text-muted-foreground">{ruleLabel}</span>
            </div>
            <p className="text-sm font-medium text-foreground break-words">{event.summary}</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {event.authorLogin ? (
                <span>
                  {gt("Author")}: {event.authorLogin}
                </span>
              ) : null}
              {event.branch ? (
                <span>
                  {gt("Branch")}: {event.branch}
                </span>
              ) : null}
              <span>{event.occurredAt}</span>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {event.dispatchedThreadId ? (
              onOpenThread ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    onOpenThread({
                      environmentId,
                      threadId: event.dispatchedThreadId!,
                    })
                  }
                >
                  <ExternalLinkIcon />
                  {gt("Open thread")}
                </Button>
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  render={
                    <Link
                      to="/$environmentId/$threadId"
                      params={buildThreadRouteParams(
                        scopeThreadRef(environmentId, event.dispatchedThreadId),
                      )}
                    />
                  }
                >
                  <ExternalLinkIcon />
                  {gt("Open thread")}
                </Button>
              )
            ) : null}

            {event.renderedPrompt ? (
              <Button size="xs" variant="ghost" onClick={() => togglePromptExpanded(promptKey)}>
                {isExpanded ? gt("Hide prompt") : gt("Preview prompt")}
              </Button>
            ) : null}
          </div>
        </div>

        {isExpanded && event.renderedPrompt ? (
          <div className="space-y-1 rounded-md border border-border/60 bg-muted/40 p-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <ShieldCheckIcon className="size-3.5 text-primary" />
              <span>{gt("Sanitized prompt output")}</span>
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
              {event.renderedPrompt}
            </pre>
          </div>
        ) : null}
      </div>
    );
  };

  const events = eventsQuery.data?.events ?? [];
  const selectedFilterValue = selectedRuleId ?? ALL_RULES_VALUE;

  return (
    <div className="space-y-6">
      <div className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <h3 className="text-sm font-semibold text-foreground">{gt("Dry-run evaluation")}</h3>
            <p className="text-xs text-muted-foreground">
              {gt(
                "Simulate matching rules and inspect sanitized prompt framing without dispatching.",
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Label>
              <Switch
                size="sm"
                checked={emitOnInitialCursor}
                onCheckedChange={(checked) => setEmitOnInitialCursor(checked)}
              />
              <span className="text-xs text-muted-foreground">
                {gt("Include baseline snapshot")}
              </span>
            </Label>

            <Button
              size="sm"
              disabled={projectId === null || isDryRunning}
              onClick={() => void handleDryRun()}
            >
              {isDryRunning ? <Spinner className="size-3.5" /> : <PlayIcon />}
              {gt("Run dry run")}
            </Button>
          </div>
        </div>

        {projectId === null ? (
          <p className="text-xs text-muted-foreground">
            {gt("Select a project to execute a dry run.")}
          </p>
        ) : null}

        {dryRunError ? (
          <Alert variant="error">
            <AlertTitle>{gt("Dry run failed")}</AlertTitle>
            <AlertDescription>{dryRunError}</AlertDescription>
          </Alert>
        ) : null}

        {dryRunResults !== null ? (
          <div className="space-y-3 pt-1">
            {dryRunResults.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {gt("No monitor rules matched the selected scope.")}
              </p>
            ) : (
              dryRunResults.map((result) => (
                <div
                  key={result.ruleId}
                  className="space-y-2 rounded-lg border border-border/60 bg-background/60 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {ruleNameById.get(result.ruleId) ?? result.ruleId}
                      </span>
                      <Badge variant="info" size="sm">
                        {gt("{count} matched", { count: result.matchedEvents.length })}
                      </Badge>
                      <Badge variant="secondary" size="sm">
                        {gt("{count} skipped", { count: result.skippedCount })}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">{result.evaluatedAt}</span>
                  </div>

                  {result.matchedEvents.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {gt("No candidate events matched this rule during dry run.")}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {result.matchedEvents.map((event) => renderEventCard(event, "dry"))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>

      <div className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <h3 className="text-sm font-semibold text-foreground">{gt("Trigger history")}</h3>
            <p className="text-xs text-muted-foreground">
              {gt("Recent repository monitor evaluations, skip reasons, and launched threads.")}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onSelectRuleId ? (
              <Select
                value={selectedFilterValue}
                onValueChange={(value) =>
                  onSelectRuleId(
                    value === null || value === ALL_RULES_VALUE
                      ? null
                      : (value as RepoMonitorRuleId),
                  )
                }
              >
                <SelectTrigger size="sm" className="w-48">
                  <SelectValue>
                    {selectedRuleId
                      ? (ruleNameById.get(selectedRuleId) ?? selectedRuleId)
                      : gt("All rules")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={ALL_RULES_VALUE}>{gt("All rules")}</SelectItem>
                  {rules.map((rule) => (
                    <SelectItem key={rule.id} value={rule.id}>
                      {rule.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}

            <Button
              size="sm"
              variant="outline"
              disabled={eventsQuery.isPending}
              onClick={() => eventsQuery.refresh()}
            >
              <RefreshCwIcon />
              {gt("Refresh")}
            </Button>
          </div>
        </div>

        {eventsQuery.error ? (
          <Alert variant="error">
            <AlertTitle>{gt("Could not load event history")}</AlertTitle>
            <AlertDescription>{eventsQuery.error}</AlertDescription>
          </Alert>
        ) : null}

        {eventsQuery.isPending && events.length === 0 ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Spinner className="size-4" />
            <span>{gt("Loading trigger history...")}</span>
          </div>
        ) : events.length === 0 ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShieldCheckIcon />
              </EmptyMedia>
              <EmptyTitle>{gt("No monitor events recorded")}</EmptyTitle>
              <EmptyDescription>
                {gt(
                  "Triggered events and guard skip records will appear here after polling or webhooks.",
                )}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-2">{events.map((event) => renderEventCard(event, "log"))}</div>
        )}
      </div>
    </div>
  );
}

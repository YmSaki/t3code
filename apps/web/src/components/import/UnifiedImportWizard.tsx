import {
  buildSelectiveImportInputs,
  clearImportWorkspaceSelection,
  countScanDiagnostics,
  createEmptyImportSelectionState,
  EXTENDED_IMPORT_SOURCES,
  isAllWorkspacesSelected,
  mergeUnifiedImportResults,
  selectAllImportWorkspaces,
  toggleWorkspaceSelection,
  type AgentSessionImportSelectionState,
  type ImportTimeWindow,
} from "@t3tools/client-runtime/state/agentSessionImport";
import type {
  AgentSessionProjectCandidateExtended,
  EnvironmentId,
  ExtendedAgentSessionSource,
  MetaProjectId,
  UnifiedAgentSessionImportResult,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  FileTextIcon,
  FolderGit2Icon,
  HistoryIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useState } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  useRefreshUnifiedAgentSessionScan,
  useUnifiedAgentSessionImport,
  useUnifiedAgentSessionImportPermission,
  useUnifiedAgentSessionScan,
} from "../../state/agentSessionImport";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ImportDiagnosticsDrawer } from "./ImportDiagnosticsDrawer";

export interface MetaProjectOption {
  readonly id: string;
  readonly title: string;
}

export interface UnifiedImportWizardProps {
  readonly environmentId?: EnvironmentId | null | undefined;
  readonly projectPath?: string | undefined;
  readonly initialMetaProjectId?: MetaProjectId | string | null | undefined;
  readonly availableMetaProjects?: ReadonlyArray<MetaProjectOption> | undefined;
  readonly onImported?:
    | ((result: UnifiedAgentSessionImportResult, targetMetaProjectId: string | null) => void)
    | undefined;
}

function sourceDisplayLabel(
  source: ExtendedAgentSessionSource,
  gt: ReturnType<typeof useGT>,
): string {
  switch (source) {
    case "claudeAgent":
      return gt("Claude Code");
    case "codex":
      return gt("Codex");
    case "pi":
      return gt("Pi");
    case "cursor":
      return gt("Cursor");
    case "opencode":
      return gt("OpenCode");
    case "antigravity":
      return gt("Antigravity");
  }
}

function parseSessionIdsDraft(raw: string): ReadonlyArray<string> {
  return raw
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function UnifiedImportWizard({
  environmentId: controlledEnvironmentId,
  projectPath,
  initialMetaProjectId = null,
  availableMetaProjects = [],
  onImported,
}: UnifiedImportWizardProps) {
  const gt = useGT();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const connectedEnvironments = environments.filter((env) => env.connection.phase === "connected");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    controlledEnvironmentId ?? null,
  );

  const activeEnvironmentId =
    controlledEnvironmentId ??
    selectedEnvironmentId ??
    primaryEnvironmentId ??
    connectedEnvironments[0]?.environmentId ??
    null;

  const [activeSourceTab, setActiveSourceTab] = useState<"all" | ExtendedAgentSessionSource>("all");
  const [timeWindow, setTimeWindow] = useState<ImportTimeWindow>("30d");
  const [sessionIdsDraft, setSessionIdsDraft] = useState("");
  const [selectionState, setSelectionState] = useState<AgentSessionImportSelectionState>(() =>
    createEmptyImportSelectionState(initialMetaProjectId ?? null),
  );
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{
    readonly completed: number;
    readonly total: number;
  } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [lastImportResult, setLastImportResult] = useState<UnifiedAgentSessionImportResult | null>(
    null,
  );
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const activeSources = activeSourceTab === "all" ? undefined : [activeSourceTab];
  const scan = useUnifiedAgentSessionScan(activeEnvironmentId, {
    sources: activeSources,
    timeWindow,
    includeAllTime: timeWindow === "all",
    projectPath,
  });
  const refreshScan = useRefreshUnifiedAgentSessionScan();
  const runImport = useUnifiedAgentSessionImport();
  const canImport = useUnifiedAgentSessionImportPermission(activeEnvironmentId);

  const candidates: ReadonlyArray<AgentSessionProjectCandidateExtended> = scan.candidates;
  const allSelected = isAllWorkspacesSelected(selectionState, candidates);
  const selectedCandidatesCount = candidates.filter((candidate) =>
    selectionState.selectedWorkspaces.includes(candidate.normalizedPath),
  ).length;

  const scanDiagnosticsCount = countScanDiagnostics(scan.data);
  const activeDiagnosticsSummary =
    lastImportResult?.diagnosticsSummary ?? scan.data?.diagnosticsSummary ?? null;
  const totalDiagnosticsCount =
    lastImportResult?.diagnosticsSummary.diagnostics?.length ??
    lastImportResult?.diagnosticsSummary.skippedCount ??
    scanDiagnosticsCount;

  const handleImportSelected = async () => {
    if (activeEnvironmentId === null || selectedCandidatesCount === 0 || isImporting) {
      return;
    }
    const parsedSessionIds = parseSessionIdsDraft(sessionIdsDraft);
    const effectiveState: AgentSessionImportSelectionState = {
      ...selectionState,
      selectedSessionIds: parsedSessionIds,
    };
    const payloads = buildSelectiveImportInputs(effectiveState, candidates, {
      sources: activeSources,
    });
    if (payloads.length === 0) return;

    setIsImporting(true);
    setImportError(null);
    setImportProgress({ completed: 0, total: payloads.length });

    const collectedResults: UnifiedAgentSessionImportResult[] = [];
    let failedDetail: string | null = null;

    for (let idx = 0; idx < payloads.length; idx += 1) {
      const payload = payloads[idx];
      if (!payload) continue;
      const outcome = await runImport({
        environmentId: activeEnvironmentId,
        input: payload,
      });
      if (outcome._tag === "Success") {
        collectedResults.push(outcome.value);
      } else {
        failedDetail = gt("One or more session import requests failed.");
      }
      setImportProgress({ completed: idx + 1, total: payloads.length });
    }

    const merged = mergeUnifiedImportResults(collectedResults);
    if (merged !== null) {
      setLastImportResult(merged);
      onImported?.(merged, selectionState.targetMetaProjectId);
    }
    if (failedDetail !== null) {
      setImportError(failedDetail);
    }
    setIsImporting(false);
    setImportProgress(null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/50 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-semibold text-foreground">
              <T>Unified Local AI Session Importer</T>
            </h3>
            <p className="text-xs text-muted-foreground">
              <T>
                Scan and selectively import threads, context handoff summaries, and project rules
                across Claude Code, Codex, Pi, Cursor, OpenCode, Antigravity, and Kiro-compatible
                rules.
              </T>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {controlledEnvironmentId === undefined && connectedEnvironments.length > 1 ? (
              <Select
                value={activeEnvironmentId}
                onValueChange={(next) => {
                  if (typeof next === "string") {
                    setSelectedEnvironmentId(next as EnvironmentId);
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label={gt("Target environment")}>
                  <SelectValue>
                    {connectedEnvironments.find((env) => env.environmentId === activeEnvironmentId)
                      ?.label ?? gt("Choose environment")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {connectedEnvironments.map((env) => (
                    <SelectItem key={env.environmentId} value={env.environmentId}>
                      {env.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}

            <Button
              variant="outline"
              size="sm"
              disabled={activeEnvironmentId === null || scan.isPending}
              onClick={() => {
                if (activeEnvironmentId !== null) {
                  refreshScan(activeEnvironmentId);
                }
              }}
            >
              <RefreshCwIcon className={scan.isPending ? "animate-spin" : undefined} />
              <T>Rescan</T>
            </Button>

            <Button variant="outline" size="sm" onClick={() => setDiagnosticsOpen(true)}>
              <AlertTriangleIcon />
              <T>Diagnostics</T>
              <Badge variant={totalDiagnosticsCount > 0 ? "warning" : "secondary"} size="sm">
                {totalDiagnosticsCount}
              </Badge>
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-border/60 pt-3 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={gt("AI sources")}>
            <Button
              size="xs"
              variant={activeSourceTab === "all" ? "default" : "outline"}
              onClick={() => setActiveSourceTab("all")}
            >
              <T>All sources</T>
            </Button>
            {EXTENDED_IMPORT_SOURCES.map((source) => (
              <Button
                key={source}
                size="xs"
                variant={activeSourceTab === source ? "default" : "outline"}
                onClick={() => setActiveSourceTab(source)}
              >
                {sourceDisplayLabel(source, gt)}
              </Button>
            ))}
          </div>

          <div className="flex items-center gap-2 self-start md:self-auto">
            <span className="text-xs text-muted-foreground">
              <HistoryIcon className="me-1 inline size-3.5" />
              <T>Window</T>
            </span>
            <ToggleGroup
              value={[timeWindow]}
              onValueChange={(nextValues) => {
                const next = nextValues[0];
                if (next === "30d" || next === "90d" || next === "all") {
                  setTimeWindow(next);
                }
              }}
            >
              <Toggle value="30d">
                <T>30d</T>
              </Toggle>
              <Toggle value="90d">
                <T>90d</T>
              </Toggle>
              <Toggle value="all">
                <T>All Time</T>
              </Toggle>
            </ToggleGroup>
          </div>
        </div>
      </div>

      {scan.error ? (
        <Alert variant="error">
          <AlertTriangleIcon />
          <AlertTitle>
            <T>Scan failed</T>
          </AlertTitle>
          <AlertDescription>{scan.error}</AlertDescription>
        </Alert>
      ) : null}

      {importError ? (
        <Alert variant="error">
          <AlertTriangleIcon />
          <AlertTitle>
            <T>Import incomplete</T>
          </AlertTitle>
          <AlertDescription>{importError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card/40 p-4 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-medium text-muted-foreground">
              <T>
                Detected projects (<Var>{candidates.length}</Var>)
              </T>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="xs"
                disabled={candidates.length === 0}
                onClick={() =>
                  setSelectionState(
                    allSelected
                      ? clearImportWorkspaceSelection(selectionState)
                      : selectAllImportWorkspaces(selectionState, candidates),
                  )
                }
              >
                {allSelected ? gt("Clear selection") : gt("Select all")}
              </Button>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-border/70 bg-background/60">
            <ScrollArea className="max-h-96 min-h-48">
              {scan.isPending && candidates.length === 0 ? (
                <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                  <Spinner />
                  <T>Scanning local AI storage…</T>
                </div>
              ) : candidates.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
                  <FolderGit2Icon className="size-6 opacity-60" />
                  <p>
                    {activeEnvironmentId === null
                      ? gt("Connect to an environment to scan local AI sessions.")
                      : gt("No matching projects found for the current source and time window.")}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-border/70">
                  {candidates.map((candidate) => {
                    const checked = selectionState.selectedWorkspaces.includes(
                      candidate.normalizedPath,
                    );
                    return (
                      <label
                        key={candidate.normalizedPath}
                        className="flex min-h-11 cursor-pointer items-start gap-3 p-3 transition-colors hover:bg-accent/40"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() =>
                            setSelectionState(
                              toggleWorkspaceSelection(selectionState, candidate.normalizedPath),
                            )
                          }
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              {candidate.title}
                            </span>
                            {candidate.alreadyImported ? (
                              <Badge variant="success" size="sm">
                                <T>Imported</T>
                              </Badge>
                            ) : null}
                            <Badge variant="secondary" size="sm">
                              <T>
                                <Var>{candidate.threadCount}</Var> threads
                              </T>
                            </Badge>
                            {candidate.ruleFileCount !== undefined &&
                            candidate.ruleFileCount > 0 ? (
                              <Badge variant="info" size="sm">
                                <T>
                                  <Var>{candidate.ruleFileCount}</Var> rule files
                                </T>
                              </Badge>
                            ) : null}
                          </div>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            {candidate.path}
                          </p>
                          <div className="flex flex-wrap items-center gap-1">
                            {candidate.sources.map((source) => (
                              <Badge key={source} variant="outline" size="sm">
                                {sourceDisplayLabel(source, gt)}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-card/40 p-4">
          <div className="space-y-1">
            <h4 className="text-sm font-semibold text-foreground">
              <T>Import options</T>
            </h4>
            <p className="text-xs text-muted-foreground">
              <T>Choose rules, handoff generation, and optional MetaProject target.</T>
            </p>
          </div>

          <div className="space-y-3 text-sm">
            <label className="flex min-h-11 cursor-pointer items-start gap-2.5">
              <Checkbox
                checked={selectionState.includeRules}
                onCheckedChange={(next) =>
                  setSelectionState({ ...selectionState, includeRules: Boolean(next) })
                }
                className="mt-0.5"
              />
              <span className="space-y-0.5">
                <span className="block text-xs font-medium text-foreground">
                  <T>Merge project rules &amp; skills</T>
                </span>
                <span className="block text-xs text-muted-foreground">
                  <T>AGENTS.md, CLAUDE.md, .cursor/rules/*.mdc, .gemini/*</T>
                </span>
              </span>
            </label>

            <label className="flex min-h-11 cursor-pointer items-start gap-2.5">
              <Checkbox
                checked={selectionState.generateHandoff}
                onCheckedChange={(next) =>
                  setSelectionState({ ...selectionState, generateHandoff: Boolean(next) })
                }
                className="mt-0.5"
              />
              <span className="space-y-0.5">
                <span className="block text-xs font-medium text-foreground">
                  <T>Generate context handoff summary</T>
                </span>
                <span className="block text-xs text-muted-foreground">
                  <T>Summarize goals and latest outcomes per thread.</T>
                </span>
              </span>
            </label>

            <label className="flex min-h-11 cursor-pointer items-start gap-2.5">
              <Checkbox
                checked={selectionState.forceReimport}
                onCheckedChange={(next) =>
                  setSelectionState({ ...selectionState, forceReimport: Boolean(next) })
                }
                className="mt-0.5"
              />
              <span className="space-y-0.5">
                <span className="block text-xs font-medium text-foreground">
                  <T>Allow re-import without duplicates</T>
                </span>
                <span className="block text-xs text-muted-foreground">
                  <T>Re-run selected sessions while deduplicating inside the batch.</T>
                </span>
              </span>
            </label>

            {availableMetaProjects.length > 0 ? (
              <div className="space-y-1.5">
                <span className="block text-xs font-medium text-foreground">
                  <T>Target MetaProject (optional)</T>
                </span>
                <Select
                  value={selectionState.targetMetaProjectId ?? "__none__"}
                  onValueChange={(next) =>
                    setSelectionState({
                      ...selectionState,
                      targetMetaProjectId:
                        typeof next === "string" && next !== "__none__" ? next : null,
                    })
                  }
                >
                  <SelectTrigger size="sm" aria-label={gt("Target MetaProject")}>
                    <SelectValue>
                      {availableMetaProjects.find(
                        (mp) => mp.id === selectionState.targetMetaProjectId,
                      )?.title ?? gt("Standalone (no MetaProject)")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value="__none__">
                      <T>Standalone (no MetaProject)</T>
                    </SelectItem>
                    {availableMetaProjects.map((mp) => (
                      <SelectItem key={mp.id} value={mp.id}>
                        {mp.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-foreground">
                <T>Specific session IDs (optional)</T>
              </span>
              <Input
                value={sessionIdsDraft}
                onChange={(event) => setSessionIdsDraft(event.target.value)}
                placeholder={gt("Comma-separated IDs or leave blank for all")}
                aria-label={gt("Specific session IDs")}
              />
            </div>
          </div>

          <Button
            className="w-full"
            disabled={
              activeEnvironmentId === null ||
              selectedCandidatesCount === 0 ||
              isImporting ||
              !canImport
            }
            onClick={() => void handleImportSelected()}
          >
            {isImporting ? <Spinner /> : <DownloadIcon />}
            {isImporting && importProgress ? (
              <T>
                Importing (<Var>{importProgress.completed}</Var>/<Var>{importProgress.total}</Var>)…
              </T>
            ) : (
              <T>
                Import selected (<Var>{selectedCandidatesCount}</Var>)
              </T>
            )}
          </Button>
          {!canImport && activeEnvironmentId !== null ? (
            <p className="text-xs text-muted-foreground">
              <T>Orchestration operate permission is required to import sessions.</T>
            </p>
          ) : null}
        </div>
      </div>

      {lastImportResult ? (
        <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <CheckCircle2Icon className="size-4 text-primary" />
              <T>Import summary</T>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="success" size="sm">
                <T>
                  <Var>{lastImportResult.importedCount}</Var> imported
                </T>
              </Badge>
              <Badge variant="secondary" size="sm">
                <T>
                  <Var>{lastImportResult.duplicateCount}</Var> deduplicated
                </T>
              </Badge>
              <Badge variant="warning" size="sm">
                <T>
                  <Var>{lastImportResult.skippedCount}</Var> skipped
                </T>
              </Badge>
            </div>
          </div>

          {lastImportResult.threads.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                <T>Restored threads</T>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {lastImportResult.threads.slice(0, 8).map((thread) => (
                  <div
                    key={`${thread.source}:${thread.sessionId}`}
                    className="rounded-lg border border-border/70 bg-background/60 p-2.5 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-foreground">{thread.title}</span>
                      <Badge variant="outline" size="sm">
                        {sourceDisplayLabel(thread.source, gt)}
                      </Badge>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-muted-foreground">
                      <span>
                        <T>
                          <Var>{thread.messageCount}</Var> messages
                        </T>
                      </span>
                      {thread.model ? <span className="truncate">{thread.model}</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {lastImportResult.instructionsMd ? (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <FileTextIcon className="size-3.5" />
                <T>Merged project instructions candidate</T>
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-border/70 bg-background/60 p-3 font-mono text-xs text-foreground">
                {lastImportResult.instructionsMd}
              </pre>
            </div>
          ) : null}

          {lastImportResult.handoffMarkdown ? (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <FileTextIcon className="size-3.5" />
                <T>Context handoff markdown</T>
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-border/70 bg-background/60 p-3 font-mono text-xs text-foreground">
                {lastImportResult.handoffMarkdown}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}

      <ImportDiagnosticsDrawer
        open={diagnosticsOpen}
        onOpenChange={setDiagnosticsOpen}
        summary={activeDiagnosticsSummary}
      />
    </div>
  );
}

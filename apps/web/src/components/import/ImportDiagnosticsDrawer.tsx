import type {
  AgentSessionImportDiagnostic,
  AgentSessionImportDiagnosticsSummary,
  ExtendedAgentSessionSource,
} from "@t3tools/contracts";
import { EXTENDED_IMPORT_SOURCES } from "@t3tools/client-runtime/state/agentSessionImport";
import { T, useGT, Var } from "gt-react";
import { AlertTriangleIcon, FileWarningIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";

export interface ImportDiagnosticsDrawerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly summary: AgentSessionImportDiagnosticsSummary | null;
  readonly title?: string | undefined;
}

function sourceBadgeLabel(
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

export function ImportDiagnosticsDrawer({
  open,
  onOpenChange,
  summary,
  title,
}: ImportDiagnosticsDrawerProps) {
  const gt = useGT();
  const [sourceFilter, setSourceFilter] = useState<"all" | ExtendedAgentSessionSource>("all");
  const [reasonFilter, setReasonFilter] = useState<string>("all");

  const allDiagnostics: ReadonlyArray<AgentSessionImportDiagnostic> = summary?.diagnostics ?? [];
  const filteredDiagnostics = allDiagnostics.filter((item) => {
    if (sourceFilter !== "all" && item.source !== sourceFilter) return false;
    if (reasonFilter !== "all" && item.reason !== reasonFilter) return false;
    return true;
  });

  const seenDiagnosticKeys = new Map<string, number>();
  const keyedDiagnostics = filteredDiagnostics.map((item) => {
    const baseKey = `${item.source}:${item.scope}:${item.reason}:${item.filePath ?? ""}:${item.line ?? ""}:${item.detail ?? ""}`;
    const occurrence = (seenDiagnosticKeys.get(baseKey) ?? 0) + 1;
    seenDiagnosticKeys.set(baseKey, occurrence);
    return {
      key: `${baseKey}#${occurrence}`,
      item,
    };
  });

  const byReason = summary?.byReason ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="w-full max-w-xl">
        <div className="border-b border-border pb-2">
          <SheetHeader>
            <SheetTitle>
              <span className="flex items-center gap-2 text-base font-semibold">
                <AlertTriangleIcon className="size-4 text-muted-foreground" />
                <span>{title ?? gt("Import diagnostics")}</span>
              </span>
            </SheetTitle>
            <SheetDescription>
              {gt(
                "Inspect records skipped due to malformed JSON, unsupported roles, empty content, permission errors, or duplicates.",
              )}
            </SheetDescription>
          </SheetHeader>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-6">
          {summary ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="text-xs text-muted-foreground">
                  <T>Processed</T>
                </div>
                <div className="mt-1 text-lg font-semibold text-foreground">
                  {summary.totalRecords}
                </div>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="text-xs text-muted-foreground">
                  <T>Imported</T>
                </div>
                <div className="mt-1 text-lg font-semibold text-foreground">
                  {summary.importedCount}
                </div>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="text-xs text-muted-foreground">
                  <T>Skipped</T>
                </div>
                <div className="mt-1 text-lg font-semibold text-foreground">
                  {summary.skippedCount}
                </div>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="text-xs text-muted-foreground">
                  <T>Repaired times</T>
                </div>
                <div className="mt-1 text-lg font-semibold text-foreground">
                  {summary.repairedTimestampCount}
                </div>
              </div>
            </div>
          ) : null}

          {byReason.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                <T>Filter by skip reason</T>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="xs"
                  variant={reasonFilter === "all" ? "default" : "outline"}
                  onClick={() => setReasonFilter("all")}
                >
                  {gt("All reasons")}
                </Button>
                {byReason.map((entry) => (
                  <Button
                    key={entry.reason}
                    size="xs"
                    variant={reasonFilter === entry.reason ? "default" : "outline"}
                    onClick={() =>
                      setReasonFilter(reasonFilter === entry.reason ? "all" : entry.reason)
                    }
                  >
                    <span>{entry.reason}</span>
                    <Badge variant="secondary" size="sm">
                      {entry.count}
                    </Badge>
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              <T>Filter by source</T>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="xs"
                variant={sourceFilter === "all" ? "default" : "outline"}
                onClick={() => setSourceFilter("all")}
              >
                {gt("All sources")}
              </Button>
              {EXTENDED_IMPORT_SOURCES.map((source) => (
                <Button
                  key={source}
                  size="xs"
                  variant={sourceFilter === source ? "default" : "outline"}
                  onClick={() => setSourceFilter(sourceFilter === source ? "all" : source)}
                >
                  {sourceBadgeLabel(source, gt)}
                </Button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-card/40">
            <ScrollArea className="h-full">
              {keyedDiagnostics.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
                  <FileWarningIcon className="size-6 opacity-60" />
                  <p>
                    {allDiagnostics.length === 0
                      ? gt("No skipped records or warnings were reported.")
                      : gt("No diagnostics match the selected filters.")}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {keyedDiagnostics.map(({ key, item }) => (
                    <div key={key} className="space-y-1.5 p-3 text-xs">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" size="sm">
                          {sourceBadgeLabel(item.source, gt)}
                        </Badge>
                        <Badge variant="warning" size="sm">
                          {item.reason}
                        </Badge>
                        <Badge variant="secondary" size="sm">
                          {item.scope}
                        </Badge>
                        {item.line !== undefined && item.line !== null ? (
                          <span className="text-muted-foreground">
                            <T>
                              Line <Var>{item.line}</Var>
                            </T>
                          </span>
                        ) : null}
                      </div>
                      {item.detail ? (
                        <p className="break-words text-foreground">{item.detail}</p>
                      ) : null}
                      {item.filePath ? (
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {item.filePath}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        </div>
      </SheetPopup>
    </Sheet>
  );
}

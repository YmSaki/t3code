import {
  type AgentSessionImportDiagnostic,
  type AgentSessionImportDiagnosticsSummary,
  type AgentSessionProjectCandidateExtended,
  type AgentSessionSelectiveImportInput,
  type EnvironmentId,
  type ExtendedAgentSessionSource,
  type ImportedSessionThreadSummary,
  type UnifiedAgentSessionImportResult,
  type UnifiedAgentSessionScanResult,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  buildImportDiagnosticSummary,
  isSameImportDirectory,
} from "@t3tools/shared/importNormalizer.core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export const EXTENDED_IMPORT_SOURCES: ReadonlyArray<ExtendedAgentSessionSource> = [
  "claudeAgent",
  "codex",
  "pi",
  "cursor",
  "opencode",
  "antigravity",
];

export type ImportTimeWindow = "30d" | "90d" | "all";

export interface AgentSessionScanFilterOptions {
  readonly sources?: ReadonlyArray<ExtendedAgentSessionSource> | undefined;
  readonly timeWindow?: ImportTimeWindow | undefined;
  readonly includeAllTime?: boolean | undefined;
  readonly projectPath?: string | undefined;
  readonly nowMs?: number | undefined;
}

export interface AgentSessionImportSelectionState {
  readonly selectedWorkspaces: ReadonlyArray<string>;
  readonly selectedSessionIds: ReadonlyArray<string>;
  readonly includeRules: boolean;
  readonly generateHandoff: boolean;
  readonly forceReimport: boolean;
  readonly targetMetaProjectId: string | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function createAgentSessionImportEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scanRefreshSignals = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));

  const scanAll = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:agent-sessions:scan-all",
    tag: WS_METHODS.agentSessionsScanAll,
    staleTimeMs: 30_000,
    idleTtlMs: 5 * 60_000,
    refreshTrigger: ({ environmentId }) => scanRefreshSignals(environmentId),
  });

  const refreshScan = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
    Effect.sync(() => {
      registry.update(scanRefreshSignals(environmentId), (count) => count + 1);
    });

  const importSelected = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:agent-sessions:import-selected",
    tag: WS_METHODS.agentSessionsImportSelected,
    onSuccess: ({ environmentId }, registry) => refreshScan(registry, environmentId),
  });

  return {
    scanAll,
    importSelected,
    refreshScan,
  };
}

export function toScanAllRpcInput(options?: {
  readonly sources?: ReadonlyArray<ExtendedAgentSessionSource> | undefined;
}): { readonly sources?: ExtendedAgentSessionSource[] } {
  if (options?.sources === undefined || options.sources.length === 0) {
    return {};
  }
  return { sources: [...options.sources] };
}

function parseIsoEpochMs(iso: string | null): number | null {
  if (iso === null) return null;
  const parsed = DateTime.make(iso);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null;
}

function resolveTimeWindowCutoffMs(
  options: Pick<AgentSessionScanFilterOptions, "timeWindow" | "includeAllTime" | "nowMs">,
): number | null {
  if (options.includeAllTime === true || options.timeWindow === "all") {
    return null;
  }
  if (options.nowMs === undefined || !Number.isFinite(options.nowMs)) {
    return null;
  }
  const days = options.timeWindow === "90d" ? 90 : 30;
  return options.nowMs - days * MS_PER_DAY;
}

export function filterImportProjectCandidates(
  candidates: ReadonlyArray<AgentSessionProjectCandidateExtended>,
  options: AgentSessionScanFilterOptions = {},
): ReadonlyArray<AgentSessionProjectCandidateExtended> {
  const sourceFilter =
    options.sources !== undefined && options.sources.length > 0 ? new Set(options.sources) : null;
  const cutoffMs = resolveTimeWindowCutoffMs(options);
  const projectPathFilter =
    options.projectPath !== undefined && options.projectPath.trim().length > 0
      ? options.projectPath.trim()
      : null;

  return candidates.filter((candidate) => {
    if (sourceFilter !== null && !candidate.sources.some((source) => sourceFilter.has(source))) {
      return false;
    }
    if (projectPathFilter !== null) {
      const sameDir =
        isSameImportDirectory(candidate.path, projectPathFilter) ||
        isSameImportDirectory(candidate.normalizedPath, projectPathFilter);
      if (!sameDir) return false;
    }
    if (cutoffMs !== null) {
      const activeMs = parseIsoEpochMs(candidate.lastActiveAt);
      if (activeMs !== null && activeMs < cutoffMs) {
        return false;
      }
    }
    return true;
  });
}

export function createEmptyImportSelectionState(
  initialMetaProjectId: string | null = null,
): AgentSessionImportSelectionState {
  return {
    selectedWorkspaces: [],
    selectedSessionIds: [],
    includeRules: true,
    generateHandoff: true,
    forceReimport: false,
    targetMetaProjectId: initialMetaProjectId,
  };
}

export function toggleWorkspaceSelection(
  state: AgentSessionImportSelectionState,
  normalizedPath: string,
): AgentSessionImportSelectionState {
  const exists = state.selectedWorkspaces.includes(normalizedPath);
  const nextWorkspaces = exists
    ? state.selectedWorkspaces.filter((item) => item !== normalizedPath)
    : [...state.selectedWorkspaces, normalizedPath];
  return {
    ...state,
    selectedWorkspaces: nextWorkspaces,
  };
}

export function selectAllImportWorkspaces(
  state: AgentSessionImportSelectionState,
  candidates: ReadonlyArray<AgentSessionProjectCandidateExtended>,
): AgentSessionImportSelectionState {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.normalizedPath)) continue;
    seen.add(candidate.normalizedPath);
    next.push(candidate.normalizedPath);
  }
  return {
    ...state,
    selectedWorkspaces: next,
  };
}

export function clearImportWorkspaceSelection(
  state: AgentSessionImportSelectionState,
): AgentSessionImportSelectionState {
  return {
    ...state,
    selectedWorkspaces: [],
  };
}

export function isAllWorkspacesSelected(
  state: AgentSessionImportSelectionState,
  candidates: ReadonlyArray<AgentSessionProjectCandidateExtended>,
): boolean {
  if (candidates.length === 0) return false;
  const selected = new Set(state.selectedWorkspaces);
  return candidates.every((candidate) => selected.has(candidate.normalizedPath));
}

export function toggleSessionSelection(
  state: AgentSessionImportSelectionState,
  sessionId: string,
): AgentSessionImportSelectionState {
  const exists = state.selectedSessionIds.includes(sessionId);
  return {
    ...state,
    selectedSessionIds: exists
      ? state.selectedSessionIds.filter((id) => id !== sessionId)
      : [...state.selectedSessionIds, sessionId],
  };
}

export function selectAllSessionIds(
  state: AgentSessionImportSelectionState,
  sessionIds: ReadonlyArray<string>,
): AgentSessionImportSelectionState {
  return {
    ...state,
    selectedSessionIds: [...new Set(sessionIds)],
  };
}

export function buildSelectiveImportInputs(
  state: AgentSessionImportSelectionState,
  candidates: ReadonlyArray<AgentSessionProjectCandidateExtended>,
  options?: {
    readonly sources?: ReadonlyArray<ExtendedAgentSessionSource> | undefined;
  },
): ReadonlyArray<AgentSessionSelectiveImportInput> {
  const selectedSet = new Set(state.selectedWorkspaces);
  const activeSources =
    options?.sources !== undefined && options.sources.length > 0 ? [...options.sources] : undefined;
  const sessionIds =
    state.selectedSessionIds.length > 0 ? [...state.selectedSessionIds] : undefined;

  return candidates
    .filter((candidate) => selectedSet.has(candidate.normalizedPath))
    .map((candidate): AgentSessionSelectiveImportInput => {
      return {
        ...(candidate.projectId !== undefined ? { projectId: candidate.projectId } : {}),
        workspaceRoot: candidate.path,
        ...(activeSources !== undefined ? { sources: activeSources } : {}),
        ...(sessionIds !== undefined ? { sessionIds } : {}),
        includeRules: state.includeRules,
        generateHandoff: state.generateHandoff,
        forceReimport: state.forceReimport,
      };
    });
}

function mergeDiagnosticsSummaries(
  summaries: ReadonlyArray<AgentSessionImportDiagnosticsSummary>,
): AgentSessionImportDiagnosticsSummary {
  const allDiagnostics: AgentSessionImportDiagnostic[] = [];
  let totalRecords = 0;
  let importedCount = 0;
  let repairedTimestampCount = 0;
  const reasonCounts = new Map<string, number>();

  for (const summary of summaries) {
    totalRecords += summary.totalRecords;
    importedCount += summary.importedCount;
    repairedTimestampCount += summary.repairedTimestampCount;
    for (const entry of summary.byReason) {
      reasonCounts.set(entry.reason, (reasonCounts.get(entry.reason) ?? 0) + entry.count);
    }
    if (summary.diagnostics !== undefined) {
      allDiagnostics.push(...summary.diagnostics);
    }
  }

  if (allDiagnostics.length > 0) {
    const core = buildImportDiagnosticSummary({
      totalRecords,
      importedCount,
      skippedReasons: allDiagnostics.map((d) => d.reason),
      repairedTimestampCount,
    });
    return {
      totalRecords: core.totalRecords,
      importedCount: core.importedCount,
      skippedCount: core.skippedCount,
      repairedTimestampCount: core.repairedTimestampCount,
      byReason: core.byReason.map((item) => ({ reason: item.reason, count: item.count })),
      diagnostics: allDiagnostics,
    };
  }

  const byReason = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  return {
    totalRecords,
    importedCount,
    skippedCount: byReason.reduce((sum, item) => sum + item.count, 0),
    repairedTimestampCount,
    byReason,
    diagnostics: [],
  };
}

export function mergeUnifiedImportResults(
  results: ReadonlyArray<UnifiedAgentSessionImportResult>,
): UnifiedAgentSessionImportResult | null {
  if (results.length === 0) return null;
  if (results.length === 1) {
    return results[0] ?? null;
  }

  const threads: ImportedSessionThreadSummary[] = [];
  const instructionsChunks: string[] = [];
  const handoffChunks: string[] = [];
  let importedCount = 0;
  let skippedCount = 0;
  let duplicateCount = 0;

  for (const result of results) {
    importedCount += result.importedCount;
    skippedCount += result.skippedCount;
    duplicateCount += result.duplicateCount;
    threads.push(...result.threads);
    if (result.instructionsMd !== null && result.instructionsMd.trim().length > 0) {
      instructionsChunks.push(result.instructionsMd.trim());
    }
    if (result.handoffMarkdown !== null && result.handoffMarkdown.trim().length > 0) {
      handoffChunks.push(result.handoffMarkdown.trim());
    }
  }

  return {
    workspaceRoot: results[0]?.workspaceRoot ?? ".",
    importedCount,
    skippedCount,
    duplicateCount,
    threads,
    instructionsMd: instructionsChunks.length > 0 ? instructionsChunks.join("\n\n---\n\n") : null,
    handoffMarkdown: handoffChunks.length > 0 ? handoffChunks.join("\n\n---\n\n") : null,
    diagnosticsSummary: mergeDiagnosticsSummaries(
      results.map((result) => result.diagnosticsSummary),
    ),
  };
}

export function countScanDiagnostics(scan: UnifiedAgentSessionScanResult | null): number {
  if (scan === null) return 0;
  return scan.diagnosticsSummary.diagnostics?.length ?? scan.diagnosticsSummary.skippedCount;
}

import {
  UnifiedAgentSessionError,
  type AgentSessionImportDiagnostic,
  type AgentSessionImportDiagnosticsSummary,
  type AgentSessionProjectCandidateExtended,
  type AgentSessionSelectiveImportInput,
  type ExtendedAgentSessionSource,
  type ImportedSessionThreadSummary,
  type ThreadId,
  type UnifiedAgentSessionImportResult,
  type UnifiedAgentSessionScanResult,
} from "@t3tools/contracts";
import {
  buildImportDiagnosticSummary,
  importPathComparisonKey,
  isSameImportDirectory,
} from "@t3tools/shared/importNormalizer.core";
import { fileDisplayName } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  ExtendedAgentSessionScanner,
  type ExtendedScannerRoots,
  type ScannedUnifiedThread,
} from "./ExtendedAgentSessionScanner.ts";
import { UnifiedImportThreadPersister } from "./UnifiedImportThreadPersister.ts";

// The wire summary has no threadId yet; callers in-process get the persisted one.
export interface UnifiedImportedThreadSummary extends ImportedSessionThreadSummary {
  readonly threadId: ThreadId;
}

export interface UnifiedImportSelectedResult extends UnifiedAgentSessionImportResult {
  readonly threads: ReadonlyArray<UnifiedImportedThreadSummary>;
}

export interface UnifiedScanOptions {
  readonly roots?: ExtendedScannerRoots | undefined;
  readonly sources?: ReadonlyArray<ExtendedAgentSessionSource> | undefined;
}

export interface UnifiedImportOptions {
  readonly roots?: ExtendedScannerRoots | undefined;
}

export class UnifiedImportService extends Context.Service<
  UnifiedImportService,
  {
    readonly scanAll: (
      options?: UnifiedScanOptions | undefined,
    ) => Effect.Effect<UnifiedAgentSessionScanResult, UnifiedAgentSessionError>;
    readonly importSelected: (
      input: AgentSessionSelectiveImportInput,
      options?: UnifiedImportOptions | undefined,
    ) => Effect.Effect<UnifiedImportSelectedResult, UnifiedAgentSessionError>;
    readonly summarizeDiagnostics: (input: {
      readonly totalRecords: number;
      readonly importedCount: number;
      readonly repairedTimestampCount?: number | undefined;
      readonly diagnostics: ReadonlyArray<AgentSessionImportDiagnostic>;
    }) => AgentSessionImportDiagnosticsSummary;
  }
>()("t3/project/importers/UnifiedImportService") {}

const SOURCE_ORDER: ReadonlyArray<ExtendedAgentSessionSource> = [
  "claudeAgent",
  "codex",
  "pi",
  "cursor",
  "opencode",
  "antigravity",
];

function epochMsFromIso(iso: string): number {
  const parsed = DateTime.make(iso);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : 0;
}

function truncateLine(text: string, maxChars = 140): string {
  const oneLine = text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, maxChars - 1)}…`;
}

function buildThreadHandoffSummary(thread: ScannedUnifiedThread): string {
  const firstUser = thread.messages.find((m) => m.role === "user");
  const lastUser = [...thread.messages].reverse().find((m) => m.role === "user");
  const lastAssistant = [...thread.messages].reverse().find((m) => m.role === "assistant");

  const modelSuffix = thread.model !== null ? ` (${thread.model})` : "";
  const lines: string[] = [
    `### [${thread.source}] ${thread.title}${modelSuffix}`,
    `- Session ID: \`${thread.sessionId}\``,
  ];
  if (firstUser !== undefined) {
    lines.push(`- Initial goal: ${truncateLine(firstUser.text)}`);
  }
  if (lastUser !== undefined && lastUser !== firstUser) {
    lines.push(`- Latest request: ${truncateLine(lastUser.text)}`);
  }
  if (lastAssistant !== undefined) {
    lines.push(`- Latest outcome: ${truncateLine(lastAssistant.text)}`);
  }
  return lines.join("\n");
}

function buildWorkspaceHandoffMarkdown(
  workspaceRoot: string,
  summaries: ReadonlyArray<{ readonly thread: ScannedUnifiedThread; readonly summary: string }>,
): string | null {
  if (summaries.length === 0) return null;
  const header = `# Context Handoff: ${fileDisplayName(workspaceRoot) || workspaceRoot}`;
  const blocks = summaries.map((entry) => entry.summary);
  return [header, ...blocks].join("\n\n");
}

function threadIdentityKey(thread: {
  readonly source: ExtendedAgentSessionSource;
  readonly sessionId: string;
}): string {
  return `${thread.source}:${thread.sessionId}`;
}

function threadContentFingerprint(thread: ScannedUnifiedThread): string {
  const firstMsg = thread.messages[0];
  const lastMsg = thread.messages.at(-1);
  return [
    thread.normalizedWorkspacePath,
    thread.source,
    firstMsg ? `${firstMsg.role}:${firstMsg.text}` : "",
    lastMsg ? `${lastMsg.role}:${lastMsg.text}` : "",
    String(thread.messages.length),
  ].join("\u0000");
}

const MAX_REPORTED_DIAGNOSTICS = 200;

function buildDiagnosticsSummary(input: {
  readonly totalRecords: number;
  readonly importedCount: number;
  readonly repairedTimestampCount?: number | undefined;
  readonly diagnostics: ReadonlyArray<AgentSessionImportDiagnostic>;
}): AgentSessionImportDiagnosticsSummary {
  const coreSummary = buildImportDiagnosticSummary({
    totalRecords: input.totalRecords,
    importedCount: input.importedCount,
    skippedReasons: input.diagnostics.map((d) => d.reason),
    ...(input.repairedTimestampCount !== undefined
      ? { repairedTimestampCount: input.repairedTimestampCount }
      : {}),
  });
  return {
    totalRecords: coreSummary.totalRecords,
    importedCount: coreSummary.importedCount,
    skippedCount: coreSummary.skippedCount,
    repairedTimestampCount: coreSummary.repairedTimestampCount,
    byReason: coreSummary.byReason.map((item) => ({
      reason: item.reason,
      count: item.count,
    })),
    // A real agent home yields hundreds of thousands of skipped lines; `byReason` keeps the totals.
    diagnostics: input.diagnostics.slice(0, MAX_REPORTED_DIAGNOSTICS),
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const scanner = yield* ExtendedAgentSessionScanner;
  const persister = Option.getOrUndefined(
    yield* Effect.serviceOption(UnifiedImportThreadPersister),
  );

  const summarizeDiagnostics: UnifiedImportService["Service"]["summarizeDiagnostics"] = (input) =>
    buildDiagnosticsSummary(input);

  const scanAll: UnifiedImportService["Service"]["scanAll"] = Effect.fn(
    "UnifiedImportService.scanAll",
  )(function* (options) {
    const scannedAt = DateTime.formatIso(yield* DateTime.now);
    const scanOutput = yield* scanner.scanSessions({
      roots: options?.roots,
      sources: options?.sources,
    });

    interface CandidateAccumulator {
      workspacePath: string;
      normalizedPath: string;
      sources: Set<ExtendedAgentSessionSource>;
      threads: ScannedUnifiedThread[];
      seenThreadKeys: Set<string>;
      lastActiveAtMs: number | null;
      lastActiveAt: string | null;
    }

    const groups: CandidateAccumulator[] = [];

    for (const thread of scanOutput.threads) {
      let group = groups.find((candidate) =>
        isSameImportDirectory(candidate.workspacePath, thread.workspacePath),
      );
      if (group === undefined) {
        group = {
          workspacePath: thread.workspacePath,
          normalizedPath:
            thread.normalizedWorkspacePath.length > 0
              ? thread.normalizedWorkspacePath
              : importPathComparisonKey(thread.workspacePath),
          sources: new Set(),
          threads: [],
          seenThreadKeys: new Set(),
          lastActiveAtMs: null,
          lastActiveAt: null,
        };
        groups.push(group);
      }

      const idKey = threadIdentityKey(thread);
      if (group.seenThreadKeys.has(idKey)) continue;
      group.seenThreadKeys.add(idKey);
      group.sources.add(thread.source);
      group.threads.push(thread);

      const updatedMs = epochMsFromIso(thread.updatedAt);
      if (group.lastActiveAtMs === null || updatedMs > group.lastActiveAtMs) {
        group.lastActiveAtMs = updatedMs;
        group.lastActiveAt = thread.updatedAt;
      }
    }

    const candidates: AgentSessionProjectCandidateExtended[] = [];

    for (const group of groups.sort((a, b) => (b.lastActiveAtMs ?? 0) - (a.lastActiveAtMs ?? 0))) {
      const rulesScan = yield* scanner.scanProjectRules(group.workspacePath);
      const orderedSources = SOURCE_ORDER.filter((source) => group.sources.has(source));
      const messageCount = group.threads.reduce((sum, thread) => sum + thread.messages.length, 0);
      const alreadyImported =
        persister !== undefined &&
        group.threads.length > 0 &&
        (yield* Effect.forEach(group.threads, persister.findImportedThreadId)).every(
          (threadId) => threadId !== null,
        );
      const displayTitle = fileDisplayName(group.workspacePath).trim();

      candidates.push({
        path: group.workspacePath,
        normalizedPath: group.normalizedPath,
        title: displayTitle.length > 0 ? displayTitle : group.workspacePath,
        sources: orderedSources,
        threadCount: group.threads.length,
        messageCount,
        ruleFileCount: rulesScan.result.rules.length,
        lastActiveAt: group.lastActiveAt,
        alreadyImported,
      });
    }

    const diagnosticsSummary = buildDiagnosticsSummary({
      totalRecords: scanOutput.totalRecordsProcessed + scanOutput.diagnostics.length,
      importedCount: scanOutput.threads.length,
      repairedTimestampCount: scanOutput.repairedTimestampCount,
      diagnostics: scanOutput.diagnostics,
    });

    return {
      candidates,
      scannedAt,
      diagnosticsSummary,
    };
  });

  const importSelected: UnifiedImportService["Service"]["importSelected"] = Effect.fn(
    "UnifiedImportService.importSelected",
  )(function* (input, options) {
    if (persister === undefined) {
      return yield* new UnifiedAgentSessionError({
        operation: "import",
        detail: "No thread persister is configured, so imported sessions cannot be saved.",
      });
    }
    const target = yield* persister.resolveTarget({
      projectId: input.projectId,
      workspaceRoot: input.workspaceRoot,
    });
    const scanOutput = yield* scanner.scanSessions({
      roots: options?.roots,
      workspaceRoot: input.workspaceRoot,
      sources: input.sources,
    });

    const diagnostics: AgentSessionImportDiagnostic[] = [...scanOutput.diagnostics];
    const selectedSessionIds = input.sessionIds !== undefined ? new Set(input.sessionIds) : null;
    const generateHandoff = input.generateHandoff ?? true;
    const includeRules = input.includeRules ?? true;
    const forceReimport = input.forceReimport ?? false;

    const batchSeenKeys = new Set<string>();
    const batchSeenFingerprints = new Set<string>();
    const importedSummaries: UnifiedImportedThreadSummary[] = [];
    const handoffEntries: Array<{
      readonly thread: ScannedUnifiedThread;
      readonly summary: string;
    }> = [];

    let skippedCount = 0;
    let duplicateCount = 0;

    const orderedThreads = [...scanOutput.threads].sort(
      (a, b) =>
        epochMsFromIso(a.createdAt) - epochMsFromIso(b.createdAt) ||
        a.sessionId.localeCompare(b.sessionId),
    );

    for (const thread of orderedThreads) {
      if (selectedSessionIds !== null && !selectedSessionIds.has(thread.sessionId)) {
        skippedCount += 1;
        continue;
      }

      const idKey = threadIdentityKey(thread);
      const fingerprint = threadContentFingerprint(thread);

      const isBatchDuplicate = batchSeenKeys.has(idKey) || batchSeenFingerprints.has(fingerprint);
      batchSeenKeys.add(idKey);
      batchSeenFingerprints.add(fingerprint);
      const isPreviouslyImported =
        !isBatchDuplicate &&
        !forceReimport &&
        (yield* persister.findImportedThreadId(thread)) !== null;

      if (isBatchDuplicate || isPreviouslyImported) {
        duplicateCount += 1;
        skippedCount += 1;
        diagnostics.push({
          source: thread.source,
          scope: "session",
          reason: "duplicate_session",
          detail: `Skipped duplicate session ${thread.sessionId} from ${thread.source}`,
          filePath: thread.filePath,
        });
        continue;
      }

      const handoffSummary = generateHandoff ? buildThreadHandoffSummary(thread) : null;
      if (handoffSummary !== null) {
        handoffEntries.push({ thread, summary: handoffSummary });
      }
      const threadId = yield* persister.persistThread({ target, thread, handoffSummary });

      importedSummaries.push({
        threadId,
        source: thread.source,
        sessionId: thread.sessionId,
        title: thread.title,
        model: thread.model,
        workspacePath: thread.workspacePath,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        messageCount: thread.messages.length,
        messages: [...thread.messages],
        handoffSummary,
      });
    }

    let instructionsMd: string | null = null;
    if (includeRules) {
      const rulesScan = yield* scanner.scanProjectRules(input.workspaceRoot);
      instructionsMd =
        rulesScan.result.instructionsMd.trim().length > 0 ? rulesScan.result.instructionsMd : null;

      for (const ruleDiag of rulesScan.result.diagnostics) {
        diagnostics.push({
          source: "cursor",
          scope: "rules",
          reason: ruleDiag.reason,
          detail: ruleDiag.detail,
          filePath: ruleDiag.path,
        });
      }
    }

    const handoffMarkdown = generateHandoff
      ? buildWorkspaceHandoffMarkdown(input.workspaceRoot, handoffEntries)
      : null;

    const diagnosticsSummary = buildDiagnosticsSummary({
      totalRecords: scanOutput.totalRecordsProcessed + diagnostics.length,
      importedCount: importedSummaries.length,
      repairedTimestampCount: scanOutput.repairedTimestampCount,
      diagnostics,
    });

    return {
      workspaceRoot: input.workspaceRoot,
      importedCount: importedSummaries.length,
      skippedCount:
        skippedCount + diagnostics.filter((d) => d.reason !== "duplicate_session").length,
      duplicateCount,
      threads: importedSummaries,
      instructionsMd,
      handoffMarkdown,
      diagnosticsSummary,
    };
  });

  return {
    scanAll,
    importSelected,
    summarizeDiagnostics,
  };
});

export const layer = Layer.effect(UnifiedImportService, make);

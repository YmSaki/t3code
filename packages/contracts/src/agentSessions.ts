import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AgentSessionSource = Schema.Literals(["claudeAgent", "codex", "pi"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

export const AgentSessionImportSource = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  // A decimal string keeps file IDs above 2^53 (common on NTFS) exact. Older
  // records stored a number.
  inode: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

export const AgentSessionScanInput = Schema.Struct({});
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

export const AgentSessionProjectGit = Schema.Struct({
  remoteKey: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
});
export type AgentSessionProjectGit = typeof AgentSessionProjectGit.Type;

export const AgentSessionProjectCandidate = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
  git: Schema.optionalKey(Schema.NullOr(AgentSessionProjectGit)),
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;

export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedError<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedError<AgentSessionImportProjectChangedError>()(
  "AgentSessionImportProjectChangedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' changed directories. Scan for projects again before importing history.`;
  }
}

export const AgentSessionImportResult = Schema.Struct({
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

export class AgentSessionScanError extends Schema.TaggedError<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals(["read-settings", "read-projects"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to scan agent sessions during ${this.operation}.`;
  }
}

export const ExtendedAgentSessionSource = Schema.Literals([
  "claudeAgent",
  "codex",
  "pi",
  "cursor",
  "opencode",
  "antigravity",
]);
export type ExtendedAgentSessionSource = typeof ExtendedAgentSessionSource.Type;

export const AgentSessionImportDiagnostic = Schema.Struct({
  source: ExtendedAgentSessionSource,
  scope: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
  detail: Schema.NullOr(Schema.String),
  filePath: Schema.optional(Schema.NullOr(Schema.String)),
  line: Schema.optional(Schema.NullOr(NonNegativeInt)),
});
export type AgentSessionImportDiagnostic = typeof AgentSessionImportDiagnostic.Type;

export const AgentSessionImportReasonCount = Schema.Struct({
  reason: TrimmedNonEmptyString,
  count: NonNegativeInt,
});
export type AgentSessionImportReasonCount = typeof AgentSessionImportReasonCount.Type;

export const AgentSessionImportDiagnosticsSummary = Schema.Struct({
  totalRecords: NonNegativeInt,
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
  repairedTimestampCount: NonNegativeInt,
  byReason: Schema.Array(AgentSessionImportReasonCount),
  diagnostics: Schema.optional(Schema.Array(AgentSessionImportDiagnostic)),
});
export type AgentSessionImportDiagnosticsSummary = typeof AgentSessionImportDiagnosticsSummary.Type;

export const AgentSessionProjectCandidateExtended = Schema.Struct({
  path: TrimmedNonEmptyString,
  normalizedPath: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(ExtendedAgentSessionSource),
  threadCount: NonNegativeInt,
  messageCount: Schema.optional(NonNegativeInt),
  ruleFileCount: Schema.optional(NonNegativeInt),
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
  git: Schema.optionalKey(Schema.NullOr(AgentSessionProjectGit)),
});
export type AgentSessionProjectCandidateExtended = typeof AgentSessionProjectCandidateExtended.Type;

export const AgentSessionSelectiveImportInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  workspaceRoot: TrimmedNonEmptyString,
  sources: Schema.optional(Schema.Array(ExtendedAgentSessionSource)),
  sessionIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  includeRules: Schema.optional(Schema.Boolean),
  generateHandoff: Schema.optional(Schema.Boolean),
  forceReimport: Schema.optional(Schema.Boolean),
});
export type AgentSessionSelectiveImportInput = typeof AgentSessionSelectiveImportInput.Type;

export const UnifiedAgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidateExtended),
  scannedAt: IsoDateTime,
  diagnosticsSummary: AgentSessionImportDiagnosticsSummary,
  truncated: Schema.optional(Schema.Boolean),
});
export type UnifiedAgentSessionScanResult = typeof UnifiedAgentSessionScanResult.Type;

export const ImportedSessionMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type ImportedSessionMessage = typeof ImportedSessionMessage.Type;

export const ImportedSessionThreadSummary = Schema.Struct({
  source: ExtendedAgentSessionSource,
  sessionId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  model: Schema.NullOr(Schema.String),
  workspacePath: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  messageCount: NonNegativeInt,
  messages: Schema.Array(ImportedSessionMessage),
  handoffSummary: Schema.NullOr(Schema.String),
});
export type ImportedSessionThreadSummary = typeof ImportedSessionThreadSummary.Type;

export const UnifiedAgentSessionImportResult = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
  duplicateCount: NonNegativeInt,
  threads: Schema.Array(ImportedSessionThreadSummary),
  instructionsMd: Schema.NullOr(Schema.String),
  handoffMarkdown: Schema.NullOr(Schema.String),
  diagnosticsSummary: AgentSessionImportDiagnosticsSummary,
});
export type UnifiedAgentSessionImportResult = typeof UnifiedAgentSessionImportResult.Type;

export class UnifiedAgentSessionError extends Schema.TaggedError<UnifiedAgentSessionError>()(
  "UnifiedAgentSessionError",
  {
    operation: Schema.Literals(["scan", "import", "read-sqlite", "read-transcript", "read-rules"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unified agent session ${this.operation} failed: ${this.detail}`;
  }
}

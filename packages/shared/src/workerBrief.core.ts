import type { EnvironmentId, ProjectId, RuntimeMode, ThreadId } from "@t3tools/contracts";

export const DEFAULT_WORKER_BRIEF_MAX_BYTES = 32_768;
export const BYTES_PER_ESTIMATED_TOKEN = 4;
const TRUNCATION_NOTICE = "\n... [truncated]";
const MIN_SECTION_CONTENT_BYTES = 48;

export type WorkerBriefSectionKind = "core" | "background" | "handbook" | "excerpts";

export interface WorkerLineRange {
  readonly start: number;
  readonly end: number;
}

export interface WorkerRelatedFile {
  readonly path: string;
  readonly reason?: string | undefined;
  readonly lineRange?: WorkerLineRange | undefined;
}

export interface WorkerContextBrief {
  readonly objective: string;
  readonly background: string;
  readonly constraints: ReadonlyArray<string>;
  readonly relatedFiles: ReadonlyArray<WorkerRelatedFile>;
  readonly completionCriteria: ReadonlyArray<string>;
  readonly verificationCommands: ReadonlyArray<string>;
}

export interface WorkerFileExcerpt {
  readonly path: string;
  readonly content: string;
  readonly lineRange?: WorkerLineRange | undefined;
  readonly language?: string | undefined;
}

export interface WorkerBriefBudget {
  readonly maxBytes?: number | undefined;
  readonly maxTokens?: number | undefined;
}

export interface WorkerAssignmentMetadata {
  readonly pmThreadId?: ThreadId | undefined;
  readonly environmentId?: EnvironmentId | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly targetRepoRole?: string | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
}

export interface WorkerBriefBuildInput {
  readonly title?: string | undefined;
  readonly brief: WorkerContextBrief;
  readonly assignment?: WorkerAssignmentMetadata | undefined;
  readonly handbookMarkdown?: string | undefined;
  readonly excerpts?: ReadonlyArray<WorkerFileExcerpt> | undefined;
  readonly budget?: WorkerBriefBudget | undefined;
}

export interface WorkerBriefPromptPack {
  readonly prompt: string;
  readonly byteLength: number;
  readonly estimatedTokens: number;
  readonly effectiveMaxBytes: number;
  readonly truncated: boolean;
  readonly includedSections: ReadonlyArray<WorkerBriefSectionKind>;
  readonly truncatedSections: ReadonlyArray<WorkerBriefSectionKind>;
  readonly includedExcerptPaths: ReadonlyArray<string>;
  readonly omittedExcerptPaths: ReadonlyArray<string>;
}

const utf8Encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

export function estimateTokensFromBytes(byteLength: number): number {
  return Math.ceil(byteLength / BYTES_PER_ESTIMATED_TOKEN);
}

export function resolveEffectiveMaxBytes(budget: WorkerBriefBudget | undefined): number {
  const fromBytes = budget?.maxBytes;
  const fromTokens =
    budget?.maxTokens === undefined ? undefined : budget.maxTokens * BYTES_PER_ESTIMATED_TOKEN;
  if (fromBytes !== undefined && fromTokens !== undefined) {
    return Math.max(1, Math.min(fromBytes, fromTokens));
  }
  return Math.max(1, fromBytes ?? fromTokens ?? DEFAULT_WORKER_BRIEF_MAX_BYTES);
}

export function truncateUtf8(
  value: string,
  maxBytes: number,
  suffix: string = TRUNCATION_NOTICE,
): { readonly text: string; readonly truncated: boolean } {
  if (utf8ByteLength(value) <= maxBytes) return { text: value, truncated: false };
  const suffixBytes = utf8ByteLength(suffix);
  const targetBytes = maxBytes > suffixBytes ? maxBytes - suffixBytes : maxBytes;
  let usedBytes = 0;
  let prefix = "";
  for (const codePoint of value) {
    const codePointBytes = utf8ByteLength(codePoint);
    if (usedBytes + codePointBytes > targetBytes) break;
    prefix += codePoint;
    usedBytes += codePointBytes;
  }
  return {
    text: maxBytes > suffixBytes ? `${prefix}${suffix}` : prefix,
    truncated: true,
  };
}

function formatLineRange(lineRange: WorkerLineRange | undefined): string {
  return lineRange === undefined ? "" : `:${lineRange.start}-${lineRange.end}`;
}

function renderCoreSection(input: WorkerBriefBuildInput): string {
  const heading =
    input.title === undefined || input.title.trim() === ""
      ? "# Worker Assignment"
      : `# Worker Assignment: ${input.title.trim()}`;
  const lines: Array<string> = [heading];

  const meta: Array<string> = [];
  if (input.assignment?.pmThreadId !== undefined)
    meta.push(`PM thread: ${input.assignment.pmThreadId}`);
  if (input.assignment?.targetRepoRole !== undefined)
    meta.push(`Role: ${input.assignment.targetRepoRole}`);
  if (input.assignment?.environmentId !== undefined && input.assignment?.projectId !== undefined) {
    meta.push(`Target: ${input.assignment.environmentId}/${input.assignment.projectId}`);
  }
  if (input.assignment?.runtimeMode !== undefined) {
    meta.push(`Runtime mode: ${input.assignment.runtimeMode}`);
  }
  if (meta.length > 0) lines.push(meta.join(" | "));

  lines.push("", "## Objective", input.brief.objective.trim());
  lines.push(
    "",
    "## Completion Criteria",
    ...input.brief.completionCriteria.map((criterion) => `- [ ] ${criterion.trim()}`),
  );

  if (input.brief.verificationCommands.length > 0) {
    lines.push(
      "",
      "## Verification Commands",
      ...input.brief.verificationCommands.map((command) => `- \`${command.trim()}\``),
    );
  }
  if (input.brief.constraints.length > 0) {
    lines.push(
      "",
      "## Constraints",
      ...input.brief.constraints.map((constraint) => `- ${constraint.trim()}`),
    );
  }
  if (input.brief.relatedFiles.length > 0) {
    lines.push(
      "",
      "## Related Files",
      ...input.brief.relatedFiles.map((file) => {
        const range = formatLineRange(file.lineRange);
        const reason = file.reason === undefined ? "" : `: ${file.reason.trim()}`;
        return `- \`${file.path.trim()}${range}\`${reason}`;
      }),
    );
  }

  return lines.join("\n");
}

function appendOptionalTextSection(input: {
  readonly currentPrompt: string;
  readonly effectiveMaxBytes: number;
  readonly kind: WorkerBriefSectionKind;
  readonly title: string;
  readonly body: string;
  readonly includedSections: Array<WorkerBriefSectionKind>;
  readonly truncatedSections: Array<WorkerBriefSectionKind>;
}): string {
  const trimmed = input.body.trim();
  if (trimmed === "") return input.currentPrompt;
  const header = `\n\n## ${input.title}\n`;
  const remaining =
    input.effectiveMaxBytes - utf8ByteLength(input.currentPrompt) - utf8ByteLength(header);
  if (remaining < MIN_SECTION_CONTENT_BYTES) {
    input.truncatedSections.push(input.kind);
    return input.currentPrompt;
  }
  const fitted = truncateUtf8(trimmed, remaining);
  input.includedSections.push(input.kind);
  if (fitted.truncated) input.truncatedSections.push(input.kind);
  return `${input.currentPrompt}${header}${fitted.text}`;
}

function appendExcerptsSection(input: {
  readonly currentPrompt: string;
  readonly effectiveMaxBytes: number;
  readonly excerpts: ReadonlyArray<WorkerFileExcerpt>;
  readonly includedSections: Array<WorkerBriefSectionKind>;
  readonly truncatedSections: Array<WorkerBriefSectionKind>;
  readonly includedExcerptPaths: Array<string>;
  readonly omittedExcerptPaths: Array<string>;
}): string {
  if (input.excerpts.length === 0) return input.currentPrompt;
  const sectionHeader = "\n\n## File Excerpts";
  let prompt = input.currentPrompt;
  let addedAny = false;
  let truncatedAny = false;

  for (const excerpt of input.excerpts) {
    const label = `${excerpt.path.trim()}${formatLineRange(excerpt.lineRange)}`;
    const lang = excerpt.language?.trim() ?? "";
    const prefix = `${addedAny ? "" : sectionHeader}\n\n### \`${label}\`\n\`\`\`${lang}\n`;
    const suffix = "\n```";
    const overhead = utf8ByteLength(prefix) + utf8ByteLength(suffix);
    const remaining = input.effectiveMaxBytes - utf8ByteLength(prompt) - overhead;
    if (remaining < MIN_SECTION_CONTENT_BYTES) {
      truncatedAny = true;
      input.omittedExcerptPaths.push(excerpt.path);
      continue;
    }
    const fitted = truncateUtf8(excerpt.content, remaining);
    prompt = `${prompt}${prefix}${fitted.text}${suffix}`;
    addedAny = true;
    input.includedExcerptPaths.push(excerpt.path);
    if (fitted.truncated) truncatedAny = true;
  }

  if (addedAny) input.includedSections.push("excerpts");
  if (truncatedAny) input.truncatedSections.push("excerpts");
  return prompt;
}

/** Keeps core > background > handbook > excerpts under the byte/token ceiling. */
export function buildWorkerBriefPrompt(input: WorkerBriefBuildInput): WorkerBriefPromptPack {
  const effectiveMaxBytes = resolveEffectiveMaxBytes(input.budget);
  const includedSections: Array<WorkerBriefSectionKind> = ["core"];
  const truncatedSections: Array<WorkerBriefSectionKind> = [];
  const includedExcerptPaths: Array<string> = [];
  const omittedExcerptPaths: Array<string> = [];

  const rawCore = renderCoreSection(input);
  const fittedCore = truncateUtf8(rawCore, effectiveMaxBytes);
  let prompt = fittedCore.text;
  if (fittedCore.truncated) {
    truncatedSections.push("core");
    if (input.brief.background.trim() !== "") truncatedSections.push("background");
    if ((input.handbookMarkdown?.trim() ?? "") !== "") truncatedSections.push("handbook");
    if ((input.excerpts?.length ?? 0) > 0) {
      truncatedSections.push("excerpts");
      for (const excerpt of input.excerpts ?? []) omittedExcerptPaths.push(excerpt.path);
    }
  } else {
    prompt = appendOptionalTextSection({
      currentPrompt: prompt,
      effectiveMaxBytes,
      kind: "background",
      title: "Background",
      body: input.brief.background,
      includedSections,
      truncatedSections,
    });
    prompt = appendOptionalTextSection({
      currentPrompt: prompt,
      effectiveMaxBytes,
      kind: "handbook",
      title: "MetaProject Handbook",
      body: input.handbookMarkdown ?? "",
      includedSections,
      truncatedSections,
    });
    prompt = appendExcerptsSection({
      currentPrompt: prompt,
      effectiveMaxBytes,
      excerpts: input.excerpts ?? [],
      includedSections,
      truncatedSections,
      includedExcerptPaths,
      omittedExcerptPaths,
    });
  }

  const byteLength = utf8ByteLength(prompt);
  return {
    prompt,
    byteLength,
    estimatedTokens: estimateTokensFromBytes(byteLength),
    effectiveMaxBytes,
    truncated: truncatedSections.length > 0,
    includedSections,
    truncatedSections,
    includedExcerptPaths,
    omittedExcerptPaths,
  };
}

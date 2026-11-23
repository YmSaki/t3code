import { importPathComparisonKey } from "@t3tools/shared/importNormalizer.core";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export type ExistingAgentSessionSource = "claudeAgent" | "codex" | "pi";

export type ExistingSourceMessageRole = "user" | "assistant";

export interface ExistingSourceImportedMessage {
  readonly role: ExistingSourceMessageRole;
  readonly text: string;
  readonly createdAt: string;
}

export interface ExistingSourceImportedThread {
  readonly source: ExistingAgentSessionSource;
  readonly sessionId: string;
  readonly workspacePath: string | null;
  readonly title: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<ExistingSourceImportedMessage>;
}

export type ExistingSourceDiagnosticReason =
  | "invalid_jsonl_line"
  | "non_object_record"
  | "excluded_subagent"
  | "hidden_record"
  | "ignored_record"
  | "empty_message"
  | "synthetic_only_session"
  | "empty_session";

export interface ExistingSourceImportDiagnostic {
  readonly source: ExistingAgentSessionSource;
  readonly line: number | null;
  readonly reason: ExistingSourceDiagnosticReason;
  readonly detail: string;
}

export interface ParseExistingTranscriptInput {
  readonly source: ExistingAgentSessionSource;
  readonly jsonl: string | ReadonlyArray<string | unknown>;
  readonly fallbackSessionId?: string | undefined;
  readonly fallbackWorkspacePath?: string | undefined;
  readonly fallbackTimestamp?: string | undefined;
  readonly codexThreadName?: string | undefined;
}

export interface ParseExistingTranscriptResult {
  readonly thread: ExistingSourceImportedThread | null;
  readonly diagnostics: ReadonlyArray<ExistingSourceImportDiagnostic>;
}

export interface ExistingSourceProjectMetadataSummary {
  readonly workspacePath: string;
  readonly normalizedPath: string;
  readonly sources: ReadonlyArray<ExistingAgentSessionSource>;
  readonly threadCount: number;
  readonly messageCount: number;
  readonly lastActiveAt: string | null;
}

type JsonRecord = Readonly<Record<string, unknown>>;

const DEFAULT_FALLBACK_ISO = "1970-01-01T00:00:00.000Z";
const CLAUDE_SYNTHETIC_MODEL = "<synthetic>";
const TEXT_BLOCK_TYPES = new Set(["text", "input_text", "output_text"]);

const CLAUDE_UI_OUTPUT =
  /^(?:<(?:task-notification|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>|\[Request interrupted by user(?: for tool use)?\]$)/;

const CODEX_TITLE_PREAMBLE =
  /^(?:\s*(?:<(recommended_plugins|environment_context|user_instructions|INSTRUCTIONS|in-app-browser-context|external_codex_apps_open_page)(?:\s[^>]*)?>[\s\S]*?<\/\1>|# AGENTS\.md instructions\b[^\n]*|## My request for Codex:))+/;

const WAKE_ENVELOPE = /^\s*<wake(?:\s[^>]*)?>([\s\S]*?)(?:<\/wake>|$)/;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseJsonOrValue(
  raw: unknown,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly detail: string } {
  if (typeof raw !== "string") return { ok: true, value: raw };
  try {
    return { ok: true, value: JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : "Malformed JSON line",
    };
  }
}

function normalizeIsoTimestamp(value: unknown, fallbackIso: string): string {
  if (typeof value === "string" || typeof value === "number") {
    const parsed = DateTime.make(value);
    if (Option.isSome(parsed)) {
      return DateTime.formatIso(parsed.value);
    }
  }
  return fallbackIso;
}

function epochMsFromIso(value: string): number {
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : 0;
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content.replaceAll("\r\n", "\n").trim();
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const blockType = nonEmptyString(item.type);
    if (blockType !== null && !TEXT_BLOCK_TYPES.has(blockType)) continue;
    const text = nonEmptyString(item.text);
    if (text !== null) chunks.push(text.replaceAll("\r\n", "\n"));
  }
  return chunks.join("\n").trim();
}

function parseClaudeCommand(text: string): {
  readonly text: string;
  readonly titleText: string;
} | null {
  if (!/^<command-(?:name|message)>/.test(text)) return null;
  const name =
    /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim() ||
    `/${/<command-message>([^<]*)<\/command-message>/.exec(text)?.[1]?.trim() ?? ""}`;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
  return { text: args.length === 0 ? name : `${name} ${args}`, titleText: args };
}

function parseClaudeUserText(text: string): {
  readonly text: string;
  readonly titleText: string;
} {
  if (CLAUDE_UI_OUTPUT.test(text)) return { text: "", titleText: "" };
  const shellInput = /^<bash-input>([\s\S]*)<\/bash-input>$/.exec(text)?.[1];
  if (shellInput !== undefined) return { text: `!${shellInput}`, titleText: "" };
  return parseClaudeCommand(text) ?? { text, titleText: text };
}

function isHiddenClaudeRecord(record: JsonRecord): boolean {
  return record.isSidechain === true || record.isMeta === true || record.isCompactSummary === true;
}

function derivePromptTitle(source: ExistingAgentSessionSource, rawText: string): string | null {
  const withoutPreamble = source === "codex" ? rawText.replace(CODEX_TITLE_PREAMBLE, "") : rawText;
  const unwrapped = withoutPreamble.replace(WAKE_ENVELOPE, "$1");
  const firstLine =
    unwrapped
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  if (firstLine.length === 0) return null;
  return firstLine.length > 100 ? firstLine.slice(0, 100).trim() : firstLine;
}

export function classifyExistingRecordRole(
  source: ExistingAgentSessionSource,
  record: unknown,
): ExistingSourceMessageRole | "system" | "ignored" | "unknown" {
  if (!isRecord(record)) return "unknown";

  if (source === "claudeAgent") {
    if (isHiddenClaudeRecord(record)) return "ignored";
    const type = nonEmptyString(record.type);
    if (type === "user") return "user";
    if (type === "assistant") return "assistant";
    if (type === "system" || type === "summary") return "system";
    return "ignored";
  }

  if (source === "pi") {
    const type = nonEmptyString(record.type);
    if (type === "session" || type === "session_info") return "system";
    if (type !== "message" || !isRecord(record.message)) return "ignored";
    const role = nonEmptyString(record.message.role);
    if (role === "user") return "user";
    if (role === "assistant") return "assistant";
    if (role === "system" || role === "tool") return "system";
    return "unknown";
  }

  const type = nonEmptyString(record.type);
  if (type === "session_meta" || type === "turn_context") return "system";
  const payload = isRecord(record.payload) ? record.payload : null;
  if (type === "event_msg" && payload !== null && payload.type === "user_message") {
    return "user";
  }
  if (type === "response_item" && payload !== null && payload.type === "message") {
    const role = nonEmptyString(payload.role);
    if (role === "user") return "user";
    if (role === "assistant") return "assistant";
    if (role === "system" || role === "developer") return "system";
  }
  return "ignored";
}

export function extractExistingRecordProjectPath(
  source: ExistingAgentSessionSource,
  rawLineOrRecord: string | unknown,
): {
  readonly cwd: string | null;
  readonly excludedSubagent: boolean;
} {
  const parsed = parseJsonOrValue(rawLineOrRecord);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return { cwd: null, excludedSubagent: false };
  }
  const record = parsed.value;
  const payload = isRecord(record.payload) ? record.payload : null;

  if (source === "codex" && record.type === "session_meta" && payload !== null) {
    const sessionSource = payload.source;
    if (
      isRecord(sessionSource) &&
      (Object.hasOwn(sessionSource, "subagent") || Object.hasOwn(sessionSource, "subAgent"))
    ) {
      return { cwd: null, excludedSubagent: true };
    }
  }

  const directCwd = nonEmptyString(record.cwd);
  if (directCwd !== null) {
    return { cwd: directCwd, excludedSubagent: false };
  }
  const payloadCwd = payload !== null ? nonEmptyString(payload.cwd) : null;
  return { cwd: payloadCwd, excludedSubagent: false };
}

function selectActivePiRecords(
  records: ReadonlyArray<{ readonly lineNumber: number; readonly record: JsonRecord }>,
): ReadonlyArray<{ readonly lineNumber: number; readonly record: JsonRecord }> {
  const entries = records.filter((item) => item.record.type !== "session");
  const leaf = entries.at(-1);
  const leafId = leaf !== undefined ? nonEmptyString(leaf.record.id) : null;
  if (leaf === undefined || leafId === null) return entries;

  const byId = new Map<string, { readonly lineNumber: number; readonly record: JsonRecord }>();
  for (const entry of entries) {
    const id = nonEmptyString(entry.record.id);
    if (id !== null) byId.set(id, entry);
  }

  const branch: Array<{ readonly lineNumber: number; readonly record: JsonRecord }> = [];
  let current: { readonly lineNumber: number; readonly record: JsonRecord } | undefined = leaf;
  while (current !== undefined && branch.length < entries.length) {
    branch.push(current);
    const parentId = nonEmptyString(current.record.parentId);
    current = parentId !== null ? byId.get(parentId) : undefined;
  }
  return [...branch].reverse();
}

export function parseExistingSourceTranscript(
  input: ParseExistingTranscriptInput,
): ParseExistingTranscriptResult {
  const diagnostics: ExistingSourceImportDiagnostic[] = [];
  const fallbackIso = normalizeIsoTimestamp(input.fallbackTimestamp, DEFAULT_FALLBACK_ISO);

  const rawLines: ReadonlyArray<string | unknown> =
    typeof input.jsonl === "string"
      ? input.jsonl.replaceAll("\r\n", "\n").split("\n")
      : input.jsonl;

  const decodedRecords: Array<{ readonly lineNumber: number; readonly record: JsonRecord }> = [];
  let workspacePath: string | null = nonEmptyString(input.fallbackWorkspacePath);

  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const rawLine = rawLines[idx];
    const lineNumber = idx + 1;
    if (typeof rawLine === "string" && rawLine.trim().length === 0) continue;

    const parsed = parseJsonOrValue(rawLine);
    if (!parsed.ok) {
      diagnostics.push({
        source: input.source,
        line: lineNumber,
        reason: "invalid_jsonl_line",
        detail: parsed.detail,
      });
      continue;
    }
    if (!isRecord(parsed.value)) {
      diagnostics.push({
        source: input.source,
        line: lineNumber,
        reason: "non_object_record",
        detail: `Line ${String(lineNumber)} is not a JSON object`,
      });
      continue;
    }

    const pathInfo = extractExistingRecordProjectPath(input.source, parsed.value);
    if (pathInfo.excludedSubagent) {
      diagnostics.push({
        source: input.source,
        line: lineNumber,
        reason: "excluded_subagent",
        detail: "Codex subagent rollout is excluded from top-level session import",
      });
      return { thread: null, diagnostics };
    }
    if (workspacePath === null && pathInfo.cwd !== null) {
      workspacePath = pathInfo.cwd;
    }

    decodedRecords.push({ lineNumber, record: parsed.value });
  }

  let sessionId = nonEmptyString(input.fallbackSessionId) ?? "";
  let explicitTitle: string | null = nonEmptyString(input.codexThreadName);
  let customTitle: string | null = null;
  let derivedTitle: string | null = null;
  let bareCommandTitle: string | null = null;
  let model: string | null = null;
  let hasClaudeSyntheticReply = false;
  let hasClaudeModelReply = false;

  const messages: Array<ExistingSourceImportedMessage & { readonly codexResponseUser: boolean }> =
    [];

  if (input.source === "claudeAgent") {
    for (const { lineNumber, record } of decodedRecords) {
      if (isHiddenClaudeRecord(record)) {
        diagnostics.push({
          source: input.source,
          line: lineNumber,
          reason: "hidden_record",
          detail: `Line ${String(lineNumber)} is a sidechain/meta/compact Claude record`,
        });
        continue;
      }

      const recordSessionId = nonEmptyString(record.sessionId);
      if (recordSessionId !== null) sessionId = recordSessionId;

      const aiTitle = nonEmptyString(record.aiTitle);
      if (aiTitle !== null && parseClaudeUserText(aiTitle).text === aiTitle) {
        explicitTitle = aiTitle;
      }
      if (record.customTitle !== undefined) {
        const rawCustom = nonEmptyString(record.customTitle);
        customTitle =
          rawCustom !== null && parseClaudeUserText(rawCustom).text === rawCustom
            ? rawCustom
            : null;
      }

      const msgRecord = isRecord(record.message) ? record.message : null;
      const msgModel = msgRecord !== null ? nonEmptyString(msgRecord.model) : null;
      if (msgModel !== null && msgModel !== CLAUDE_SYNTHETIC_MODEL) {
        model = msgModel;
      }

      const recordType = nonEmptyString(record.type);
      if (recordType !== "user" && recordType !== "assistant") continue;

      const rawText = extractContentText(msgRecord?.content);
      const { text, titleText } =
        recordType === "user"
          ? parseClaudeUserText(rawText)
          : { text: rawText, titleText: rawText };

      if (text.length === 0) {
        diagnostics.push({
          source: input.source,
          line: lineNumber,
          reason: "empty_message",
          detail: `Claude ${recordType} turn at line ${String(lineNumber)} has no visible text`,
        });
        continue;
      }

      if (recordType === "assistant") {
        if (msgModel === CLAUDE_SYNTHETIC_MODEL) hasClaudeSyntheticReply = true;
        else hasClaudeModelReply = true;
      } else if (derivedTitle === null) {
        derivedTitle = derivePromptTitle(input.source, titleText);
        bareCommandTitle ??= derivePromptTitle(input.source, text);
      }

      messages.push({
        role: recordType,
        text,
        createdAt: normalizeIsoTimestamp(record.timestamp, fallbackIso),
        codexResponseUser: false,
      });
    }

    if (hasClaudeSyntheticReply && !hasClaudeModelReply) {
      diagnostics.push({
        source: input.source,
        line: null,
        reason: "synthetic_only_session",
        detail: "Claude session contains only synthetic error replies",
      });
      return { thread: null, diagnostics };
    }
  } else if (input.source === "pi") {
    const sessionHeader = decodedRecords.find((item) => item.record.type === "session");
    const headerId = sessionHeader !== undefined ? nonEmptyString(sessionHeader.record.id) : null;
    if (headerId !== null) sessionId = headerId;

    for (let i = decodedRecords.length - 1; i >= 0; i -= 1) {
      const candidate = decodedRecords[i];
      if (candidate?.record.type === "session_info") {
        explicitTitle = nonEmptyString(candidate.record.name);
        break;
      }
    }

    const activeBranch = selectActivePiRecords(decodedRecords);
    for (const { lineNumber, record } of activeBranch) {
      if (record.type !== "message" || !isRecord(record.message)) continue;
      const role = nonEmptyString(record.message.role);
      if (role !== "user" && role !== "assistant") continue;

      const msgModel = nonEmptyString(record.message.model) ?? nonEmptyString(record.model);
      if (msgModel !== null) model = msgModel;

      const text = extractContentText(record.message.content);
      if (text.length === 0) {
        diagnostics.push({
          source: input.source,
          line: lineNumber,
          reason: "empty_message",
          detail: `Pi ${role} message at line ${String(lineNumber)} has empty content`,
        });
        continue;
      }

      if (role === "user" && derivedTitle === null) {
        derivedTitle = derivePromptTitle(input.source, text);
      }

      messages.push({
        role,
        text,
        createdAt: normalizeIsoTimestamp(record.timestamp, fallbackIso),
        codexResponseUser: false,
      });
    }
  } else {
    let hasCodexSessionId = false;
    for (const { lineNumber, record } of decodedRecords) {
      const type = nonEmptyString(record.type);
      const payload = isRecord(record.payload) ? record.payload : null;

      if (type === "session_meta" && payload !== null) {
        const metaId = nonEmptyString(payload.id) ?? nonEmptyString(payload.session_id);
        if (!hasCodexSessionId && metaId !== null) {
          sessionId = metaId;
          hasCodexSessionId = true;
        }
        continue;
      }

      if (type === "turn_context" && payload !== null) {
        const turnModel = nonEmptyString(payload.model);
        if (turnModel !== null) model = turnModel;
        continue;
      }

      if (type === "event_msg" && payload !== null && payload.type === "user_message") {
        const text = nonEmptyString(payload.message);
        if (text === null) {
          diagnostics.push({
            source: input.source,
            line: lineNumber,
            reason: "empty_message",
            detail: `Codex event_msg at line ${String(lineNumber)} has empty message`,
          });
          continue;
        }
        for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
          const prev = messages[idx];
          if (prev?.role === "assistant") break;
          if (prev?.codexResponseUser === true && prev.text === text) {
            messages.splice(idx, 1);
            break;
          }
        }
        if (derivedTitle === null) {
          derivedTitle = derivePromptTitle(input.source, text);
        }
        messages.push({
          role: "user",
          text,
          createdAt: normalizeIsoTimestamp(record.timestamp, fallbackIso),
          codexResponseUser: false,
        });
        continue;
      }

      if (type === "response_item" && payload !== null && payload.type === "message") {
        const role = nonEmptyString(payload.role);
        if (role !== "user" && role !== "assistant") continue;
        const text = extractContentText(payload.content);
        if (text.length === 0) {
          diagnostics.push({
            source: input.source,
            line: lineNumber,
            reason: "empty_message",
            detail: `Codex response_item at line ${String(lineNumber)} has empty content`,
          });
          continue;
        }
        if (role === "user") {
          let duplicateInTurn = false;
          for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
            const prev = messages[idx];
            if (prev?.role === "assistant") break;
            if (prev?.role === "user" && !prev.codexResponseUser && prev.text === text) {
              duplicateInTurn = true;
              break;
            }
          }
          if (duplicateInTurn) continue;
          if (derivedTitle === null) {
            derivedTitle = derivePromptTitle(input.source, text);
          }
        }
        messages.push({
          role,
          text,
          createdAt: normalizeIsoTimestamp(record.timestamp, fallbackIso),
          codexResponseUser: role === "user",
        });
      }
    }
  }

  const hasUserMessage = messages.some((m) => m.role === "user");
  const hasAssistantMessage = messages.some((m) => m.role === "assistant");
  if (
    sessionId.length === 0 ||
    !hasUserMessage ||
    (input.source === "claudeAgent" && derivedTitle === null && !hasAssistantMessage)
  ) {
    diagnostics.push({
      source: input.source,
      line: null,
      reason: "empty_session",
      detail: `Session has no importable user conversation (${input.source})`,
    });
    return { thread: null, diagnostics };
  }

  const cleanMessages: ReadonlyArray<ExistingSourceImportedMessage> = messages.map(
    ({ codexResponseUser: _codexResponseUser, ...rest }) => rest,
  );
  const createdAt = cleanMessages[0]?.createdAt ?? fallbackIso;
  const updatedAt = cleanMessages.at(-1)?.createdAt ?? fallbackIso;
  const title =
    customTitle ?? explicitTitle ?? derivedTitle ?? bareCommandTitle ?? "Imported thread";

  return {
    thread: {
      source: input.source,
      sessionId,
      workspacePath,
      title,
      model,
      createdAt,
      updatedAt,
      messages: cleanMessages,
    },
    diagnostics,
  };
}

export function summarizeExistingSourceMetadata(
  threads: ReadonlyArray<ExistingSourceImportedThread>,
): ReadonlyArray<ExistingSourceProjectMetadataSummary> {
  const groups = new Map<
    string,
    {
      workspacePath: string;
      normalizedPath: string;
      sources: Set<ExistingAgentSessionSource>;
      threadCount: number;
      messageCount: number;
      lastActiveAtMs: number | null;
      lastActiveAt: string | null;
    }
  >();

  for (const thread of threads) {
    if (thread.workspacePath === null) continue;
    const normalizedPath = importPathComparisonKey(thread.workspacePath);
    if (normalizedPath.length === 0) continue;

    const updatedMs = epochMsFromIso(thread.updatedAt);
    const existing = groups.get(normalizedPath);
    if (existing === undefined) {
      groups.set(normalizedPath, {
        workspacePath: thread.workspacePath,
        normalizedPath,
        sources: new Set([thread.source]),
        threadCount: 1,
        messageCount: thread.messages.length,
        lastActiveAtMs: updatedMs,
        lastActiveAt: thread.updatedAt,
      });
      continue;
    }

    existing.sources.add(thread.source);
    existing.threadCount += 1;
    existing.messageCount += thread.messages.length;
    if (existing.lastActiveAtMs === null || updatedMs > existing.lastActiveAtMs) {
      existing.lastActiveAtMs = updatedMs;
      existing.lastActiveAt = thread.updatedAt;
    }
  }

  return [...groups.values()]
    .sort((a, b) => (b.lastActiveAtMs ?? 0) - (a.lastActiveAtMs ?? 0))
    .map((group) => ({
      workspacePath: group.workspacePath,
      normalizedPath: group.normalizedPath,
      sources: [...group.sources],
      threadCount: group.threadCount,
      messageCount: group.messageCount,
      lastActiveAt: group.lastActiveAt,
    }));
}

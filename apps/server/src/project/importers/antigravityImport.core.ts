import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export type AntigravityMessageRole = "user" | "assistant";

export interface AntigravityImportedMessage {
  readonly stepIndex: number | null;
  readonly role: AntigravityMessageRole;
  readonly text: string;
  readonly createdAt: string;
}

export interface AntigravityImportedThread {
  readonly sessionId: string;
  readonly workspacePath: string | null;
  readonly title: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<AntigravityImportedMessage>;
}

export type AntigravityImportDiagnosticReason =
  | "invalid_metadata_json"
  | "invalid_metadata"
  | "invalid_jsonl_line"
  | "non_object_record"
  | "ignored_step"
  | "empty_message"
  | "empty_session";

export interface AntigravityImportDiagnostic {
  readonly line: number | null;
  readonly reason: AntigravityImportDiagnosticReason;
  readonly detail: string;
}

export interface ParseAntigravitySessionInput {
  readonly jsonl?: string | ReadonlyArray<string | unknown> | undefined;
  readonly metadata?: string | unknown | undefined;
  readonly fallbackSessionId?: string | undefined;
  readonly fallbackTimestamp?: string | undefined;
}

export interface ParseAntigravitySessionResult {
  readonly thread: AntigravityImportedThread | null;
  readonly diagnostics: ReadonlyArray<AntigravityImportDiagnostic>;
}

type JsonRecord = Readonly<Record<string, unknown>>;

const DEFAULT_FALLBACK_ISO = "1970-01-01T00:00:00.000Z";
const SECONDS_THRESHOLD = 1e11;
const NUMERIC_TIMESTAMP = /^\d+(?:\.\d+)?$/;
const URI_PATTERN = /^file:\/\/([^/?#]*)([^?#]*)/i;
const DRIVE_URI_PATH = /^\/([a-zA-Z]):(?:\/(.*))?$/;

const USER_TYPES = new Set(["user_input", "user_message", "user", "human"]);
const ASSISTANT_TYPES = new Set([
  "planner_response",
  "assistant_message",
  "model_response",
  "assistant",
  "model",
]);
const IGNORED_TYPES = new Set([
  "tool_call",
  "tool_response",
  "tool_result",
  "system",
  "system_message",
  "checkpoint",
  "metadata",
  "session_metadata",
]);

const USER_SOURCES = new Set(["user_explicit", "user", "human"]);
const ASSISTANT_SOURCES = new Set(["model", "assistant", "planner", "agent", "antigravity"]);
const IGNORED_SOURCES = new Set(["system", "tool"]);

const USER_REQUEST_TAG_PATTERN = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi;
const SYSTEM_MESSAGE_TAG_PATTERN = /<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstString(record: JsonRecord, keys: ReadonlyArray<string>): string | null {
  for (const key of keys) {
    const value = nonEmptyString(record[key]);
    if (value !== null) return value;
  }
  return null;
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
      detail: error instanceof Error ? error.message : "Malformed JSON string",
    };
  }
}

function scaleEpoch(value: number): number {
  return value < SECONDS_THRESHOLD ? value * 1000 : value;
}

function formatEpochIso(ms: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

function parseTimestampMs(value: unknown): number | null {
  let candidate: number | string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    candidate = Math.trunc(scaleEpoch(value));
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (NUMERIC_TIMESTAMP.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric) || numeric <= 0) return null;
      candidate = Math.trunc(scaleEpoch(numeric));
    } else {
      candidate = trimmed;
    }
  } else {
    return null;
  }
  const parsed = DateTime.make(candidate);
  if (Option.isNone(parsed)) return null;
  const epochMs = DateTime.toEpochMillis(parsed.value);
  return Number.isFinite(epochMs) && epochMs > 0 ? Math.trunc(epochMs) : null;
}

function normalizeWorkspaceUriOrPath(raw: string): string {
  const trimmed = raw.trim();
  const match = URI_PATTERN.exec(trimmed);
  if (!match) return trimmed;
  let pathname = match[2] ?? "";
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep raw pathname when percent-decoding fails.
  }
  const drive = DRIVE_URI_PATH.exec(pathname);
  if (drive) {
    const letter = (drive[1] ?? "").toUpperCase();
    const rest = (drive[2] ?? "").replaceAll("/", "\\");
    return `${letter}:\\${rest}`;
  }
  return pathname;
}

function extractWorkspaceFromRecord(record: JsonRecord): string | null {
  const direct = firstString(record, [
    "workspacePath",
    "workspace_path",
    "workspaceRoot",
    "workspace_root",
    "workspace",
    "cwd",
    "projectPath",
  ]);
  if (direct !== null) return normalizeWorkspaceUriOrPath(direct);

  for (const arrayKey of ["workspaces", "activeWorkspaces", "active_workspaces", "folders"]) {
    const list = record[arrayKey];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === "string" && item.trim().length > 0) {
        return normalizeWorkspaceUriOrPath(item);
      }
      if (isRecord(item)) {
        const path = firstString(item, ["path", "uri", "workspacePath", "folder"]);
        if (path !== null) return normalizeWorkspaceUriOrPath(path);
      }
    }
  }
  return null;
}

function extractModelFromRecord(record: JsonRecord): string | null {
  const direct = firstString(record, ["model", "modelName", "model_name", "modelId", "model_id"]);
  if (direct !== null) return direct;
  if (isRecord(record.modelConfig)) {
    return firstString(record.modelConfig, ["model", "modelName", "id"]);
  }
  return null;
}

function extractUserInputText(rawText: string): string {
  const matches = [...rawText.matchAll(USER_REQUEST_TAG_PATTERN)];
  if (matches.length > 0) {
    return matches
      .map((match) => (match[1] ?? "").replaceAll("\r\n", "\n").trim())
      .filter((chunk) => chunk.length > 0)
      .join("\n\n")
      .trim();
  }
  const stripped = rawText.replace(SYSTEM_MESSAGE_TAG_PATTERN, "");
  return stripped.replaceAll("\r\n", "\n").trim();
}

function extractStepContentText(content: unknown, role: AntigravityMessageRole): string {
  if (typeof content === "string") {
    return role === "user"
      ? extractUserInputText(content)
      : content.replaceAll("\r\n", "\n").trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => extractStepContentText(part, role))
      .filter((text) => text.length > 0)
      .join("\n")
      .trim();
  }
  if (isRecord(content)) {
    if (typeof content.type === "string") {
      const partType = content.type.toLowerCase();
      if (partType !== "text" && partType !== "input_text" && partType !== "output_text") {
        return "";
      }
    }
    if (typeof content.text === "string") {
      return extractStepContentText(content.text, role);
    }
    if (content.content !== undefined) {
      return extractStepContentText(content.content, role);
    }
  }
  return "";
}

function classifyStepRole(record: JsonRecord): AntigravityMessageRole | "ignored" | null {
  const stepType = nonEmptyString(record.type)?.toLowerCase() ?? null;
  const source = nonEmptyString(record.source)?.toLowerCase() ?? null;
  const role = nonEmptyString(record.role)?.toLowerCase() ?? null;

  if (stepType !== null && IGNORED_TYPES.has(stepType)) return "ignored";
  if (role !== null && IGNORED_SOURCES.has(role)) return "ignored";

  if (stepType !== null && USER_TYPES.has(stepType)) {
    if (source === "system") return "ignored";
    return "user";
  }
  if (stepType !== null && ASSISTANT_TYPES.has(stepType)) return "assistant";

  if (role === "user" || role === "human") return "user";
  if (role === "assistant" || role === "model" || role === "agent") return "assistant";

  if (source !== null) {
    if (IGNORED_SOURCES.has(source)) return "ignored";
    if (USER_SOURCES.has(source)) return "user";
    if (ASSISTANT_SOURCES.has(source)) return "assistant";
  }

  return null;
}

function deriveTitle(
  metadataRecord: JsonRecord | null,
  headerTitle: string | null,
  messages: ReadonlyArray<AntigravityImportedMessage>,
  fallbackTitle: string,
): string {
  const metaTitle =
    metadataRecord !== null
      ? firstString(metadataRecord, ["title", "name", "summary", "topic"])
      : null;
  if (metaTitle !== null) return metaTitle;
  if (headerTitle !== null) return headerTitle;

  const firstUser = messages.find((message) => message.role === "user");
  const firstLine = firstUser?.text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return fallbackTitle;
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

export function parseAntigravitySession(
  input: ParseAntigravitySessionInput,
): ParseAntigravitySessionResult {
  const diagnostics: AntigravityImportDiagnostic[] = [];
  const fallbackMs =
    parseTimestampMs(input.fallbackTimestamp) ?? parseTimestampMs(DEFAULT_FALLBACK_ISO) ?? 0;

  let metadataRecord: JsonRecord | null = null;
  if (input.metadata !== undefined && input.metadata !== null) {
    const parsedMeta = parseJsonOrValue(input.metadata);
    if (!parsedMeta.ok) {
      diagnostics.push({
        line: null,
        reason: "invalid_metadata_json",
        detail: parsedMeta.detail,
      });
    } else if (!isRecord(parsedMeta.value)) {
      diagnostics.push({
        line: null,
        reason: "invalid_metadata",
        detail: "Antigravity session metadata must be a JSON object",
      });
    } else {
      metadataRecord = parsedMeta.value;
    }
  }

  const rawLines: ReadonlyArray<string | unknown> =
    typeof input.jsonl === "string"
      ? input.jsonl.replaceAll("\r\n", "\n").split("\n")
      : (input.jsonl ?? []);

  let inlineSessionId: string | null = null;
  let inlineWorkspace: string | null = null;
  let inlineTitle: string | null = null;
  let inlineModel: string | null = null;
  let lastTimestampMs =
    (metadataRecord !== null
      ? parseTimestampMs(metadataRecord.createdAt ?? metadataRecord.created_at)
      : null) ?? fallbackMs;

  const collectedMessages: Array<{
    readonly stepIndex: number | null;
    readonly role: AntigravityMessageRole;
    readonly text: string;
    readonly timestampMs: number;
    readonly order: number;
  }> = [];

  rawLines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    if (typeof rawLine === "string" && rawLine.trim().length === 0) return;

    const parsed = parseJsonOrValue(rawLine);
    if (!parsed.ok) {
      diagnostics.push({
        line: lineNumber,
        reason: "invalid_jsonl_line",
        detail: parsed.detail,
      });
      return;
    }
    if (!isRecord(parsed.value)) {
      diagnostics.push({
        line: lineNumber,
        reason: "non_object_record",
        detail: `JSONL record at line ${String(lineNumber)} is not an object`,
      });
      return;
    }

    const record = parsed.value;
    inlineSessionId ??= firstString(record, [
      "conversationId",
      "conversation_id",
      "sessionId",
      "session_id",
    ]);
    inlineWorkspace ??= extractWorkspaceFromRecord(record);
    inlineTitle ??= firstString(record, ["title", "conversationTitle", "conversation_title"]);
    inlineModel ??= extractModelFromRecord(record);

    const stepType = nonEmptyString(record.type)?.toLowerCase();
    if (stepType === "metadata" || stepType === "session_metadata") {
      return;
    }

    const role = classifyStepRole(record);
    if (role === "ignored" || role === null) {
      if (role === null) {
        diagnostics.push({
          line: lineNumber,
          reason: "ignored_step",
          detail: `Line ${String(lineNumber)} has unrecognized step type/source`,
        });
      }
      return;
    }

    const rawBody = record.content ?? record.text ?? record.message ?? record.response;
    const text = extractStepContentText(rawBody, role);
    if (text.length === 0) {
      if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) {
        return;
      }
      diagnostics.push({
        line: lineNumber,
        reason: "empty_message",
        detail: `Line ${String(lineNumber)} (${role}) has empty text`,
      });
      return;
    }

    const rawStepIndex = record.step_index ?? record.stepIndex;
    const stepIndex =
      typeof rawStepIndex === "number" && Number.isInteger(rawStepIndex) && rawStepIndex >= 0
        ? rawStepIndex
        : null;

    const timestampMs =
      parseTimestampMs(record.created_at) ??
      parseTimestampMs(record.createdAt) ??
      parseTimestampMs(record.timestamp) ??
      lastTimestampMs;
    lastTimestampMs = timestampMs;

    collectedMessages.push({
      stepIndex,
      role,
      text,
      timestampMs,
      order: index,
    });
  });

  const seen = new Set<string>();
  const sortedMessages = [...collectedMessages]
    .sort((a, b) => {
      if (a.stepIndex !== null && b.stepIndex !== null && a.stepIndex !== b.stepIndex) {
        return a.stepIndex - b.stepIndex;
      }
      return a.timestampMs - b.timestampMs || a.order - b.order;
    })
    .filter((entry) => {
      const dedupeKey =
        entry.stepIndex !== null
          ? `step:${String(entry.stepIndex)}:${entry.role}:${entry.text}`
          : `msg:${entry.role}:${String(entry.timestampMs)}:${entry.text}`;
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    });

  if (sortedMessages.length === 0) {
    diagnostics.push({
      line: null,
      reason: "empty_session",
      detail: "Antigravity transcript contains no importable messages",
    });
    return { thread: null, diagnostics };
  }

  const sessionId =
    (metadataRecord !== null
      ? firstString(metadataRecord, [
          "conversationId",
          "conversation_id",
          "sessionId",
          "session_id",
          "id",
        ])
      : null) ??
    inlineSessionId ??
    nonEmptyString(input.fallbackSessionId) ??
    "antigravity-session";

  const workspacePath =
    (metadataRecord !== null ? extractWorkspaceFromRecord(metadataRecord) : null) ??
    inlineWorkspace ??
    null;

  const model =
    (metadataRecord !== null ? extractModelFromRecord(metadataRecord) : null) ??
    inlineModel ??
    null;

  const messages: ReadonlyArray<AntigravityImportedMessage> = sortedMessages.map((entry) => ({
    stepIndex: entry.stepIndex,
    role: entry.role,
    text: entry.text,
    createdAt: formatEpochIso(entry.timestampMs),
  }));

  const metaCreatedMs =
    metadataRecord !== null
      ? parseTimestampMs(metadataRecord.createdAt ?? metadataRecord.created_at)
      : null;
  const metaUpdatedMs =
    metadataRecord !== null
      ? parseTimestampMs(metadataRecord.updatedAt ?? metadataRecord.updated_at)
      : null;
  const firstMsgMs = sortedMessages[0]?.timestampMs ?? fallbackMs;
  const lastMsgMs = sortedMessages.at(-1)?.timestampMs ?? firstMsgMs;
  const createdMs = metaCreatedMs !== null ? Math.min(metaCreatedMs, firstMsgMs) : firstMsgMs;
  const updatedMs = Math.max(createdMs, lastMsgMs, metaUpdatedMs ?? lastMsgMs);

  const title = deriveTitle(metadataRecord, inlineTitle, messages, `Antigravity ${sessionId}`);

  return {
    thread: {
      sessionId,
      workspacePath,
      title,
      model,
      createdAt: formatEpochIso(createdMs),
      updatedAt: formatEpochIso(updatedMs),
      messages,
    },
    diagnostics,
  };
}

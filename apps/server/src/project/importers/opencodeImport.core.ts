import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export type OpencodeMessageRole = "user" | "assistant";

export interface OpencodeImportedMessage {
  readonly id: string | null;
  readonly role: OpencodeMessageRole;
  readonly text: string;
  readonly createdAt: string;
}

export interface OpencodeImportedThread {
  readonly sessionId: string;
  readonly directory: string | null;
  readonly title: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<OpencodeImportedMessage>;
}

export type OpencodeImportDiagnosticReason =
  | "invalid_json"
  | "invalid_session"
  | "invalid_message"
  | "invalid_part"
  | "orphan_part"
  | "unsupported_role"
  | "empty_message"
  | "empty_session";

export interface OpencodeImportDiagnostic {
  readonly scope: "session" | "message" | "part";
  readonly reason: OpencodeImportDiagnosticReason;
  readonly detail: string;
}

export interface ParseOpencodeSessionInput {
  readonly session: string | unknown;
  readonly messages?: ReadonlyArray<string | unknown> | undefined;
  readonly parts?: ReadonlyArray<string | unknown> | undefined;
  readonly fallbackSessionId?: string | undefined;
  readonly fallbackTimestamp?: string | undefined;
}

export interface ParseOpencodeSessionResult {
  readonly thread: OpencodeImportedThread | null;
  readonly diagnostics: ReadonlyArray<OpencodeImportDiagnostic>;
}

export interface ParseOpencodeSessionsResult {
  readonly threads: ReadonlyArray<OpencodeImportedThread>;
  readonly diagnostics: ReadonlyArray<OpencodeImportDiagnostic>;
}

type JsonRecord = Readonly<Record<string, unknown>>;

const DEFAULT_FALLBACK_ISO = "1970-01-01T00:00:00.000Z";
const SECONDS_THRESHOLD = 1e11;
const NUMERIC_TIMESTAMP = /^\d+(?:\.\d+)?$/;
const USER_ROLES = new Set(["user", "human"]);
const ASSISTANT_ROLES = new Set(["assistant", "ai", "model", "agent", "bot"]);
const UNSUPPORTED_ROLES = new Set(["system", "tool", "function", "developer"]);
const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);
const IGNORED_PART_TYPES = new Set([
  "step-start",
  "step-finish",
  "tool",
  "tool-invocation",
  "tool-result",
  "patch",
  "snapshot",
  "file",
  "agent",
  "retry",
  "compaction",
  "reasoning",
]);
const PLACEHOLDER_TITLES = new Set(["new session", "untitled", "chat"]);

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

function extractRecordTimestamps(record: JsonRecord): {
  readonly createdMs: number | null;
  readonly updatedMs: number | null;
} {
  const timeField = isRecord(record.time) ? record.time : null;
  const createdMs =
    parseTimestampMs(timeField?.created) ??
    parseTimestampMs(timeField?.start) ??
    parseTimestampMs(record.createdAt) ??
    parseTimestampMs(record.created_at) ??
    parseTimestampMs(record.timestamp);
  const updatedMs =
    parseTimestampMs(timeField?.updated) ??
    parseTimestampMs(timeField?.completed) ??
    parseTimestampMs(timeField?.end) ??
    parseTimestampMs(record.updatedAt) ??
    parseTimestampMs(record.updated_at) ??
    createdMs;
  return { createdMs, updatedMs };
}

function extractModel(record: JsonRecord): string | null {
  if (typeof record.model === "string") {
    const direct = nonEmptyString(record.model);
    if (direct !== null) return direct;
  }
  if (isRecord(record.model)) {
    const providerId = firstString(record.model, ["providerID", "providerId", "provider"]);
    const modelId = firstString(record.model, ["modelID", "modelId", "id", "name"]);
    if (providerId !== null && modelId !== null) return `${providerId}/${modelId}`;
    if (modelId !== null) return modelId;
  }
  const providerId = firstString(record, ["providerID", "providerId"]);
  const modelId = firstString(record, ["modelID", "modelId", "modelName"]);
  if (providerId !== null && modelId !== null) return `${providerId}/${modelId}`;
  return modelId;
}

function extractDirectory(record: JsonRecord): string | null {
  const direct = firstString(record, ["directory", "cwd", "workspacePath", "projectPath"]);
  if (direct !== null) return direct;
  if (typeof record.path === "string") {
    const pathStr = nonEmptyString(record.path);
    if (pathStr !== null) return pathStr;
  }
  if (isRecord(record.path)) {
    const nested = firstString(record.path, ["root", "cwd", "directory"]);
    if (nested !== null) return nested;
  }
  return null;
}

interface ParsedPart {
  readonly id: string | null;
  readonly messageId: string | null;
  readonly text: string;
  readonly timestampMs: number | null;
  readonly order: number;
}

function extractPartText(record: JsonRecord): string | null {
  const partType = nonEmptyString(record.type)?.toLowerCase() ?? "text";
  if (IGNORED_PART_TYPES.has(partType)) return "";
  if (!TEXT_PART_TYPES.has(partType)) return null;
  const raw = record.text ?? record.content ?? record.value;
  if (typeof raw !== "string") return "";
  return raw.replaceAll("\r\n", "\n").trim();
}

function extractInlineMessageText(
  record: JsonRecord,
  diagnostics: OpencodeImportDiagnostic[],
): string {
  const chunks: string[] = [];
  for (const field of ["text", "content"]) {
    const value = record[field];
    if (typeof value === "string") {
      const trimmed = value.replaceAll("\r\n", "\n").trim();
      if (trimmed.length > 0) chunks.push(trimmed);
    } else if (Array.isArray(value)) {
      value.forEach((part, idx) => {
        if (typeof part === "string") {
          const trimmed = part.replaceAll("\r\n", "\n").trim();
          if (trimmed.length > 0) chunks.push(trimmed);
          return;
        }
        if (!isRecord(part)) {
          diagnostics.push({
            scope: "part",
            reason: "invalid_part",
            detail: `Inline content part at index ${String(idx)} is not an object`,
          });
          return;
        }
        const partText = extractPartText(part);
        if (partText === null) {
          diagnostics.push({
            scope: "part",
            reason: "invalid_part",
            detail: `Unsupported inline part type at index ${String(idx)}`,
          });
          return;
        }
        if (partText.length > 0) chunks.push(partText);
      });
    }
  }
  if (Array.isArray(record.parts)) {
    record.parts.forEach((part, idx) => {
      if (typeof part === "string") {
        const trimmed = part.replaceAll("\r\n", "\n").trim();
        if (trimmed.length > 0) chunks.push(trimmed);
        return;
      }
      if (!isRecord(part)) {
        diagnostics.push({
          scope: "part",
          reason: "invalid_part",
          detail: `Inline part at index ${String(idx)} is not an object`,
        });
        return;
      }
      const partText = extractPartText(part);
      if (partText === null) {
        diagnostics.push({
          scope: "part",
          reason: "invalid_part",
          detail: `Unsupported inline part type at index ${String(idx)}`,
        });
        return;
      }
      if (partText.length > 0) chunks.push(partText);
    });
  }
  return chunks.join("\n").trim();
}

function classifyRole(rawRole: unknown): OpencodeMessageRole | "unsupported" | "unknown" {
  if (typeof rawRole !== "string") return "unknown";
  const normalized = rawRole.trim().toLowerCase();
  if (USER_ROLES.has(normalized)) return "user";
  if (ASSISTANT_ROLES.has(normalized)) return "assistant";
  if (UNSUPPORTED_ROLES.has(normalized)) return "unsupported";
  return "unknown";
}

function deriveTitle(
  sessionRecord: JsonRecord,
  messages: ReadonlyArray<OpencodeImportedMessage>,
  fallbackTitle: string,
): string {
  const explicit = firstString(sessionRecord, ["title", "name", "summary", "slug"]);
  if (explicit !== null) {
    const isPlaceholder =
      PLACEHOLDER_TITLES.has(explicit.toLowerCase()) || /^new session\b/i.test(explicit);
    if (!isPlaceholder || messages.length === 0) return explicit;
  }
  const firstUser = messages.find((message) => message.role === "user");
  const firstLine = firstUser?.text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine) {
    return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
  }
  return explicit ?? fallbackTitle;
}

export function parseOpencodeSession(input: ParseOpencodeSessionInput): ParseOpencodeSessionResult {
  const diagnostics: OpencodeImportDiagnostic[] = [];
  const fallbackMs =
    parseTimestampMs(input.fallbackTimestamp) ?? parseTimestampMs(DEFAULT_FALLBACK_ISO) ?? 0;

  const parsedSession = parseJsonOrValue(input.session);
  if (!parsedSession.ok) {
    diagnostics.push({
      scope: "session",
      reason: "invalid_json",
      detail: parsedSession.detail,
    });
    return { thread: null, diagnostics };
  }
  if (!isRecord(parsedSession.value)) {
    diagnostics.push({
      scope: "session",
      reason: "invalid_session",
      detail: "Session payload must be a JSON object",
    });
    return { thread: null, diagnostics };
  }

  const rootRecord = parsedSession.value;
  const sessionRecord = isRecord(rootRecord.info)
    ? rootRecord.info
    : isRecord(rootRecord.session)
      ? rootRecord.session
      : rootRecord;

  const rawMessages: ReadonlyArray<unknown> = [
    ...(Array.isArray(rootRecord.messages) ? rootRecord.messages : []),
    ...(Array.isArray(sessionRecord.messages) && sessionRecord !== rootRecord
      ? sessionRecord.messages
      : []),
    ...(input.messages ?? []),
  ];

  const rawParts: ReadonlyArray<unknown> = [
    ...(Array.isArray(rootRecord.parts) ? rootRecord.parts : []),
    ...(Array.isArray(sessionRecord.parts) && sessionRecord !== rootRecord
      ? sessionRecord.parts
      : []),
    ...(input.parts ?? []),
  ];

  const partsByMessageId = new Map<string, ParsedPart[]>();
  const orphanCandidates: Array<{ readonly messageId: string | null; readonly order: number }> = [];

  rawParts.forEach((rawPart, index) => {
    const parsed = parseJsonOrValue(rawPart);
    if (!parsed.ok) {
      diagnostics.push({
        scope: "part",
        reason: "invalid_json",
        detail: `Part at index ${String(index)}: ${parsed.detail}`,
      });
      return;
    }
    if (!isRecord(parsed.value)) {
      diagnostics.push({
        scope: "part",
        reason: "invalid_part",
        detail: `Part at index ${String(index)} is not an object`,
      });
      return;
    }
    const partRecord = parsed.value;
    const messageId = firstString(partRecord, ["messageID", "messageId", "msgId"]);
    if (messageId === null) {
      diagnostics.push({
        scope: "part",
        reason: "orphan_part",
        detail: `Part at index ${String(index)} is missing messageID`,
      });
      return;
    }
    const partText = extractPartText(partRecord);
    if (partText === null) {
      diagnostics.push({
        scope: "part",
        reason: "invalid_part",
        detail: `Part at index ${String(index)} has unknown type`,
      });
      return;
    }
    const { createdMs } = extractRecordTimestamps(partRecord);
    const bucket = partsByMessageId.get(messageId) ?? [];
    bucket.push({
      id: firstString(partRecord, ["id", "partID", "partId"]),
      messageId,
      text: partText,
      timestampMs: createdMs,
      order: index,
    });
    partsByMessageId.set(messageId, bucket);
    orphanCandidates.push({ messageId, order: index });
  });

  const knownMessageIds = new Set<string>();
  const messageEntries: Array<{
    readonly id: string | null;
    readonly role: OpencodeMessageRole;
    readonly text: string;
    readonly timestampMs: number;
    readonly updatedMs: number;
    readonly order: number;
    readonly model: string | null;
    readonly directory: string | null;
    readonly sessionId: string | null;
  }> = [];

  const sessionTimes = extractRecordTimestamps(sessionRecord);
  let lastTimestampMs = sessionTimes.createdMs ?? fallbackMs;

  rawMessages.forEach((rawMsg, index) => {
    const parsed = parseJsonOrValue(rawMsg);
    if (!parsed.ok) {
      diagnostics.push({
        scope: "message",
        reason: "invalid_json",
        detail: `Message at index ${String(index)}: ${parsed.detail}`,
      });
      return;
    }
    if (!isRecord(parsed.value)) {
      diagnostics.push({
        scope: "message",
        reason: "invalid_message",
        detail: `Message at index ${String(index)} is not an object`,
      });
      return;
    }
    const msgRecord = isRecord(parsed.value.info) ? parsed.value.info : parsed.value;
    const msgId = firstString(msgRecord, ["id", "messageID", "messageId"]);
    if (msgId !== null) knownMessageIds.add(msgId);

    const role = classifyRole(msgRecord.role ?? msgRecord.speaker ?? msgRecord.author);
    if (role === "unsupported") {
      diagnostics.push({
        scope: "message",
        reason: "unsupported_role",
        detail: `Message at index ${String(index)} has unsupported role`,
      });
      return;
    }
    if (role === "unknown") {
      diagnostics.push({
        scope: "message",
        reason: "invalid_message",
        detail: `Message at index ${String(index)} has unrecognized role`,
      });
      return;
    }

    const inlineText = extractInlineMessageText(parsed.value, diagnostics);
    const attachedParts = msgId !== null ? (partsByMessageId.get(msgId) ?? []) : [];
    const sortedPartTexts = [...attachedParts]
      .sort(
        (a, b) =>
          (a.timestampMs ?? Number.MAX_SAFE_INTEGER) - (b.timestampMs ?? Number.MAX_SAFE_INTEGER) ||
          a.order - b.order,
      )
      .map((part) => part.text)
      .filter((text) => text.length > 0);

    const combinedText = [inlineText, ...sortedPartTexts]
      .filter((chunk) => chunk.length > 0)
      .join("\n")
      .trim();

    if (combinedText.length === 0) {
      diagnostics.push({
        scope: "message",
        reason: "empty_message",
        detail: `Message ${msgId ?? String(index)} has no text content`,
      });
      return;
    }

    const msgTimes = extractRecordTimestamps(msgRecord);
    const earliestPartMs = attachedParts.reduce<number | null>(
      (min, part) =>
        part.timestampMs === null
          ? min
          : min === null
            ? part.timestampMs
            : Math.min(min, part.timestampMs),
      null,
    );
    const timestampMs = msgTimes.createdMs ?? earliestPartMs ?? lastTimestampMs;
    const updatedMs = Math.max(timestampMs, msgTimes.updatedMs ?? timestampMs);
    lastTimestampMs = timestampMs;

    messageEntries.push({
      id: msgId,
      role,
      text: combinedText,
      timestampMs,
      updatedMs,
      order: index,
      model: extractModel(msgRecord),
      directory: extractDirectory(msgRecord),
      sessionId: firstString(msgRecord, ["sessionID", "sessionId"]),
    });
  });

  for (const candidate of orphanCandidates) {
    if (candidate.messageId !== null && !knownMessageIds.has(candidate.messageId)) {
      diagnostics.push({
        scope: "part",
        reason: "orphan_part",
        detail: `Part at index ${String(candidate.order)} references unknown messageID ${candidate.messageId}`,
      });
    }
  }

  const seenKeys = new Set<string>();
  const sortedMessages = [...messageEntries]
    .sort((a, b) => a.timestampMs - b.timestampMs || a.order - b.order)
    .filter((entry) => {
      const key =
        entry.id !== null
          ? `id:${entry.id}`
          : `msg:${entry.role}:${String(entry.timestampMs)}:${entry.text}`;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

  if (sortedMessages.length === 0) {
    diagnostics.push({
      scope: "session",
      reason: "empty_session",
      detail: "OpenCode session contains no importable messages",
    });
    return { thread: null, diagnostics };
  }

  const sessionId =
    firstString(sessionRecord, ["id", "sessionID", "sessionId"]) ??
    sortedMessages.find((m) => m.sessionId !== null)?.sessionId ??
    nonEmptyString(input.fallbackSessionId) ??
    "opencode-session";

  const directory =
    extractDirectory(sessionRecord) ??
    extractDirectory(rootRecord) ??
    sortedMessages.find((m) => m.directory !== null)?.directory ??
    null;

  const model =
    extractModel(sessionRecord) ??
    extractModel(rootRecord) ??
    sortedMessages.find((m) => m.role === "assistant" && m.model !== null)?.model ??
    sortedMessages.find((m) => m.model !== null)?.model ??
    null;

  const messages: ReadonlyArray<OpencodeImportedMessage> = sortedMessages.map((entry) => ({
    id: entry.id,
    role: entry.role,
    text: entry.text,
    createdAt: formatEpochIso(entry.timestampMs),
  }));

  const firstMsgMs = sortedMessages[0]?.timestampMs ?? fallbackMs;
  const lastMsgMs = sortedMessages.reduce(
    (max, entry) => Math.max(max, entry.updatedMs),
    firstMsgMs,
  );
  const createdMs =
    sessionTimes.createdMs !== null ? Math.min(sessionTimes.createdMs, firstMsgMs) : firstMsgMs;
  const updatedMs = Math.max(createdMs, lastMsgMs, sessionTimes.updatedMs ?? lastMsgMs);

  const title = deriveTitle(sessionRecord, messages, `OpenCode ${sessionId}`);

  return {
    thread: {
      sessionId,
      directory,
      title,
      model,
      createdAt: formatEpochIso(createdMs),
      updatedAt: formatEpochIso(updatedMs),
      messages,
    },
    diagnostics,
  };
}

export function parseOpencodeSessions(
  inputs: ReadonlyArray<ParseOpencodeSessionInput>,
): ParseOpencodeSessionsResult {
  const threads: OpencodeImportedThread[] = [];
  const diagnostics: OpencodeImportDiagnostic[] = [];
  for (const input of inputs) {
    const result = parseOpencodeSession(input);
    if (result.thread !== null) threads.push(result.thread);
    diagnostics.push(...result.diagnostics);
  }
  return { threads, diagnostics };
}

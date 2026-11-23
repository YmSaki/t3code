import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export type CursorMessageRole = "user" | "assistant";

export interface CursorImportedMessage {
  readonly id: string | null;
  readonly role: CursorMessageRole;
  readonly text: string;
  readonly createdAt: string;
}

export interface CursorImportedThread {
  readonly sessionId: string;
  readonly sourceKey: string;
  readonly title: string;
  readonly model: string | null;
  readonly workspacePath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<CursorImportedMessage>;
}

export type CursorImportDiagnosticReason =
  | "invalid_json"
  | "invalid_workspace"
  | "unknown_key"
  | "invalid_container"
  | "invalid_thread"
  | "empty_thread"
  | "invalid_message"
  | "empty_message"
  | "missing_bubble";

export interface CursorImportDiagnostic {
  readonly key: string;
  readonly reason: CursorImportDiagnosticReason;
  readonly detail: string;
}

export interface CursorKvEntry {
  readonly key: string;
  readonly value: unknown;
}

export interface CursorWorkspaceParseResult {
  readonly workspacePath: string | null;
  readonly rawFolderUri: string | null;
  readonly remoteDistro: string | null;
  readonly diagnostics: ReadonlyArray<CursorImportDiagnostic>;
}

export interface ParseCursorStateInput {
  readonly workspaceJson?: string | unknown | undefined;
  readonly entries: ReadonlyArray<CursorKvEntry>;
  readonly fallbackTimestamp?: string | undefined;
}

export interface ParseCursorStateResult {
  readonly workspacePath: string | null;
  readonly threads: ReadonlyArray<CursorImportedThread>;
  readonly diagnostics: ReadonlyArray<CursorImportDiagnostic>;
}

type JsonRecord = Readonly<Record<string, unknown>>;

const DEFAULT_FALLBACK_ISO = "1970-01-01T00:00:00.000Z";
const SECONDS_THRESHOLD = 1e11;
const NUMERIC_TIMESTAMP = /^\d+(?:\.\d+)?$/;
const URI_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/;
const DRIVE_URI_PATH = /^\/([a-zA-Z]):(?:\/(.*))?$/;
const USER_ROLES = new Set(["user", "human", "you"]);
const ASSISTANT_ROLES = new Set(["assistant", "ai", "model", "bot", "agent"]);
const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);

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

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveWorkspaceFolderUri(rawUriOrPath: string): {
  readonly workspacePath: string;
  readonly remoteDistro: string | null;
} {
  const trimmed = rawUriOrPath.trim();
  const match = URI_PATTERN.exec(trimmed);
  if (!match) {
    return { workspacePath: trimmed, remoteDistro: null };
  }
  const scheme = (match[1] ?? "").toLowerCase();
  const authority = safeDecodeUriComponent(match[2] ?? "");
  const pathname = safeDecodeUriComponent(match[3] ?? "");

  if (scheme === "file") {
    if (authority.length > 0 && authority.toLowerCase() !== "localhost") {
      return {
        workspacePath: `\\\\${authority}${pathname.replaceAll("/", "\\")}`,
        remoteDistro: null,
      };
    }
    const drive = DRIVE_URI_PATH.exec(pathname);
    if (drive) {
      const driveLetter = (drive[1] ?? "").toUpperCase();
      const rest = (drive[2] ?? "").replaceAll("/", "\\");
      return {
        workspacePath: `${driveLetter}:\\${rest}`,
        remoteDistro: null,
      };
    }
    return { workspacePath: pathname, remoteDistro: null };
  }

  if (scheme === "vscode-remote") {
    const plusIndex = authority.indexOf("+");
    if (plusIndex > 0) {
      const remoteKind = authority.slice(0, plusIndex).toLowerCase();
      const remoteTarget = authority.slice(plusIndex + 1);
      if (remoteKind === "wsl" && remoteTarget.length > 0) {
        return {
          workspacePath: pathname.length > 0 ? pathname : "/",
          remoteDistro: remoteTarget,
        };
      }
    }
  }

  return {
    workspacePath: pathname.length > 0 ? pathname : trimmed,
    remoteDistro: null,
  };
}

export function parseCursorWorkspaceJson(
  rawJsonOrValue: string | unknown,
): CursorWorkspaceParseResult {
  const diagnostics: CursorImportDiagnostic[] = [];
  if (rawJsonOrValue === undefined || rawJsonOrValue === null) {
    return { workspacePath: null, rawFolderUri: null, remoteDistro: null, diagnostics };
  }
  const parsed = parseJsonOrValue(rawJsonOrValue);
  if (!parsed.ok) {
    diagnostics.push({
      key: "workspace.json",
      reason: "invalid_json",
      detail: parsed.detail,
    });
    return { workspacePath: null, rawFolderUri: null, remoteDistro: null, diagnostics };
  }
  if (!isRecord(parsed.value)) {
    diagnostics.push({
      key: "workspace.json",
      reason: "invalid_workspace",
      detail: "workspace.json root must be an object",
    });
    return { workspacePath: null, rawFolderUri: null, remoteDistro: null, diagnostics };
  }

  let candidate = firstString(parsed.value, ["folder", "workspace", "path"]);
  if (candidate === null && Array.isArray(parsed.value.folders)) {
    for (const folderEntry of parsed.value.folders) {
      if (typeof folderEntry === "string" && folderEntry.trim().length > 0) {
        candidate = folderEntry.trim();
        break;
      }
      if (isRecord(folderEntry)) {
        const nested = firstString(folderEntry, ["uri", "path", "folder"]);
        if (nested !== null) {
          candidate = nested;
          break;
        }
      }
    }
  }

  if (candidate === null) {
    diagnostics.push({
      key: "workspace.json",
      reason: "invalid_workspace",
      detail: "workspace.json does not contain a non-empty folder or folders entry",
    });
    return { workspacePath: null, rawFolderUri: null, remoteDistro: null, diagnostics };
  }

  const resolved = resolveWorkspaceFolderUri(candidate);
  return {
    workspacePath: resolved.workspacePath,
    rawFolderUri: candidate,
    remoteDistro: resolved.remoteDistro,
    diagnostics,
  };
}

function parseCursorRole(record: JsonRecord): CursorMessageRole | null {
  const rawRole = record.role ?? record.speaker ?? record.sender ?? record.author;
  if (typeof rawRole === "string") {
    const normalized = rawRole.trim().toLowerCase();
    if (USER_ROLES.has(normalized)) return "user";
    if (ASSISTANT_ROLES.has(normalized)) return "assistant";
  }
  const rawType = record.type;
  if (rawType === 1 || rawType === "1") return "user";
  if (rawType === 2 || rawType === "2") return "assistant";
  if (typeof rawType === "string") {
    const normalized = rawType.trim().toLowerCase();
    if (USER_ROLES.has(normalized)) return "user";
    if (ASSISTANT_ROLES.has(normalized)) return "assistant";
  }
  return null;
}

function extractTextValue(value: unknown): string {
  if (typeof value === "string") return value.replaceAll("\r\n", "\n").trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => extractTextValue(part))
      .filter((text) => text.length > 0)
      .join("\n")
      .trim();
  }
  if (isRecord(value)) {
    const partType = value.type;
    if (typeof partType === "string" && !TEXT_PART_TYPES.has(partType)) return "";
    if (typeof value.text === "string") return extractTextValue(value.text);
    if (value.content !== undefined) return extractTextValue(value.content);
  }
  return "";
}

function extractBubbleText(record: JsonRecord): string {
  for (const field of ["text", "rawText", "content", "message", "delegate", "initText"]) {
    const value = record[field];
    if (isRecord(value) && typeof value.a === "string") {
      const delegateText = value.a.replaceAll("\r\n", "\n").trim();
      if (delegateText.length > 0) return delegateText;
    }
    const extracted = extractTextValue(value);
    if (extracted.length > 0) return extracted;
  }
  return "";
}

function extractModelFromRecord(record: JsonRecord): string | null {
  const direct = firstString(record, ["model", "modelName", "modelId", "selectedModel"]);
  if (direct !== null) return direct;
  if (isRecord(record.modelConfig)) {
    const configModel = firstString(record.modelConfig, ["modelName", "model", "id"]);
    if (configModel !== null) return configModel;
  }
  if (isRecord(record.modelInfo)) {
    const infoModel = firstString(record.modelInfo, ["modelName", "model", "name"]);
    if (infoModel !== null) return infoModel;
  }
  return null;
}

function deriveThreadTitle(
  record: JsonRecord,
  messages: ReadonlyArray<CursorImportedMessage>,
  fallbackTitle: string,
): string {
  const explicit = firstString(record, ["name", "title", "chatTitle", "subtitle"]);
  if (explicit !== null) return explicit;
  const firstUser = messages.find((message) => message.role === "user");
  const firstLine = firstUser?.text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return fallbackTitle;
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

interface RawMessageCandidate {
  readonly id: string | null;
  readonly role: CursorMessageRole;
  readonly text: string;
  readonly timestampMs: number;
  readonly order: number;
}

function normalizeThreadMessages(
  rawBubbles: ReadonlyArray<unknown>,
  sourceKey: string,
  fallbackMs: number,
  diagnostics: CursorImportDiagnostic[],
): ReadonlyArray<CursorImportedMessage> {
  const candidates: RawMessageCandidate[] = [];
  const seen = new Set<string>();
  let lastMs = fallbackMs;

  rawBubbles.forEach((rawBubble, index) => {
    if (!isRecord(rawBubble)) {
      diagnostics.push({
        key: sourceKey,
        reason: "invalid_message",
        detail: `Bubble at index ${String(index)} is not an object`,
      });
      return;
    }
    const role = parseCursorRole(rawBubble);
    if (role === null) {
      diagnostics.push({
        key: sourceKey,
        reason: "invalid_message",
        detail: `Bubble at index ${String(index)} has unrecognized role or type`,
      });
      return;
    }
    const text = extractBubbleText(rawBubble);
    if (text.length === 0) {
      diagnostics.push({
        key: sourceKey,
        reason: "empty_message",
        detail: `Bubble at index ${String(index)} has empty text`,
      });
      return;
    }
    const id = firstString(rawBubble, ["bubbleId", "id", "messageId"]);
    const parsedMs =
      parseTimestampMs(rawBubble.createdAt) ??
      parseTimestampMs(rawBubble.timestamp) ??
      parseTimestampMs(rawBubble.time) ??
      parseTimestampMs(
        rawBubble.timingInfo && isRecord(rawBubble.timingInfo)
          ? rawBubble.timingInfo.clientStartTime
          : null,
      );
    const timestampMs = parsedMs ?? lastMs;
    lastMs = timestampMs;

    const dedupeKey = id !== null ? `id:${id}` : `msg:${role}:${String(timestampMs)}:${text}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    candidates.push({
      id,
      role,
      text,
      timestampMs,
      order: index,
    });
  });

  return candidates
    .sort((a, b) => a.timestampMs - b.timestampMs || a.order - b.order)
    .map((candidate) => ({
      id: candidate.id,
      role: candidate.role,
      text: candidate.text,
      createdAt: formatEpochIso(candidate.timestampMs),
    }));
}

const KNOWN_CHAT_KEYS = new Set([
  "composer.composerData",
  "workbench.panel.aichat.view.aichat.chatdata",
  "aichat.chatdata",
]);

function extractBubbleKeyParts(key: string): {
  readonly composerId: string;
  readonly bubbleId: string;
} | null {
  const prefixes = ["bubbleId:", "bubble:"];
  for (const prefix of prefixes) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const separator = rest.indexOf(":");
    if (separator <= 0 || separator >= rest.length - 1) return null;
    return {
      composerId: rest.slice(0, separator),
      bubbleId: rest.slice(separator + 1),
    };
  }
  return null;
}

export function parseCursorStateDb(input: ParseCursorStateInput): ParseCursorStateResult {
  const fallbackMs =
    parseTimestampMs(input.fallbackTimestamp) ?? parseTimestampMs(DEFAULT_FALLBACK_ISO) ?? 0;
  const workspaceResult = parseCursorWorkspaceJson(input.workspaceJson);
  const diagnostics: CursorImportDiagnostic[] = [...workspaceResult.diagnostics];
  const workspacePath = workspaceResult.workspacePath;

  const bubbleMap = new Map<string, JsonRecord>();
  const composerDiskMap = new Map<string, { readonly key: string; readonly record: JsonRecord }>();
  const composerHeaderRecords: Array<{ readonly key: string; readonly record: JsonRecord }> = [];
  const aichatRecords: Array<{ readonly key: string; readonly record: JsonRecord }> = [];

  for (const entry of input.entries) {
    const bubbleParts = extractBubbleKeyParts(entry.key);
    if (bubbleParts !== null) {
      const parsed = parseJsonOrValue(entry.value);
      if (!parsed.ok) {
        diagnostics.push({ key: entry.key, reason: "invalid_json", detail: parsed.detail });
        continue;
      }
      if (!isRecord(parsed.value)) {
        diagnostics.push({
          key: entry.key,
          reason: "invalid_message",
          detail: "Bubble KV entry is not an object",
        });
        continue;
      }
      bubbleMap.set(`${bubbleParts.composerId}:${bubbleParts.bubbleId}`, parsed.value);
      continue;
    }

    if (entry.key.startsWith("composerData:")) {
      const composerId = entry.key.slice("composerData:".length).trim();
      const parsed = parseJsonOrValue(entry.value);
      if (!parsed.ok) {
        diagnostics.push({ key: entry.key, reason: "invalid_json", detail: parsed.detail });
        continue;
      }
      if (!isRecord(parsed.value)) {
        diagnostics.push({
          key: entry.key,
          reason: "invalid_thread",
          detail: "composerData entry is not an object",
        });
        continue;
      }
      if (composerId.length > 0) {
        composerDiskMap.set(composerId, { key: entry.key, record: parsed.value });
      }
      continue;
    }

    if (!KNOWN_CHAT_KEYS.has(entry.key)) {
      diagnostics.push({
        key: entry.key,
        reason: "unknown_key",
        detail: `Unrecognized Cursor state key: ${entry.key}`,
      });
      continue;
    }

    const parsed = parseJsonOrValue(entry.value);
    if (!parsed.ok) {
      diagnostics.push({ key: entry.key, reason: "invalid_json", detail: parsed.detail });
      continue;
    }

    if (entry.key === "composer.composerData") {
      if (!isRecord(parsed.value)) {
        diagnostics.push({
          key: entry.key,
          reason: "invalid_container",
          detail: "composer.composerData must be an object",
        });
        continue;
      }
      const list = Array.isArray(parsed.value.allComposers)
        ? parsed.value.allComposers
        : Array.isArray(parsed.value.composers)
          ? parsed.value.composers
          : null;
      if (list === null) {
        diagnostics.push({
          key: entry.key,
          reason: "invalid_container",
          detail: "composer.composerData has no allComposers or composers array",
        });
        continue;
      }
      list.forEach((item, idx) => {
        if (!isRecord(item)) {
          diagnostics.push({
            key: entry.key,
            reason: "invalid_thread",
            detail: `Composer entry at index ${String(idx)} is not an object`,
          });
          return;
        }
        composerHeaderRecords.push({ key: entry.key, record: item });
      });
      continue;
    }

    if (!isRecord(parsed.value)) {
      diagnostics.push({
        key: entry.key,
        reason: "invalid_container",
        detail: `${entry.key} must be an object`,
      });
      continue;
    }
    const tabs = Array.isArray(parsed.value.tabs)
      ? parsed.value.tabs
      : Array.isArray(parsed.value.chats)
        ? parsed.value.chats
        : Array.isArray(parsed.value.conversations)
          ? parsed.value.conversations
          : null;
    if (tabs === null) {
      diagnostics.push({
        key: entry.key,
        reason: "invalid_container",
        detail: `${entry.key} has no tabs, chats, or conversations array`,
      });
      continue;
    }
    tabs.forEach((tab, idx) => {
      if (!isRecord(tab)) {
        diagnostics.push({
          key: entry.key,
          reason: "invalid_thread",
          detail: `Chat tab at index ${String(idx)} is not an object`,
        });
        return;
      }
      aichatRecords.push({ key: entry.key, record: tab });
    });
  }

  const threadsById = new Map<string, CursorImportedThread>();
  const processedComposerIds = new Set<string>();

  const buildComposerThread = (
    composerId: string,
    sourceKey: string,
    headerRecord: JsonRecord | null,
    diskRecord: JsonRecord | null,
  ) => {
    const primary = diskRecord ?? headerRecord ?? {};
    const secondary = headerRecord ?? diskRecord ?? {};
    const mergedMeta: JsonRecord = { ...secondary, ...primary };

    const rawBubbles: unknown[] = [];
    const inlineConversation = Array.isArray(primary.conversation)
      ? primary.conversation
      : Array.isArray(primary.messages)
        ? primary.messages
        : Array.isArray(primary.bubbles)
          ? primary.bubbles
          : Array.isArray(secondary.conversation)
            ? secondary.conversation
            : Array.isArray(secondary.messages)
              ? secondary.messages
              : Array.isArray(secondary.bubbles)
                ? secondary.bubbles
                : null;

    if (inlineConversation !== null && inlineConversation.length > 0) {
      for (const item of inlineConversation) {
        if (isRecord(item) && extractBubbleText(item).length === 0) {
          const refBubbleId = firstString(item, ["bubbleId", "id"]);
          if (refBubbleId !== null) {
            const diskBubble = bubbleMap.get(`${composerId}:${refBubbleId}`);
            if (diskBubble !== undefined) {
              rawBubbles.push({ ...item, ...diskBubble });
              continue;
            }
          }
        }
        rawBubbles.push(item);
      }
    } else {
      const headers = Array.isArray(primary.fullConversationHeadersOnly)
        ? primary.fullConversationHeadersOnly
        : Array.isArray(secondary.fullConversationHeadersOnly)
          ? secondary.fullConversationHeadersOnly
          : null;
      if (headers !== null) {
        for (const header of headers) {
          if (!isRecord(header)) {
            rawBubbles.push(header);
            continue;
          }
          const bubbleId = firstString(header, ["bubbleId", "id"]);
          if (bubbleId === null) {
            diagnostics.push({
              key: sourceKey,
              reason: "invalid_message",
              detail: `Header in composer ${composerId} is missing bubbleId`,
            });
            continue;
          }
          const diskBubble = bubbleMap.get(`${composerId}:${bubbleId}`);
          if (diskBubble === undefined) {
            diagnostics.push({
              key: sourceKey,
              reason: "missing_bubble",
              detail: `Missing bubble ${bubbleId} for composer ${composerId}`,
            });
            continue;
          }
          rawBubbles.push({ ...header, ...diskBubble });
        }
      }
    }

    const threadCreatedMs =
      parseTimestampMs(primary.createdAt) ??
      parseTimestampMs(secondary.createdAt) ??
      parseTimestampMs(primary.timestamp) ??
      fallbackMs;

    const messages = normalizeThreadMessages(rawBubbles, sourceKey, threadCreatedMs, diagnostics);
    if (messages.length === 0) {
      diagnostics.push({
        key: sourceKey,
        reason: "empty_thread",
        detail: `Composer ${composerId} has no importable messages`,
      });
      return;
    }

    const firstMessageMs = parseTimestampMs(messages[0]?.createdAt) ?? threadCreatedMs;
    const lastMessageMs = parseTimestampMs(messages.at(-1)?.createdAt) ?? firstMessageMs;
    const createdMs = Math.min(threadCreatedMs, firstMessageMs);
    const explicitUpdatedMs =
      parseTimestampMs(primary.lastUpdatedAt) ??
      parseTimestampMs(primary.updatedAt) ??
      parseTimestampMs(secondary.lastUpdatedAt) ??
      parseTimestampMs(secondary.updatedAt);
    const updatedMs = Math.max(createdMs, lastMessageMs, explicitUpdatedMs ?? lastMessageMs);

    const model = extractModelFromRecord(primary) ?? extractModelFromRecord(secondary);
    const title = deriveThreadTitle(mergedMeta, messages, `Cursor Composer ${composerId}`);

    threadsById.set(composerId, {
      sessionId: composerId,
      sourceKey,
      title,
      model,
      workspacePath,
      createdAt: formatEpochIso(createdMs),
      updatedAt: formatEpochIso(updatedMs),
      messages,
    });
  };

  composerHeaderRecords.forEach(({ key, record }, index) => {
    const composerId =
      firstString(record, ["composerId", "id", "sessionId"]) ?? `composer-${String(index + 1)}`;
    processedComposerIds.add(composerId);
    const diskEntry = composerDiskMap.get(composerId);
    buildComposerThread(composerId, diskEntry?.key ?? key, record, diskEntry?.record ?? null);
  });

  for (const [composerId, diskEntry] of composerDiskMap.entries()) {
    if (processedComposerIds.has(composerId)) continue;
    buildComposerThread(composerId, diskEntry.key, null, diskEntry.record);
  }

  aichatRecords.forEach(({ key, record }, index) => {
    const sessionId =
      firstString(record, ["tabId", "id", "chatId", "sessionId"]) ?? `aichat-${String(index + 1)}`;
    if (threadsById.has(sessionId)) return;
    const rawBubbles = Array.isArray(record.bubbles)
      ? record.bubbles
      : Array.isArray(record.messages)
        ? record.messages
        : Array.isArray(record.conversation)
          ? record.conversation
          : [];
    const tabCreatedMs =
      parseTimestampMs(record.createdAt) ??
      parseTimestampMs(record.timestamp) ??
      parseTimestampMs(record.lastSendTime) ??
      fallbackMs;
    const messages = normalizeThreadMessages(rawBubbles, key, tabCreatedMs, diagnostics);
    if (messages.length === 0) {
      diagnostics.push({
        key,
        reason: "empty_thread",
        detail: `AI Chat tab ${sessionId} has no importable messages`,
      });
      return;
    }
    const firstMessageMs = parseTimestampMs(messages[0]?.createdAt) ?? tabCreatedMs;
    const lastMessageMs = parseTimestampMs(messages.at(-1)?.createdAt) ?? firstMessageMs;
    const createdMs = Math.min(tabCreatedMs, firstMessageMs);
    const explicitUpdatedMs =
      parseTimestampMs(record.lastSendTime) ??
      parseTimestampMs(record.updatedAt) ??
      parseTimestampMs(record.lastUpdatedAt);
    const updatedMs = Math.max(createdMs, lastMessageMs, explicitUpdatedMs ?? lastMessageMs);

    threadsById.set(sessionId, {
      sessionId,
      sourceKey: key,
      title: deriveThreadTitle(record, messages, `Cursor Chat ${sessionId}`),
      model: extractModelFromRecord(record),
      workspacePath,
      createdAt: formatEpochIso(createdMs),
      updatedAt: formatEpochIso(updatedMs),
      messages,
    });
  });

  const threads = [...threadsById.values()].sort(
    (a, b) =>
      (parseTimestampMs(a.createdAt) ?? 0) - (parseTimestampMs(b.createdAt) ?? 0) ||
      a.sessionId.localeCompare(b.sessionId),
  );

  return {
    workspacePath,
    threads,
    diagnostics,
  };
}

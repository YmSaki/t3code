import * as DateTime from "effect/DateTime";

import { isUncPath, isWindowsDrivePath, stripSlashPrefixedWindowsDrive } from "./path.ts";

export interface ImportPathKey {
  /** Lower-cased WSL distro when the path was a `\\wsl$\<distro>` share, otherwise null. */
  readonly distro: string | null;
  readonly path: string;
}

const WSL_SHARE_PATTERN =
  /^[\\/]{2}(?:[?.][\\/]UNC[\\/])?wsl(?:\.localhost|\$)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/i;
const WSL_DRIVE_MOUNT_PATTERN = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/;

function collapseSegments(segments: ReadonlyArray<string>, absolute: boolean): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      const last = out.at(-1);
      if (last !== undefined && last !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  return out;
}

function normalizeWindowsDrivePath(value: string): string {
  const slashed = value.replaceAll("\\", "/").toLowerCase();
  const drive = slashed.slice(0, 2);
  const segments = collapseSegments(slashed.slice(2).split("/"), true);
  return segments.length === 0 ? `${drive}/` : `${drive}/${segments.join("/")}`;
}

function normalizeUncPath(value: string): string {
  const segments = collapseSegments(value.replaceAll("\\", "/").toLowerCase().split("/"), true);
  return `//${segments.join("/")}`;
}

function normalizePosixPath(value: string): string {
  const absolute = value.startsWith("/");
  const segments = collapseSegments(value.split("/"), absolute);
  const joined = segments.join("/");
  return absolute ? `/${joined}` : joined;
}

function normalizeNonWslPath(value: string): string {
  const unprefixed = stripSlashPrefixedWindowsDrive(value);
  if (isWindowsDrivePath(unprefixed)) return normalizeWindowsDrivePath(unprefixed);
  if (isUncPath(unprefixed)) return normalizeUncPath(unprefixed);
  const posix = normalizePosixPath(unprefixed);
  const mount = WSL_DRIVE_MOUNT_PATTERN.exec(posix);
  if (mount) {
    const drive = mount[1] ?? "";
    return normalizeWindowsDrivePath(`${drive}:/${mount[2] ?? ""}`);
  }
  return posix;
}

/**
 * Comparison key for a project directory taken from an imported CLI's storage. Windows drive and
 * UNC paths compare case-insensitively with `/` separators, `\\wsl$\<distro>\x` and
 * `\\wsl.localhost\<distro>\x` collapse to `/x`, and `/mnt/c/x` collapses to `c:/x`.
 */
export function toImportPathKey(value: string): ImportPathKey {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { distro: null, path: "" };
  const wsl = WSL_SHARE_PATTERN.exec(trimmed);
  if (wsl) {
    const distro = (wsl[1] ?? "").toLowerCase();
    const linuxPath = `/${(wsl[2] ?? "").replaceAll("\\", "/")}`;
    return { distro, path: normalizeNonWslPath(linuxPath) };
  }
  return { distro: null, path: normalizeNonWslPath(trimmed) };
}

/** Distro-agnostic string key, suitable for grouping imported sessions by directory. */
export function importPathComparisonKey(value: string): string {
  return toImportPathKey(value).path;
}

export function isSameImportDirectory(left: string, right: string): boolean {
  const a = toImportPathKey(left);
  const b = toImportPathKey(right);
  if (a.path.length === 0 || b.path.length === 0) return false;
  if (a.path !== b.path) return false;
  return a.distro === null || b.distro === null || a.distro === b.distro;
}

export type ImportMessageRole = "user" | "assistant";

export type ImportSkipReason =
  | "not_an_object"
  | "empty_text"
  | "unknown_role"
  | "unsupported_role"
  | "duplicate";

export interface RawImportMessage {
  readonly role?: unknown;
  readonly text?: unknown;
  readonly createdAt?: unknown;
}

export interface NormalizedImportMessage {
  readonly role: ImportMessageRole;
  readonly text: string;
  readonly createdAt: string;
}

export interface ImportSkippedRecord {
  readonly index: number;
  readonly reason: ImportSkipReason;
}

export interface ImportReasonCount {
  readonly reason: string;
  readonly count: number;
}

export interface ImportDiagnosticSummary {
  readonly totalRecords: number;
  readonly importedCount: number;
  readonly skippedCount: number;
  readonly repairedTimestampCount: number;
  readonly byReason: ReadonlyArray<ImportReasonCount>;
}

export interface NormalizeImportMessagesOptions {
  /** Used for messages that have no usable timestamp and no earlier message to inherit from. */
  readonly fallbackCreatedAt: string;
}

export interface NormalizeImportMessagesResult {
  readonly messages: ReadonlyArray<NormalizedImportMessage>;
  readonly skipped: ReadonlyArray<ImportSkippedRecord>;
  readonly summary: ImportDiagnosticSummary;
}

const USER_ROLE_ALIASES = new Set(["user", "human", "you"]);
const ASSISTANT_ROLE_ALIASES = new Set(["assistant", "ai", "model", "bot", "agent", "gemini"]);
const UNSUPPORTED_ROLE_ALIASES = new Set(["system", "tool", "function", "developer"]);

// Below this a numeric timestamp is in epoch seconds; above it, milliseconds (1e11 ms is 1973).
const SECONDS_THRESHOLD = 1e11;

const NUMERIC_TIMESTAMP = /^\d+(?:\.\d+)?$/;

function scaleEpoch(value: number): number {
  return value < SECONDS_THRESHOLD ? value * 1000 : value;
}

/** Epoch milliseconds from an ISO string, epoch seconds or milliseconds (number or numeric string). */
export function parseImportTimestampMs(value: unknown): number | null {
  let ms: number;
  if (typeof value === "number") {
    ms = scaleEpoch(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    ms = NUMERIC_TIMESTAMP.test(trimmed) ? scaleEpoch(Number(trimmed)) : Date.parse(trimmed);
  } else {
    return null;
  }
  if (!Number.isFinite(ms) || ms <= 0 || ms > 8_640_000_000_000_000) return null;
  return Math.trunc(ms);
}

export function normalizeImportRole(value: unknown): ImportMessageRole | "unsupported" | "unknown" {
  if (typeof value !== "string") return "unknown";
  const key = value.trim().toLowerCase();
  if (USER_ROLE_ALIASES.has(key)) return "user";
  if (ASSISTANT_ROLE_ALIASES.has(key)) return "assistant";
  if (UNSUPPORTED_ROLE_ALIASES.has(key)) return "unsupported";
  return "unknown";
}

function countImportReasons(reasons: Iterable<string>): ReadonlyArray<ImportReasonCount> {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export function buildImportDiagnosticSummary(input: {
  readonly totalRecords: number;
  readonly importedCount: number;
  readonly skippedReasons: Iterable<string>;
  readonly repairedTimestampCount?: number | undefined;
}): ImportDiagnosticSummary {
  const byReason = countImportReasons(input.skippedReasons);
  return {
    totalRecords: input.totalRecords,
    importedCount: input.importedCount,
    skippedCount: byReason.reduce((total, entry) => total + entry.count, 0),
    repairedTimestampCount: input.repairedTimestampCount ?? 0,
    byReason,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Cleans an imported conversation: absorbs role spelling variants, drops empty and unsupported
 * records, repairs missing timestamps, orders by time (input order breaks ties) and removes exact
 * duplicates. Every dropped record is reported with its input index and reason.
 */
export function normalizeImportMessages(
  records: ReadonlyArray<unknown>,
  options: NormalizeImportMessagesOptions,
): NormalizeImportMessagesResult {
  const fallbackMs = parseImportTimestampMs(options.fallbackCreatedAt) ?? 0;
  const skipped: ImportSkippedRecord[] = [];
  const kept: Array<{
    readonly role: ImportMessageRole;
    readonly text: string;
    readonly ms: number;
    readonly order: number;
  }> = [];
  const seen = new Set<string>();
  let previousMs: number | null = null;
  let repairedTimestampCount = 0;

  records.forEach((record, index) => {
    if (!isObject(record)) {
      skipped.push({ index, reason: "not_an_object" });
      return;
    }
    const role = normalizeImportRole(record.role);
    if (role === "unsupported" || role === "unknown") {
      skipped.push({ index, reason: role === "unsupported" ? "unsupported_role" : "unknown_role" });
      return;
    }
    const text = typeof record.text === "string" ? record.text.replaceAll("\r\n", "\n").trim() : "";
    if (text.length === 0) {
      skipped.push({ index, reason: "empty_text" });
      return;
    }
    let ms = parseImportTimestampMs(record.createdAt);
    if (ms === null) {
      ms = previousMs ?? fallbackMs;
      repairedTimestampCount += 1;
    }
    const key = `${role}\u0000${ms}\u0000${text}`;
    if (seen.has(key)) {
      skipped.push({ index, reason: "duplicate" });
      return;
    }
    seen.add(key);
    previousMs = ms;
    kept.push({ role, text, ms, order: index });
  });

  const messages = [...kept]
    .sort((a, b) => a.ms - b.ms || a.order - b.order)
    .map((entry): NormalizedImportMessage => ({
      role: entry.role,
      text: entry.text,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(entry.ms)),
    }));

  return {
    messages,
    skipped,
    summary: buildImportDiagnosticSummary({
      totalRecords: records.length,
      importedCount: messages.length,
      skippedReasons: skipped.map((entry) => entry.reason),
      repairedTimestampCount,
    }),
  };
}

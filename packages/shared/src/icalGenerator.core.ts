import * as DateTime from "effect/DateTime";

import { formatAgentSummaryTitle, getAgentShortCode } from "./worklogLayout.core.ts";
import type {
  WorklogCoreEntryStatus,
  WorklogCoreSource,
  WorklogCoreStats,
  WorklogCoreThreadRole,
} from "./worklogGrouping.core.ts";

export const ICAL_MAX_LINE_OCTETS = 75;
const ICAL_CRLF = "\r\n";

export interface IcalWorklogEventInput {
  readonly id: string;
  readonly provider: string;
  readonly title: string;
  readonly startedAt: string | number;
  readonly endedAt: string | number;
  readonly durationMs?: number | undefined;
  readonly turnCount?: number | undefined;
  readonly status?: WorklogCoreEntryStatus | undefined;
  readonly source?: WorklogCoreSource | undefined;
  readonly threadRole?: WorklogCoreThreadRole | undefined;
  readonly projectTitle?: string | undefined;
  readonly summary?: string | undefined;
  readonly stats?: WorklogCoreStats | undefined;
  readonly threadUrl?: string | undefined;
  readonly categories?: ReadonlyArray<string> | undefined;
}

export interface IcalFeedGenerationOptions {
  readonly calendarName?: string | undefined;
  readonly prodId?: string | undefined;
  readonly timeZone?: string | undefined;
  readonly generatedAt?: string | number | undefined;
  readonly uidDomain?: string | undefined;
  readonly includeStatsInDescription?: boolean | undefined;
  readonly includeThreadUrl?: boolean | undefined;
}

function utf8ByteLengthOfCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined) {
      bytes += utf8ByteLengthOfCodePoint(codePoint);
    }
  }
  return bytes;
}

export function escapeIcalText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

export function foldIcalLine(line: string, maxOctets: number = ICAL_MAX_LINE_OCTETS): string {
  const effectiveMax = Math.max(8, maxOctets);
  if (utf8ByteLength(line) <= effectiveMax) {
    return line;
  }

  const physicalLines: Array<string> = [];
  let currentLine = "";
  let currentOctets = 0;

  for (const char of line) {
    const codePoint = char.codePointAt(0) ?? 0;
    const charOctets = utf8ByteLengthOfCodePoint(codePoint);

    if (currentLine.length > 0 && currentOctets + charOctets > effectiveMax) {
      physicalLines.push(currentLine);
      currentLine = ` ${char}`;
      currentOctets = 1 + charOctets;
    } else {
      currentLine += char;
      currentOctets += charOctets;
    }
  }

  if (currentLine.length > 0) {
    physicalLines.push(currentLine);
  }

  return physicalLines.join(ICAL_CRLF);
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function formatIcalUtcDateTime(timestamp: string | number): string {
  const ms = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  const safeMs = Number.isFinite(ms) ? ms : 0;
  const parts = DateTime.toPartsUtc(DateTime.makeUnsafe(safeMs));
  const year = parts.year.toString().padStart(4, "0");
  const month = pad2(parts.month);
  const day = pad2(parts.day);
  const hours = pad2(parts.hour);
  const minutes = pad2(parts.minute);
  const seconds = pad2(parts.second);
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

/** @public */
export function formatWorklogDurationLabel(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${pad2(minutes)}m ${pad2(seconds)}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${pad2(seconds)}s`;
  }
  return `${seconds}s`;
}

function buildWorklogIcalDescription(
  event: IcalWorklogEventInput,
  options?: {
    readonly includeStatsInDescription?: boolean | undefined;
    readonly includeThreadUrl?: boolean | undefined;
  },
): string {
  const includeStats = options?.includeStatsInDescription ?? true;
  const includeThreadUrl = options?.includeThreadUrl ?? true;

  const startMs =
    typeof event.startedAt === "number" ? event.startedAt : Date.parse(event.startedAt);
  const endMs = typeof event.endedAt === "number" ? event.endedAt : Date.parse(event.endedAt);
  const resolvedDurationMs =
    event.durationMs ??
    (Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0);

  const lines: Array<string> = [
    `Duration: ${formatWorklogDurationLabel(resolvedDurationMs)}`,
    `Turns: ${event.turnCount ?? 1}`,
  ];

  if (includeStats && event.stats !== undefined) {
    lines.push(
      `Changed Files: ${event.stats.changedFilesCount} (Commands: ${event.stats.commandsCount})`,
    );
    lines.push(
      `Tokens: in ${event.stats.inputTokens} / out ${event.stats.outputTokens} / cached ${event.stats.cachedTokens}`,
    );
    lines.push(`Cost: $${event.stats.estimatedCostUsd.toFixed(4)}`);
  }

  if (event.summary !== undefined && event.summary.trim().length > 0) {
    lines.push(`Summary: ${event.summary.trim()}`);
  }

  if (includeThreadUrl && event.threadUrl !== undefined && event.threadUrl.trim().length > 0) {
    lines.push(`Thread URL: ${event.threadUrl.trim()}`);
  }

  return lines.join("\n");
}

function buildCategoriesList(event: IcalWorklogEventInput): ReadonlyArray<string> {
  if (event.categories !== undefined && event.categories.length > 0) {
    return event.categories;
  }
  const items: Array<string> = [event.provider, getAgentShortCode(event.provider)];
  if (event.threadRole !== undefined) {
    items.push(event.threadRole);
  }
  if (event.source !== undefined) {
    items.push(event.source);
  }
  if (event.projectTitle !== undefined && event.projectTitle.trim().length > 0) {
    items.push(event.projectTitle.trim());
  }
  return items;
}

function mapStatusToIcalStatus(
  status: WorklogCoreEntryStatus | undefined,
): "CONFIRMED" | "TENTATIVE" | "CANCELLED" {
  if (status === "cancelled") return "CANCELLED";
  if (status === "running") return "TENTATIVE";
  return "CONFIRMED";
}

export function generateWorklogIcalFeed(
  events: ReadonlyArray<IcalWorklogEventInput>,
  options?: IcalFeedGenerationOptions,
): string {
  const prodId = options?.prodId ?? "-//T3 Code//Agent Worklog Calendar//EN";
  const calendarName = options?.calendarName ?? "T3 Code Agent Worklog";
  const uidDomain = options?.uidDomain ?? "t3.codes";
  const dtStamp = formatIcalUtcDateTime(options?.generatedAt ?? "2026-01-01T00:00:00.000Z");

  const rawLines: Array<string> = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodId}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcalText(calendarName)}`,
  ];

  if (options?.timeZone !== undefined && options.timeZone.trim().length > 0) {
    rawLines.push(`X-WR-TIMEZONE:${escapeIcalText(options.timeZone.trim())}`);
  }

  for (const event of events) {
    const summaryText = formatAgentSummaryTitle(event.provider, event.title);
    const descriptionText = buildWorklogIcalDescription(event, {
      includeStatsInDescription: options?.includeStatsInDescription,
      includeThreadUrl: options?.includeThreadUrl,
    });
    const categories = buildCategoriesList(event)
      .map((cat) => escapeIcalText(cat))
      .join(",");
    const sanitizedUidId = event.id.replace(/[^a-zA-Z0-9._:-]/g, "-");

    rawLines.push("BEGIN:VEVENT");
    rawLines.push(`UID:${sanitizedUidId}@${uidDomain}`);
    rawLines.push(`DTSTAMP:${dtStamp}`);
    rawLines.push(`DTSTART:${formatIcalUtcDateTime(event.startedAt)}`);
    rawLines.push(`DTEND:${formatIcalUtcDateTime(event.endedAt)}`);
    rawLines.push(`SUMMARY:${escapeIcalText(summaryText)}`);
    rawLines.push(`CATEGORIES:${categories}`);
    rawLines.push(`STATUS:${mapStatusToIcalStatus(event.status)}`);
    rawLines.push(`DESCRIPTION:${escapeIcalText(descriptionText)}`);

    if (
      (options?.includeThreadUrl ?? true) &&
      event.threadUrl !== undefined &&
      event.threadUrl.trim().length > 0
    ) {
      rawLines.push(`URL:${event.threadUrl.trim()}`);
    }

    rawLines.push("END:VEVENT");
  }

  rawLines.push("END:VCALENDAR");

  return `${rawLines.map((line) => foldIcalLine(line, ICAL_MAX_LINE_OCTETS)).join(ICAL_CRLF)}${ICAL_CRLF}`;
}

import * as DateTime from "effect/DateTime";

export interface LocalDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly dayKey: string;
}

const FIXED_OFFSET_PATTERN = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i;

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dtfCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    dtfCache.set(timeZone, formatter);
  }
  return formatter;
}

export function parseFixedOffsetMs(timeZone: string): number | null {
  const trimmed = timeZone.trim();
  if (
    trimmed.length === 0 ||
    trimmed.toUpperCase() === "Z" ||
    trimmed.toUpperCase() === "UTC" ||
    trimmed.toUpperCase() === "GMT"
  ) {
    return 0;
  }
  const match = FIXED_OFFSET_PATTERN.exec(trimmed);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] !== undefined ? Number(match[3]) : 0;
  if (hours > 23 || minutes > 59) return null;
  return sign * (hours * 60 + minutes) * 60_000;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function formatDayKey(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

export function getLocalDateTimeParts(utcMs: number, timeZone: string): LocalDateTimeParts {
  const fixedOffsetMs = parseFixedOffsetMs(timeZone);
  if (fixedOffsetMs !== null) {
    const shifted = DateTime.toPartsUtc(DateTime.makeUnsafe(utcMs + fixedOffsetMs));
    const year = shifted.year;
    const month = shifted.month;
    const day = shifted.day;
    const hour = shifted.hour;
    const minute = shifted.minute;
    const second = shifted.second;
    return {
      year,
      month,
      day,
      hour,
      minute,
      second,
      dayKey: formatDayKey(year, month, day),
    };
  }

  const parts = getFormatter(timeZone).formatToParts(utcMs);
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value) % 24;
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
    }
  }
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dayKey: formatDayKey(year, month, day),
  };
}

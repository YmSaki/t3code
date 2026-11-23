import { getLocalDateTimeParts } from "./worklogGrouping.core.ts";
import { getAgentShortCode } from "./worklogLayout.core.ts";

export type PushNotificationEventKind =
  | "approval_requested"
  | "question_requested"
  | "pm_completed"
  | "repo_monitor_triggered"
  | "run_failed";

export interface PushNotificationCandidateEvent {
  readonly kind: PushNotificationEventKind;
  readonly occurredAt: string | number;
  readonly environmentId?: string | undefined;
  readonly projectId?: string | null | undefined;
  readonly projectTitle?: string | undefined;
  readonly threadId?: string | null | undefined;
  readonly threadTitle?: string | undefined;
  readonly runId?: string | null | undefined;
  readonly requestId?: string | null | undefined;
  readonly provider?: string | undefined;
  readonly summary?: string | undefined;
  readonly commandOrToolName?: string | undefined;
  readonly questionText?: string | undefined;
  readonly monitorRuleName?: string | undefined;
  readonly findingSummary?: string | undefined;
  readonly urgent?: boolean | undefined;
}

export interface QuietHoursConfig {
  readonly enabled: boolean;
  readonly startTime: string;
  readonly endTime: string;
  readonly timeZone?: string | undefined;
  readonly allowUrgent?: boolean | undefined;
}

export interface PushNotificationHistoryRecord {
  readonly dedupeKey: string;
  readonly sentAt: string | number;
}

export interface PushNotificationPolicySettings {
  readonly enabled: boolean;
  readonly enabledKinds?:
    | ReadonlyArray<PushNotificationEventKind>
    | Partial<Readonly<Record<PushNotificationEventKind, boolean>>>
    | undefined;
  readonly quietHours?: QuietHoursConfig | undefined;
  readonly debounceWindowMs?: number | undefined;
}

export type PushNotificationDecisionReason =
  | "allowed"
  | "disabled_globally"
  | "disabled_kind"
  | "quiet_hours"
  | "debounced";

export interface PushNotificationDecision {
  readonly shouldSend: boolean;
  readonly reason: PushNotificationDecisionReason;
  readonly dedupeKey: string;
  readonly title: string;
  readonly body: string;
  readonly priority: "high" | "normal";
}

const TIME_OF_DAY_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function parseTimeOfDayMinutes(hhmm: string): number | null {
  const match = TIME_OF_DAY_PATTERN.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

function toTimestampMs(value: string | number): number {
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function isWithinQuietHours(
  occurredAt: string | number,
  quietHours: QuietHoursConfig,
): boolean {
  if (!quietHours.enabled) return false;
  const startMinutes = parseTimeOfDayMinutes(quietHours.startTime);
  const endMinutes = parseTimeOfDayMinutes(quietHours.endTime);
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) {
    return false;
  }

  const utcMs = toTimestampMs(occurredAt);
  const timeZone = quietHours.timeZone ?? "UTC";
  const localParts = getLocalDateTimeParts(utcMs, timeZone);
  const currentMinutes = localParts.hour * 60 + localParts.minute;

  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

export function buildPushNotificationDedupeKey(event: PushNotificationCandidateEvent): string {
  const envPart = event.environmentId?.trim() || "default";
  const projPart = event.projectId?.trim() || "-";
  const threadPart = event.threadId?.trim() || "-";
  const targetPart =
    event.requestId?.trim() ||
    event.runId?.trim() ||
    event.monitorRuleName?.trim() ||
    event.commandOrToolName?.trim() ||
    event.summary?.trim() ||
    "-";

  return `push:${event.kind}:${envPart}:${projPart}:${threadPart}:${targetPart}`;
}

function formatContextPrefix(event: PushNotificationCandidateEvent): string {
  const segments: Array<string> = [];
  if (event.provider !== undefined && event.provider.trim().length > 0) {
    segments.push(`[${getAgentShortCode(event.provider)}]`);
  }
  if (event.projectTitle !== undefined && event.projectTitle.trim().length > 0) {
    segments.push(event.projectTitle.trim());
  }
  return segments.length > 0 ? `${segments.join(" ")}: ` : "";
}

export function formatPushNotificationContent(event: PushNotificationCandidateEvent): {
  readonly title: string;
  readonly body: string;
  readonly priority: "high" | "normal";
} {
  const prefix = formatContextPrefix(event);
  const threadLabel =
    event.threadTitle !== undefined && event.threadTitle.trim().length > 0
      ? event.threadTitle.trim()
      : (event.threadId ?? "Agent Thread");

  switch (event.kind) {
    case "approval_requested": {
      const toolDetail =
        event.commandOrToolName !== undefined && event.commandOrToolName.trim().length > 0
          ? ` (${event.commandOrToolName.trim()})`
          : "";
      const title = `${prefix}Approval Required${toolDetail}`;
      const body =
        event.summary !== undefined && event.summary.trim().length > 0
          ? event.summary.trim()
          : `${threadLabel} is waiting for your approval to continue.`;
      return { title, body, priority: "high" };
    }
    case "question_requested": {
      const title = `${prefix}Question from Agent`;
      const body =
        event.questionText !== undefined && event.questionText.trim().length > 0
          ? event.questionText.trim()
          : event.summary !== undefined && event.summary.trim().length > 0
            ? event.summary.trim()
            : `${threadLabel} is waiting for your answer.`;
      return { title, body, priority: "high" };
    }
    case "pm_completed": {
      const title = `${prefix}PM Task Completed`;
      const body =
        event.summary !== undefined && event.summary.trim().length > 0
          ? event.summary.trim()
          : `${threadLabel} finished orchestration.`;
      return { title, body, priority: "normal" };
    }
    case "repo_monitor_triggered": {
      const ruleLabel =
        event.monitorRuleName !== undefined && event.monitorRuleName.trim().length > 0
          ? event.monitorRuleName.trim()
          : "Repository Monitor";
      const title = `${prefix}Repo Monitor Triggered: ${ruleLabel}`;
      const body =
        event.findingSummary !== undefined && event.findingSummary.trim().length > 0
          ? event.findingSummary.trim()
          : event.summary !== undefined && event.summary.trim().length > 0
            ? event.summary.trim()
            : `Rule "${ruleLabel}" matched new repository activity.`;
      return { title, body, priority: "normal" };
    }
    case "run_failed": {
      const title = `${prefix}Agent Run Failed`;
      const body =
        event.summary !== undefined && event.summary.trim().length > 0
          ? event.summary.trim()
          : `${threadLabel} encountered an error.`;
      return { title, body, priority: "high" };
    }
  }
}

function isEventKindEnabled(
  kind: PushNotificationEventKind,
  enabledKinds: PushNotificationPolicySettings["enabledKinds"],
): boolean {
  if (enabledKinds === undefined) return true;
  if (Array.isArray(enabledKinds)) {
    return enabledKinds.includes(kind);
  }
  const record = enabledKinds as Partial<Readonly<Record<PushNotificationEventKind, boolean>>>;
  const flag = record[kind];
  return flag ?? true;
}

export function evaluatePushNotificationPolicy(params: {
  readonly event: PushNotificationCandidateEvent;
  readonly settings: PushNotificationPolicySettings;
  readonly history?: ReadonlyArray<PushNotificationHistoryRecord> | undefined;
}): PushNotificationDecision {
  const { event, settings, history } = params;
  const dedupeKey = buildPushNotificationDedupeKey(event);
  const content = formatPushNotificationContent(event);

  if (!settings.enabled) {
    return {
      shouldSend: false,
      reason: "disabled_globally",
      dedupeKey,
      ...content,
    };
  }

  if (!isEventKindEnabled(event.kind, settings.enabledKinds)) {
    return {
      shouldSend: false,
      reason: "disabled_kind",
      dedupeKey,
      ...content,
    };
  }

  if (settings.quietHours !== undefined && isWithinQuietHours(event.occurredAt, settings.quietHours)) {
    const bypassForUrgent = Boolean(settings.quietHours.allowUrgent && event.urgent);
    if (!bypassForUrgent) {
      return {
        shouldSend: false,
        reason: "quiet_hours",
        dedupeKey,
        ...content,
      };
    }
  }

  const debounceWindowMs = Math.max(0, settings.debounceWindowMs ?? 60_000);
  if (history !== undefined && history.length > 0 && debounceWindowMs > 0) {
    const eventTimeMs = toTimestampMs(event.occurredAt);
    const isDuplicateWithinWindow = history.some((entry) => {
      if (entry.dedupeKey !== dedupeKey) return false;
      const sentAtMs = toTimestampMs(entry.sentAt);
      const elapsedMs = eventTimeMs - sentAtMs;
      return elapsedMs >= 0 ? elapsedMs < debounceWindowMs : Math.abs(elapsedMs) < debounceWindowMs;
    });

    if (isDuplicateWithinWindow) {
      return {
        shouldSend: false,
        reason: "debounced",
        dedupeKey,
        ...content,
      };
    }
  }

  return {
    shouldSend: true,
    reason: "allowed",
    dedupeKey,
    ...content,
  };
}

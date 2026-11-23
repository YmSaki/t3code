import type { ProjectId } from "@t3tools/contracts";

import type { RepoMonitorEventKindValue } from "./repoMonitorEval.core.ts";

export const ONE_HOUR_MS = 3_600_000;

export const DEFAULT_T3_AGENT_LOOP_MARKERS: ReadonlyArray<string> = [
  "<!-- t3-repo-monitor -->",
  "<!-- t3-agent -->",
  "[t3-repo-monitor]",
  "[t3-agent]",
  "[skip t3]",
  "[t3-skip]",
];

export type RepoMonitorGuardOutcome =
  | "triggered"
  | "skipped_disabled"
  | "skipped_kill_switch"
  | "skipped_loop_guard"
  | "skipped_dedupe"
  | "skipped_cooldown"
  | "skipped_rate_limit";

export type RepoMonitorLoopReason = "self_account" | "t3_managed_agent" | "agent_marker";

export interface RepoMonitorDedupeKeyInput {
  readonly projectId: ProjectId | string;
  readonly ruleId: string;
  readonly kind: RepoMonitorEventKindValue;
  readonly branch?: string | null;
  readonly commitSha?: string | null;
  readonly pullRequestNumber?: number | null;
  readonly issueKey?: string | null;
  readonly commentId?: string | null;
}

export interface RepoMonitorGuardEventInput extends RepoMonitorDedupeKeyInput {
  readonly authorLogin?: string | null;
  readonly title?: string;
  readonly body?: string;
  readonly originatedByT3Agent?: boolean;
}

export interface RepoMonitorLoopCheckInput {
  readonly authorLogin?: string | null | undefined;
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly originatedByT3Agent?: boolean | undefined;
  readonly selfAccountLogins?: ReadonlyArray<string> | undefined;
  readonly managedAgentLogins?: ReadonlyArray<string> | undefined;
  readonly agentMarkers?: ReadonlyArray<string> | undefined;
}

export interface RepoMonitorLoopCheckResult {
  readonly isLoop: boolean;
  readonly reason: RepoMonitorLoopReason | null;
}

export interface RepoMonitorCooldownResult {
  readonly active: boolean;
  readonly remainingMs: number;
}

export interface RepoMonitorHourlyRateLimitResult {
  readonly exceeded: boolean;
  readonly triggersInWindow: number;
  readonly maxTriggersPerHour: number;
}

export interface RepoMonitorGuardInput {
  readonly globalKillSwitch: boolean;
  readonly ruleEnabled: boolean;
  readonly event: RepoMonitorGuardEventInput;
  readonly selfAccountLogins?: ReadonlyArray<string>;
  readonly managedAgentLogins?: ReadonlyArray<string>;
  readonly agentMarkers?: ReadonlyArray<string>;
  readonly seenDedupeKeys?: ReadonlySet<string> | ReadonlyArray<string>;
  readonly lastTriggeredAtMs?: number | null;
  readonly cooldownSec: number;
  readonly recentTriggerTimestampsMs?: ReadonlyArray<number>;
  readonly maxTriggersPerHour: number;
  readonly nowMs: number;
}

export interface RepoMonitorGuardDecision {
  readonly allowed: boolean;
  readonly outcome: RepoMonitorGuardOutcome;
  readonly dedupeKey: string;
  readonly loopReason: RepoMonitorLoopReason | null;
  readonly remainingCooldownMs: number;
  readonly triggersInLastHour: number;
}

export function buildRepoMonitorDedupeKey(input: RepoMonitorDedupeKeyInput): string {
  const project = input.projectId.trim();
  const rule = input.ruleId.trim();

  switch (input.kind) {
    case "branch_push":
      return `${project}:${rule}:branch_push:${(input.branch ?? "").trim()}:${(input.commitSha ?? "").trim()}`;
    case "pr_opened":
      return `${project}:${rule}:pr_opened:${input.pullRequestNumber ?? ""}`;
    case "pr_merged":
      return `${project}:${rule}:pr_merged:${input.pullRequestNumber ?? ""}:${(input.commitSha ?? "merged").trim()}`;
    case "pr_comment":
      return `${project}:${rule}:pr_comment:${input.pullRequestNumber ?? ""}:${(input.commentId ?? "").trim()}`;
    case "issue_opened":
      return `${project}:${rule}:issue_opened:${(input.issueKey ?? "").trim()}`;
    case "issue_comment":
      return `${project}:${rule}:issue_comment:${(input.issueKey ?? "").trim()}:${(input.commentId ?? "").trim()}`;
  }
}

export function detectRepoMonitorAgentLoop(
  input: RepoMonitorLoopCheckInput,
): RepoMonitorLoopCheckResult {
  if (input.originatedByT3Agent === true) {
    return { isLoop: true, reason: "t3_managed_agent" };
  }

  const normalizedAuthor = input.authorLogin ? input.authorLogin.trim().toLowerCase() : null;

  if (normalizedAuthor && input.selfAccountLogins && input.selfAccountLogins.length > 0) {
    const isSelf = input.selfAccountLogins.some(
      (login) => login.trim().toLowerCase() === normalizedAuthor,
    );
    if (isSelf) {
      return { isLoop: true, reason: "self_account" };
    }
  }

  if (normalizedAuthor && input.managedAgentLogins && input.managedAgentLogins.length > 0) {
    const isManagedAgent = input.managedAgentLogins.some(
      (login) => login.trim().toLowerCase() === normalizedAuthor,
    );
    if (isManagedAgent) {
      return { isLoop: true, reason: "t3_managed_agent" };
    }
  }

  const markers = input.agentMarkers ?? DEFAULT_T3_AGENT_LOOP_MARKERS;
  const combinedText = `${input.title ?? ""}\n${input.body ?? ""}`.toLowerCase();
  for (const marker of markers) {
    const normalizedMarker = marker.trim().toLowerCase();
    if (normalizedMarker.length > 0 && combinedText.includes(normalizedMarker)) {
      return { isLoop: true, reason: "agent_marker" };
    }
  }

  return { isLoop: false, reason: null };
}

export function evaluateRepoMonitorCooldown(input: {
  readonly lastTriggeredAtMs: number | null | undefined;
  readonly cooldownSec: number;
  readonly nowMs: number;
}): RepoMonitorCooldownResult {
  const cooldownMs = input.cooldownSec * 1000;
  if (cooldownMs <= 0 || input.lastTriggeredAtMs == null) {
    return { active: false, remainingMs: 0 };
  }
  const elapsedMs = input.nowMs - input.lastTriggeredAtMs;
  if (elapsedMs < cooldownMs) {
    return {
      active: true,
      remainingMs: Math.max(0, cooldownMs - elapsedMs),
    };
  }
  return { active: false, remainingMs: 0 };
}

export function evaluateRepoMonitorHourlyRateLimit(input: {
  readonly recentTriggerTimestampsMs: ReadonlyArray<number>;
  readonly maxTriggersPerHour: number;
  readonly nowMs: number;
  readonly windowMs?: number;
}): RepoMonitorHourlyRateLimitResult {
  const windowMs = input.windowMs ?? ONE_HOUR_MS;
  const windowStartMs = input.nowMs - windowMs;
  let triggersInWindow = 0;
  for (const ts of input.recentTriggerTimestampsMs) {
    if (ts > windowStartMs && ts <= input.nowMs) {
      triggersInWindow += 1;
    }
  }
  return {
    exceeded: input.maxTriggersPerHour <= 0 || triggersInWindow >= input.maxTriggersPerHour,
    triggersInWindow,
    maxTriggersPerHour: input.maxTriggersPerHour,
  };
}

function hasDedupeKey(
  seen: ReadonlySet<string> | ReadonlyArray<string> | undefined,
  dedupeKey: string,
): boolean {
  if (!seen) return false;
  if (Array.isArray(seen)) {
    return seen.includes(dedupeKey);
  }
  return (seen as ReadonlySet<string>).has(dedupeKey);
}

export function evaluateRepoMonitorGuard(input: RepoMonitorGuardInput): RepoMonitorGuardDecision {
  const dedupeKey = buildRepoMonitorDedupeKey(input.event);
  const rateLimit = evaluateRepoMonitorHourlyRateLimit({
    recentTriggerTimestampsMs: input.recentTriggerTimestampsMs ?? [],
    maxTriggersPerHour: input.maxTriggersPerHour,
    nowMs: input.nowMs,
  });

  if (input.globalKillSwitch) {
    return {
      allowed: false,
      outcome: "skipped_kill_switch",
      dedupeKey,
      loopReason: null,
      remainingCooldownMs: 0,
      triggersInLastHour: rateLimit.triggersInWindow,
    };
  }

  if (!input.ruleEnabled) {
    return {
      allowed: false,
      outcome: "skipped_disabled",
      dedupeKey,
      loopReason: null,
      remainingCooldownMs: 0,
      triggersInLastHour: rateLimit.triggersInWindow,
    };
  }

  const loopCheck = detectRepoMonitorAgentLoop({
    authorLogin: input.event.authorLogin,
    title: input.event.title,
    body: input.event.body,
    originatedByT3Agent: input.event.originatedByT3Agent,
    selfAccountLogins: input.selfAccountLogins,
    managedAgentLogins: input.managedAgentLogins,
    agentMarkers: input.agentMarkers,
  });

  if (loopCheck.isLoop) {
    return {
      allowed: false,
      outcome: "skipped_loop_guard",
      dedupeKey,
      loopReason: loopCheck.reason,
      remainingCooldownMs: 0,
      triggersInLastHour: rateLimit.triggersInWindow,
    };
  }

  if (hasDedupeKey(input.seenDedupeKeys, dedupeKey)) {
    return {
      allowed: false,
      outcome: "skipped_dedupe",
      dedupeKey,
      loopReason: null,
      remainingCooldownMs: 0,
      triggersInLastHour: rateLimit.triggersInWindow,
    };
  }

  const cooldown = evaluateRepoMonitorCooldown({
    lastTriggeredAtMs: input.lastTriggeredAtMs,
    cooldownSec: input.cooldownSec,
    nowMs: input.nowMs,
  });

  if (cooldown.active) {
    return {
      allowed: false,
      outcome: "skipped_cooldown",
      dedupeKey,
      loopReason: null,
      remainingCooldownMs: cooldown.remainingMs,
      triggersInLastHour: rateLimit.triggersInWindow,
    };
  }

  if (rateLimit.exceeded) {
    return {
      allowed: false,
      outcome: "skipped_rate_limit",
      dedupeKey,
      loopReason: null,
      remainingCooldownMs: 0,
      triggersInLastHour: rateLimit.triggersInWindow,
    };
  }

  return {
    allowed: true,
    outcome: "triggered",
    dedupeKey,
    loopReason: null,
    remainingCooldownMs: 0,
    triggersInLastHour: rateLimit.triggersInWindow,
  };
}

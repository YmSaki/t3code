import {
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  type RepoMonitorCursor,
  type RepoMonitorDryRunResult,
  RepoMonitorError,
  RepoMonitorEventId,
  type RepoMonitorEventRecord,
  type RepoMonitorRule,
  type RepoMonitorRuleListResult,
  RepoMonitorRuleId,
  type RepoMonitorRuleUpsertInput,
  type ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  buildNextRepoMonitorCursor,
  evaluateRepoMonitorSnapshot,
  matchesRepoMonitorFilter,
  type RepoMonitorCandidateEvent,
  type RepoMonitorCursorState,
  type RepoMonitorSnapshot,
} from "@t3tools/shared/repoMonitorEval.core";
import {
  ONE_HOUR_MS,
  buildRepoMonitorDedupeKey,
  evaluateRepoMonitorGuard,
} from "@t3tools/shared/repoMonitorGuard.core";
import {
  listRepoMonitorPresets,
  type RepoMonitorPreset,
} from "@t3tools/shared/repoMonitorPresets.core";
import {
  renderRepoMonitorPrompt,
  type RepoMonitorPromptEventData,
} from "@t3tools/shared/repoMonitorPrompt.core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SecureRandom from "effect/crypto/SecureRandom";

import { type RepoMonitorEventQueryFilter, RepoMonitorStore } from "./RepoMonitorStore.ts";

export interface RepoMonitorActionDispatchInput {
  readonly rule: RepoMonitorRule;
  readonly event: RepoMonitorCandidateEvent;
  readonly dedupeKey: string;
  readonly renderedPrompt: string;
}

export interface RepoMonitorActionDispatchResult {
  readonly dispatchedThreadId?: ThreadId | null | undefined;
}

export type RepoMonitorActionDispatcher = (
  input: RepoMonitorActionDispatchInput,
) => Effect.Effect<RepoMonitorActionDispatchResult, RepoMonitorError>;

export type RepoMonitorSnapshotProvider = (
  projectId: ProjectId,
) => Effect.Effect<RepoMonitorSnapshot, RepoMonitorError>;

export interface RepoMonitorServiceOptions {
  readonly onActionTriggered?: RepoMonitorActionDispatcher | undefined;
  readonly snapshotProvider?: RepoMonitorSnapshotProvider | undefined;
  readonly getGlobalKillSwitch?: Effect.Effect<boolean, RepoMonitorError> | undefined;
}

export interface RepoMonitorDryRunProjectInput {
  readonly projectId: ProjectId;
  readonly ruleId?: RepoMonitorRuleId | undefined;
  readonly snapshot?: RepoMonitorSnapshot | undefined;
  readonly globalKillSwitch?: boolean | undefined;
  readonly selfAccountLogins?: ReadonlyArray<string> | null | undefined;
  readonly managedAgentLogins?: ReadonlyArray<string> | undefined;
  readonly emitOnInitialCursor?: boolean | undefined;
}

export interface RepoMonitorPollProjectInput {
  readonly projectId: ProjectId;
  readonly snapshot?: RepoMonitorSnapshot | undefined;
  readonly globalKillSwitch?: boolean | undefined;
  readonly selfAccountLogins?: ReadonlyArray<string> | null | undefined;
  readonly managedAgentLogins?: ReadonlyArray<string> | undefined;
  readonly emitOnInitialCursor?: boolean | undefined;
}

export interface RepoMonitorPollResult {
  readonly projectId: ProjectId;
  readonly evaluatedAt: string;
  readonly candidateCount: number;
  readonly events: ReadonlyArray<RepoMonitorEventRecord>;
  readonly triggeredEvents: ReadonlyArray<RepoMonitorEventRecord>;
  readonly nextCursor: RepoMonitorCursor;
}

export interface RepoMonitorWebhookIngestInput {
  readonly projectId: ProjectId;
  readonly event: RepoMonitorCandidateEvent;
  readonly ruleId?: RepoMonitorRuleId | undefined;
  readonly globalKillSwitch?: boolean | undefined;
  readonly selfAccountLogins?: ReadonlyArray<string> | null | undefined;
  readonly managedAgentLogins?: ReadonlyArray<string> | undefined;
}

export class RepoMonitorService extends Context.Service<
  RepoMonitorService,
  {
    readonly listRules: (
      projectId?: ProjectId | undefined,
    ) => Effect.Effect<RepoMonitorRuleListResult, RepoMonitorError>;
    readonly upsertRule: (
      input: RepoMonitorRuleUpsertInput,
    ) => Effect.Effect<RepoMonitorRule, RepoMonitorError>;
    readonly deleteRule: (
      id: RepoMonitorRuleId,
    ) => Effect.Effect<
      { readonly id: RepoMonitorRuleId; readonly deleted: boolean },
      RepoMonitorError
    >;
    readonly listEvents: (
      filter?: RepoMonitorEventQueryFilter | undefined,
    ) => Effect.Effect<ReadonlyArray<RepoMonitorEventRecord>, RepoMonitorError>;
    readonly dryRunProject: (
      input: RepoMonitorDryRunProjectInput,
    ) => Effect.Effect<ReadonlyArray<RepoMonitorDryRunResult>, RepoMonitorError>;
    readonly pollProject: (
      input: RepoMonitorPollProjectInput,
    ) => Effect.Effect<RepoMonitorPollResult, RepoMonitorError>;
    readonly ingestWebhookEvent: (
      input: RepoMonitorWebhookIngestInput,
    ) => Effect.Effect<ReadonlyArray<RepoMonitorEventRecord>, RepoMonitorError>;
    readonly listPresets: Effect.Effect<ReadonlyArray<RepoMonitorPreset>>;
  }
>()("t3/repoMonitor/RepoMonitorService") {}

function toEpochMs(iso: string): number | null {
  return Option.match(DateTime.make(iso), {
    onNone: () => null,
    onSome: DateTime.toEpochMillis,
  });
}

function toContractCursor(state: RepoMonitorCursorState): RepoMonitorCursor {
  const branchHeads: Record<typeof TrimmedNonEmptyString.Type, typeof TrimmedNonEmptyString.Type> =
    {};
  for (const [branch, sha] of Object.entries(state.branchHeads)) {
    const trimmedBranch = branch.trim();
    const trimmedSha = sha.trim();
    if (trimmedBranch.length > 0 && trimmedSha.length > 0) {
      branchHeads[TrimmedNonEmptyString.make(trimmedBranch)] =
        TrimmedNonEmptyString.make(trimmedSha);
    }
  }

  return {
    projectId: state.projectId,
    branchHeads,
    knownPullRequestNumbers: state.knownPullRequestNumbers
      .filter((n) => n >= 1)
      .map((n) => PositiveInt.make(n)),
    mergedPullRequestNumbers: state.mergedPullRequestNumbers
      .filter((n) => n >= 1)
      .map((n) => PositiveInt.make(n)),
    knownPullRequestCommentIds: state.knownPullRequestCommentIds
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
      .map((id) => TrimmedNonEmptyString.make(id)),
    knownIssueKeys: state.knownIssueKeys
      .map((key) => key.trim())
      .filter((key) => key.length > 0)
      .map((key) => TrimmedNonEmptyString.make(key)),
    knownIssueCommentIds: state.knownIssueCommentIds
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
      .map((id) => TrimmedNonEmptyString.make(id)),
    updatedAt: state.updatedAt,
  };
}

function buildEventSummary(event: RepoMonitorCandidateEvent): typeof TrimmedNonEmptyString.Type {
  const rawTitle = event.title.trim() || event.kind;
  switch (event.kind) {
    case "branch_push":
      return TrimmedNonEmptyString.make(
        `Push to ${event.branch ?? "branch"}: ${rawTitle}`.slice(0, 240),
      );
    case "pr_opened":
      return TrimmedNonEmptyString.make(
        `PR #${event.pullRequestNumber ?? "?"} opened: ${rawTitle}`.slice(0, 240),
      );
    case "pr_merged":
      return TrimmedNonEmptyString.make(
        `PR #${event.pullRequestNumber ?? "?"} merged: ${rawTitle}`.slice(0, 240),
      );
    case "pr_comment":
      return TrimmedNonEmptyString.make(
        `Comment on PR #${event.pullRequestNumber ?? "?"}: ${rawTitle}`.slice(0, 240),
      );
    case "issue_opened":
      return TrimmedNonEmptyString.make(
        `Issue #${event.issueKey ?? "?"} opened: ${rawTitle}`.slice(0, 240),
      );
    case "issue_comment":
      return TrimmedNonEmptyString.make(
        `Comment on Issue #${event.issueKey ?? "?"}: ${rawTitle}`.slice(0, 240),
      );
  }
}

function toPromptEventData(
  event: RepoMonitorCandidateEvent,
  rule: RepoMonitorRule,
): RepoMonitorPromptEventData {
  return {
    kind: event.kind,
    projectId: event.projectId,
    title: event.title,
    body: event.body,
    authorLogin: event.authorLogin,
    isBot: event.isBot,
    labels: event.labels,
    branch: event.branch,
    headBranch: event.headBranch,
    baseBranch: event.baseBranch,
    previousCommitSha: event.previousCommitSha,
    commitSha: event.commitSha,
    pullRequestNumber: event.pullRequestNumber,
    issueKey: event.issueKey,
    commentId: event.commentId,
    path: event.path,
    url: event.url,
    occurredAt: event.occurredAt,
    ruleId: rule.id,
    ruleName: rule.name,
  };
}

function optTrimmed(value: string | null | undefined): typeof TrimmedNonEmptyString.Type | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? TrimmedNonEmptyString.make(trimmed) : null;
}

/** @public */
export const make = Effect.fn("RepoMonitorService.make")(function* (
  options?: RepoMonitorServiceOptions | undefined,
) {
  const store = yield* RepoMonitorStore;
  const random = yield* SecureRandom.SecureRandom;

  const nextFrameId = Effect.map(random.uuidV4(), (uuid) => uuid.replaceAll("-", "").slice(0, 12));

  const resolveKillSwitch = (explicit?: boolean | undefined) =>
    explicit !== undefined
      ? Effect.succeed(explicit)
      : (options?.getGlobalKillSwitch ?? Effect.succeed(false));

  const listRules = Effect.fn("RepoMonitorService.listRules")(function* (
    projectId?: ProjectId | undefined,
  ) {
    const rules = yield* store.listRules(projectId);
    const globalKillSwitch = yield* resolveKillSwitch();
    return { rules, globalKillSwitch };
  });

  const resolveSnapshot = (
    projectId: ProjectId,
    explicit: RepoMonitorSnapshot | undefined,
    nowIso: string,
  ): Effect.Effect<RepoMonitorSnapshot, RepoMonitorError> => {
    if (explicit !== undefined) return Effect.succeed(explicit);
    if (options?.snapshotProvider !== undefined) {
      return options.snapshotProvider(projectId);
    }
    return Effect.succeed({
      projectId,
      observedAt: nowIso,
      branches: [],
      pullRequests: [],
      issues: [],
    });
  };

  const evaluateGuardForRuleAndEvent = Effect.fn("RepoMonitorService.evaluateGuardForRuleAndEvent")(
    function* (input: {
      readonly rule: RepoMonitorRule;
      readonly event: RepoMonitorCandidateEvent;
      readonly globalKillSwitch: boolean;
      readonly selfAccountLogins?: ReadonlyArray<string> | null | undefined;
      readonly managedAgentLogins?: ReadonlyArray<string> | undefined;
      readonly now: DateTime.Utc;
    }) {
      const nowMs = DateTime.toEpochMillis(input.now);
      const sinceIso = DateTime.formatIso(DateTime.subtract(input.now, { hours: 1 }));
      const dedupeKey = buildRepoMonitorDedupeKey({
        projectId: input.rule.projectId,
        ruleId: input.rule.id,
        kind: input.event.kind,
        branch: input.event.branch,
        commitSha: input.event.commitSha,
        pullRequestNumber: input.event.pullRequestNumber,
        issueKey: input.event.issueKey,
        commentId: input.event.commentId,
      });

      const alreadySeen = yield* store.hasDedupeKey(input.rule.id, dedupeKey);
      const windowStats = yield* store.getTriggerWindowStats({
        ruleId: input.rule.id,
        sinceIso,
      });

      const lastTriggeredAtMs =
        windowStats.lastTriggeredAt !== null ? toEpochMs(windowStats.lastTriggeredAt) : null;
      const recentTriggerTimestampsMs = windowStats.recentTriggeredAt
        .map(toEpochMs)
        .filter((ts): ts is number => ts !== null && ts > nowMs - ONE_HOUR_MS);

      return evaluateRepoMonitorGuard({
        globalKillSwitch: input.globalKillSwitch,
        ruleEnabled: input.rule.enabled,
        event: {
          projectId: input.rule.projectId,
          ruleId: input.rule.id,
          kind: input.event.kind,
          branch: input.event.branch,
          commitSha: input.event.commitSha,
          pullRequestNumber: input.event.pullRequestNumber,
          issueKey: input.event.issueKey,
          commentId: input.event.commentId,
          authorLogin: input.event.authorLogin,
          title: input.event.title,
          body: input.event.body,
        },
        ...(input.selfAccountLogins === undefined
          ? {}
          : { selfAccountLogins: input.selfAccountLogins }),
        ...(input.managedAgentLogins === undefined
          ? {}
          : { managedAgentLogins: input.managedAgentLogins }),
        seenDedupeKeys: alreadySeen ? [dedupeKey] : [],
        lastTriggeredAtMs,
        cooldownSec: input.rule.cooldownSec,
        recentTriggerTimestampsMs,
        maxTriggersPerHour: input.rule.maxTriggersPerHour,
        nowMs,
      });
    },
  );

  const processEventForRule = Effect.fn("RepoMonitorService.processEventForRule")(
    function* (input: {
      readonly rule: RepoMonitorRule;
      readonly event: RepoMonitorCandidateEvent;
      readonly globalKillSwitch: boolean;
      readonly selfAccountLogins?: ReadonlyArray<string> | null | undefined;
      readonly managedAgentLogins?: ReadonlyArray<string> | undefined;
      readonly now: DateTime.Utc;
    }) {
      const guard = yield* evaluateGuardForRuleAndEvent(input);
      const frameId = yield* nextFrameId;
      const rendered = renderRepoMonitorPrompt(
        input.rule.promptTemplate,
        toPromptEventData(input.event, input.rule),
        frameId,
      );

      let dispatchedThreadId: ThreadId | null = null;
      if (guard.allowed && options?.onActionTriggered !== undefined) {
        // One rule's failed action must not abort the poll: the cursor would never advance and
        // every rule on the project would retry the same match forever. A redelivered webhook retries it.
        const dispatchResult = yield* options
          .onActionTriggered({
            rule: input.rule,
            event: input.event,
            dedupeKey: guard.dedupeKey,
            renderedPrompt: rendered.prompt,
          })
          .pipe(
            Effect.catchTags({
              RepoMonitorError: (error) =>
                Effect.logWarning("repo monitor action failed", {
                  ruleId: input.rule.id,
                  error,
                }).pipe(Effect.as(null)),
            }),
          );
        if (dispatchResult === null) return null;
        dispatchedThreadId = dispatchResult.dispatchedThreadId ?? null;
      }

      const eventId = RepoMonitorEventId.make(`rm-evt:${yield* random.uuidV4()}`);
      const record: RepoMonitorEventRecord = {
        id: eventId,
        ruleId: input.rule.id,
        projectId: input.rule.projectId,
        eventKind: input.event.kind,
        dedupeKey: TrimmedNonEmptyString.make(guard.dedupeKey),
        summary: buildEventSummary(input.event),
        authorLogin: optTrimmed(input.event.authorLogin),
        isBot: input.event.isBot,
        branch: optTrimmed(input.event.branch),
        commitSha: optTrimmed(input.event.commitSha),
        pullRequestNumber:
          input.event.pullRequestNumber !== null && input.event.pullRequestNumber >= 1
            ? PositiveInt.make(input.event.pullRequestNumber)
            : null,
        issueKey: optTrimmed(input.event.issueKey),
        commentId: optTrimmed(input.event.commentId),
        url: optTrimmed(input.event.url),
        outcome: guard.outcome,
        dispatchedThreadId,
        renderedPrompt: rendered.prompt,
        occurredAt: DateTime.formatIso(input.now),
      };

      const persisted = yield* store.recordEvent(record);
      if (!persisted.inserted) {
        return {
          ...record,
          outcome: "skipped_dedupe" as const,
        };
      }
      return persisted.event;
    },
  );

  const upsertRule: RepoMonitorService["Service"]["upsertRule"] = Effect.fn(
    "RepoMonitorService.upsertRule",
  )(function* (input) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const id = input.id ?? RepoMonitorRuleId.make(`rm-rule:${yield* random.uuidV4()}`);
    const existing = input.id !== undefined ? yield* store.getRule(input.id) : null;

    const rule: RepoMonitorRule = {
      id,
      projectId: input.projectId,
      ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      enabled: input.enabled,
      eventKinds: input.eventKinds,
      filter: input.filter,
      actionKind: input.actionKind,
      targetThreadId: input.targetThreadId ?? existing?.targetThreadId ?? null,
      ...(input.runtimeMode !== undefined
        ? { runtimeMode: input.runtimeMode }
        : existing?.runtimeMode !== undefined
          ? { runtimeMode: existing.runtimeMode }
          : {}),
      promptTemplate: input.promptTemplate,
      cooldownSec: input.cooldownSec ?? existing?.cooldownSec ?? NonNegativeInt.make(60),
      maxTriggersPerHour:
        input.maxTriggersPerHour ?? existing?.maxTriggersPerHour ?? PositiveInt.make(20),
      ...(input.presetId !== undefined
        ? { presetId: input.presetId }
        : existing?.presetId !== undefined
          ? { presetId: existing.presetId }
          : {}),
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };

    return yield* store.putRule(rule);
  });

  const deleteRule: RepoMonitorService["Service"]["deleteRule"] = Effect.fn(
    "RepoMonitorService.deleteRule",
  )(function* (id) {
    const deleted = yield* store.deleteRule(id);
    return { id, deleted };
  });

  const dryRunProject: RepoMonitorService["Service"]["dryRunProject"] = Effect.fn(
    "RepoMonitorService.dryRunProject",
  )(function* (input) {
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const globalKillSwitch = yield* resolveKillSwitch(input.globalKillSwitch);
    const snapshot = yield* resolveSnapshot(input.projectId, input.snapshot, nowIso);
    const previousCursor = yield* store.getCursor(input.projectId);

    const allRules = yield* store.listRules(input.projectId);
    const targetRules =
      input.ruleId === undefined ? allRules : allRules.filter((rule) => rule.id === input.ruleId);

    const results: RepoMonitorDryRunResult[] = [];

    for (const rule of targetRules) {
      const evalResult = evaluateRepoMonitorSnapshot({
        previousCursor,
        snapshot,
        rules: [{ ...rule, enabled: true }],
        emitOnInitialCursor: input.emitOnInitialCursor ?? previousCursor === null,
      });

      const matchedEvents: RepoMonitorEventRecord[] = [];
      const renderedPrompts: string[] = [];
      let skippedCount = evalResult.candidateEvents.length - evalResult.matches.length;

      for (const match of evalResult.matches) {
        const guard = yield* evaluateGuardForRuleAndEvent({
          rule,
          event: match.event,
          globalKillSwitch,
          selfAccountLogins: input.selfAccountLogins,
          managedAgentLogins: input.managedAgentLogins,
          now,
        });
        const frameId = yield* nextFrameId;
        const rendered = renderRepoMonitorPrompt(
          rule.promptTemplate,
          toPromptEventData(match.event, rule),
          frameId,
        );

        if (!guard.allowed) {
          skippedCount += 1;
        } else {
          renderedPrompts.push(rendered.prompt);
        }

        matchedEvents.push({
          id: RepoMonitorEventId.make(`rm-dry:${yield* random.uuidV4()}`),
          ruleId: rule.id,
          projectId: rule.projectId,
          eventKind: match.event.kind,
          dedupeKey: TrimmedNonEmptyString.make(guard.dedupeKey),
          summary: buildEventSummary(match.event),
          authorLogin: optTrimmed(match.event.authorLogin),
          isBot: match.event.isBot,
          branch: optTrimmed(match.event.branch),
          commitSha: optTrimmed(match.event.commitSha),
          pullRequestNumber:
            match.event.pullRequestNumber !== null && match.event.pullRequestNumber >= 1
              ? PositiveInt.make(match.event.pullRequestNumber)
              : null,
          issueKey: optTrimmed(match.event.issueKey),
          commentId: optTrimmed(match.event.commentId),
          url: optTrimmed(match.event.url),
          outcome: guard.allowed ? "dry_run" : guard.outcome,
          dispatchedThreadId: null,
          renderedPrompt: rendered.prompt,
          occurredAt: nowIso,
        });
      }

      results.push({
        ruleId: rule.id,
        projectId: rule.projectId,
        evaluatedAt: nowIso,
        matchedEvents,
        nextCursor: toContractCursor(evalResult.nextCursor),
        renderedPrompts,
        skippedCount: NonNegativeInt.make(Math.max(0, skippedCount)),
      });
    }

    return results;
  });

  const pollProject: RepoMonitorService["Service"]["pollProject"] = Effect.fn(
    "RepoMonitorService.pollProject",
  )(function* (input) {
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const globalKillSwitch = yield* resolveKillSwitch(input.globalKillSwitch);
    const snapshot = yield* resolveSnapshot(input.projectId, input.snapshot, nowIso);
    const previousCursor = yield* store.getCursor(input.projectId);
    const rules = yield* store.listRules(input.projectId);

    const evalResult = evaluateRepoMonitorSnapshot({
      previousCursor,
      snapshot,
      rules: rules.map((r) => ({ ...r, enabled: true })),
      ...(input.emitOnInitialCursor === undefined
        ? {}
        : { emitOnInitialCursor: input.emitOnInitialCursor }),
    });

    const ruleById = new Map(rules.map((r) => [r.id as string, r]));
    const recordedEvents: RepoMonitorEventRecord[] = [];

    for (const match of evalResult.matches) {
      const rule = ruleById.get(match.ruleId);
      if (!rule) continue;
      const record = yield* processEventForRule({
        rule,
        event: match.event,
        globalKillSwitch,
        selfAccountLogins: input.selfAccountLogins,
        managedAgentLogins: input.managedAgentLogins,
        now,
      });
      if (record !== null) recordedEvents.push(record);
    }

    const nextCursor = toContractCursor(evalResult.nextCursor);
    yield* store.putCursor(nextCursor);

    return {
      projectId: input.projectId,
      evaluatedAt: nowIso,
      candidateCount: evalResult.candidateEvents.length,
      events: recordedEvents,
      triggeredEvents: recordedEvents.filter((e) => e.outcome === "triggered"),
      nextCursor,
    };
  });

  const ingestWebhookEvent: RepoMonitorService["Service"]["ingestWebhookEvent"] = Effect.fn(
    "RepoMonitorService.ingestWebhookEvent",
  )(function* (input) {
    const now = yield* DateTime.now;
    const globalKillSwitch = yield* resolveKillSwitch(input.globalKillSwitch);
    const allRules = yield* store.listRules(input.projectId);
    const targetRules =
      input.ruleId === undefined ? allRules : allRules.filter((rule) => rule.id === input.ruleId);

    const results: RepoMonitorEventRecord[] = [];
    for (const rule of targetRules) {
      if (!rule.eventKinds.includes(input.event.kind)) continue;
      if (!matchesRepoMonitorFilter(input.event, rule.filter)) continue;

      const record = yield* processEventForRule({
        rule,
        event: input.event,
        globalKillSwitch,
        selfAccountLogins: input.selfAccountLogins,
        managedAgentLogins: input.managedAgentLogins,
        now,
      });
      if (record !== null) results.push(record);
    }

    const previousCursor = yield* store.getCursor(input.projectId);
    if (previousCursor !== null) {
      const updatedCursorState = buildNextRepoMonitorCursor(previousCursor, {
        projectId: input.projectId,
        observedAt: DateTime.formatIso(now),
        branches:
          input.event.kind === "branch_push" &&
          input.event.branch !== null &&
          input.event.commitSha !== null
            ? [{ name: input.event.branch, headSha: input.event.commitSha }]
            : [],
        pullRequests:
          input.event.pullRequestNumber !== null
            ? [
                {
                  number: input.event.pullRequestNumber,
                  title: input.event.title,
                  state: input.event.kind === "pr_merged" ? "merged" : "open",
                  headBranch: input.event.headBranch ?? input.event.branch ?? "unknown",
                  baseBranch: input.event.baseBranch ?? "main",
                  authorLogin: input.event.authorLogin,
                  labels: input.event.labels,
                  createdAt: input.event.occurredAt,
                  updatedAt: input.event.occurredAt,
                  ...(input.event.kind === "pr_comment" && input.event.commentId !== null
                    ? {
                        comments: [
                          {
                            id: input.event.commentId,
                            authorLogin: input.event.authorLogin,
                            body: input.event.body,
                            createdAt: input.event.occurredAt,
                          },
                        ],
                      }
                    : {}),
                },
              ]
            : [],
        issues:
          input.event.issueKey !== null
            ? [
                {
                  key: input.event.issueKey,
                  title: input.event.title,
                  stateCategory: "open",
                  authorLogin: input.event.authorLogin,
                  labels: input.event.labels,
                  createdAt: input.event.occurredAt,
                  updatedAt: input.event.occurredAt,
                  ...(input.event.kind === "issue_comment" && input.event.commentId !== null
                    ? {
                        comments: [
                          {
                            id: input.event.commentId,
                            authorLogin: input.event.authorLogin,
                            body: input.event.body,
                            createdAt: input.event.occurredAt,
                          },
                        ],
                      }
                    : {}),
                },
              ]
            : [],
      });
      yield* store.putCursor(toContractCursor(updatedCursorState));
    }

    return results;
  });

  return RepoMonitorService.of({
    listRules,
    upsertRule,
    deleteRule,
    listEvents: store.listEvents,
    dryRunProject,
    pollProject,
    ingestWebhookEvent,
    listPresets: Effect.succeed(listRepoMonitorPresets()),
  });
});

export const layer = (
  options?: RepoMonitorServiceOptions | undefined,
): Layer.Layer<RepoMonitorService, never, RepoMonitorStore | SecureRandom.SecureRandom> =>
  Layer.effect(RepoMonitorService, make(options));

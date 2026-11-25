import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RepoMonitorEventId,
  RepoMonitorRuleId,
  TrimmedNonEmptyString,
  WS_METHODS,
  type AuthSessionState,
  type RepoMonitorEventRecord,
  type RepoMonitorRule,
  type RepoMonitorRuleUpsertInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  buildRepoMonitorRuleToggleInput,
  buildRepoMonitorRuleUpsertFromPreset,
  countTriggeredRepoMonitorEvents,
  createRepoMonitorEnvironmentAtoms,
  formatRepoMonitorCommaList,
  parseRepoMonitorCommaList,
} from "./repoMonitors.ts";
import { awaitAtomResult, runAtomCommand } from "./runtime.ts";

const grantedSession: AuthSessionState = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [AuthOrchestrationOperateScope, AuthAccessWriteScope],
  permissions: [AuthOrchestrationOperateScope, AuthAccessWriteScope],
};

const sessionsAtom = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.success(grantedSession)),
);

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessionsAtom }),
}));

const envId = EnvironmentId.make("env-mon");
const projectId = ProjectId.make("proj-mon");
const ruleId = RepoMonitorRuleId.make("rule-mon-1");

function createTestRepoMonitorAtoms() {
  return Effect.gen(function* () {
    const rules: Array<RepoMonitorRule> = [
      {
        id: ruleId,
        projectId,
        name: TrimmedNonEmptyString.make("Watch PR Comments"),
        enabled: true,
        eventKinds: ["pr_comment"],
        filter: { excludeBots: true },
        actionKind: "launch_thread",
        targetThreadId: null,
        runtimeMode: "auto-accept-edits",
        promptTemplate: TrimmedNonEmptyString.make("Check {{body}}"),
        cooldownSec: NonNegativeInt.make(60),
        maxTriggersPerHour: PositiveInt.make(20),
        createdAt: "2026-11-22T10:00:00.000Z",
        updatedAt: "2026-11-22T10:00:00.000Z",
      },
    ];
    const events: Array<RepoMonitorEventRecord> = [
      {
        id: RepoMonitorEventId.make("evt-1"),
        ruleId,
        projectId,
        eventKind: "pr_comment",
        dedupeKey: TrimmedNonEmptyString.make("proj-mon:rule-mon-1:pr_comment:1:c1"),
        summary: TrimmedNonEmptyString.make("Comment on PR #1"),
        authorLogin: TrimmedNonEmptyString.make("alice"),
        isBot: false,
        outcome: "triggered",
        occurredAt: "2026-11-22T10:05:00.000Z",
      },
    ];
    let ruleReads = 0;
    let globalKillSwitch = true;

    const client = {
      [WS_METHODS.repoMonitorListRules]: () =>
        Effect.sync(() => {
          ruleReads += 1;
          return { rules: [...rules], globalKillSwitch };
        }),
      [WS_METHODS.repoMonitorListEvents]: () => Effect.sync(() => ({ events: [...events] })),
      [WS_METHODS.repoMonitorListPresets]: () =>
        Effect.succeed({
          presets: [
            {
              id: TrimmedNonEmptyString.make("pr_review_comment_autofix"),
              name: TrimmedNonEmptyString.make("PR Review Autofix"),
              description: "Respond to PR comments",
              eventKinds: ["pr_comment" as const],
              defaultFilter: { excludeBots: true },
              actionKind: "launch_thread" as const,
              defaultRuntimeMode: "auto-accept-edits" as const,
              promptTemplate: TrimmedNonEmptyString.make("Fix {{body}}"),
              defaultCooldownSec: NonNegativeInt.make(60),
              defaultMaxTriggersPerHour: PositiveInt.make(20),
            },
          ],
        }),
      [WS_METHODS.repoMonitorUpsertRule]: (input: RepoMonitorRuleUpsertInput) =>
        Effect.sync(() => {
          const nextId = input.id ?? RepoMonitorRuleId.make("rule-mon-2");
          const created: RepoMonitorRule = {
            id: nextId,
            projectId: input.projectId,
            name: input.name,
            ...(input.description === undefined ? {} : { description: input.description }),
            enabled: input.enabled,
            eventKinds: input.eventKinds,
            filter: input.filter,
            actionKind: input.actionKind,
            targetThreadId: input.targetThreadId ?? null,
            ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
            promptTemplate: input.promptTemplate,
            cooldownSec: input.cooldownSec ?? NonNegativeInt.make(60),
            maxTriggersPerHour: input.maxTriggersPerHour ?? PositiveInt.make(20),
            ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
            createdAt: "2026-11-22T10:00:00.000Z",
            updatedAt: "2026-11-22T10:10:00.000Z",
          };
          const existingIndex = rules.findIndex((r) => r.id === nextId);
          if (existingIndex >= 0) {
            rules[existingIndex] = created;
          } else {
            rules.push(created);
          }
          return created;
        }),
      [WS_METHODS.repoMonitorDeleteRule]: ({ id }: { readonly id: RepoMonitorRuleId }) =>
        Effect.sync(() => {
          const idx = rules.findIndex((r) => r.id === id);
          if (idx >= 0) rules.splice(idx, 1);
          return { id, deleted: idx >= 0 };
        }),
      [WS_METHODS.repoMonitorDryRun]: ({ projectId: pid }: { readonly projectId: ProjectId }) =>
        Effect.succeed({
          results: [
            {
              ruleId,
              projectId: pid,
              evaluatedAt: "2026-11-22T10:12:00.000Z",
              matchedEvents: [],
              nextCursor: {
                projectId: pid,
                branchHeads: {},
                knownPullRequestNumbers: [],
                mergedPullRequestNumbers: [],
                knownPullRequestCommentIds: [],
                knownIssueKeys: [],
                knownIssueCommentIds: [],
                updatedAt: "2026-11-22T10:12:00.000Z",
              },
              renderedPrompts: [],
              skippedCount: NonNegativeInt.make(0),
            },
          ],
        }),
      [WS_METHODS.pmSetKillSwitch]: (input: { readonly active: boolean }) =>
        Effect.sync(() => {
          globalKillSwitch = input.active;
          return { scope: "global" as const, active: globalKillSwitch };
        }),
    } as unknown as RpcSession["client"];

    const supervisor = {
      target: { environmentId: envId, label: "Monitor Env" },
      session: yield* SubscriptionRef.make(Option.some({ client })),
      state: yield* SubscriptionRef.make({ phase: "connected" as const }),
    } as unknown as EnvironmentSupervisor["Service"];

    const registryService = EnvironmentRegistry.of({
      run: (_id, effect) =>
        effect.pipe(
          Effect.provideService(EnvironmentSupervisor, supervisor),
          Effect.provideService(RpcPermissionGuard, {
            authorize: () => Effect.void,
          }),
        ),
      followStream: (_id, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor, supervisor),
    } as Pick<
      EnvironmentRegistry["Service"],
      "run" | "followStream"
    > as EnvironmentRegistry["Service"]);

    const runtime = Atom.runtime(
      Layer.mergeAll(
        Layer.succeed(EnvironmentRegistry, registryService),
        Layer.succeed(EnvironmentSupervisor, supervisor),
      ),
    );

    return {
      atoms: createRepoMonitorEnvironmentAtoms(runtime),
      getRuleReads: () => ruleReads,
    };
  });
}

describe("createRepoMonitorEnvironmentAtoms", () => {
  it.effect(
    "lists rules/events/presets, invalidates on mutations, and tracks global kill switch",
    () =>
      Effect.gen(function* () {
        const { atoms, getRuleReads } = yield* createTestRepoMonitorAtoms();
        const registry = yield* Effect.acquireRelease(
          Effect.sync(() => AtomRegistry.make()),
          (r) => Effect.sync(() => r.dispose()),
        );

        const rulesAtom = atoms.listRules({ environmentId: envId, input: { projectId } });
        const eventsAtom = atoms.listEvents({ environmentId: envId, input: { projectId } });
        const presetsAtom = atoms.presets({ environmentId: envId, input: {} });

        yield* AtomRegistry.mount(registry, rulesAtom);
        yield* AtomRegistry.mount(registry, eventsAtom);
        yield* AtomRegistry.mount(registry, presetsAtom);

        const initialRules = yield* awaitAtomResult(registry, rulesAtom);
        expect(initialRules.rules).toHaveLength(1);
        expect(getRuleReads()).toBe(1);
        expect(initialRules.globalKillSwitch).toBe(true);

        const initialEvents = yield* awaitAtomResult(registry, eventsAtom);
        expect(countTriggeredRepoMonitorEvents(initialEvents.events)).toBe(1);

        const presetsResult = yield* awaitAtomResult(registry, presetsAtom);
        expect(presetsResult.presets).toHaveLength(1);

        const createExit = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.createRule, {
            environmentId: envId,
            input: buildRepoMonitorRuleUpsertFromPreset({
              preset: presetsResult.presets[0]!,
              projectId,
              environmentId: envId,
            }),
          }),
        );
        expect(AsyncResult.isSuccess(createExit)).toBe(true);

        const afterCreate = yield* awaitAtomResult(registry, rulesAtom);
        expect(afterCreate.rules).toHaveLength(2);
        expect(getRuleReads()).toBe(2);

        const toggleExit = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.updateRule, {
            environmentId: envId,
            input: buildRepoMonitorRuleToggleInput(afterCreate.rules[0]!, false),
          }),
        );
        expect(AsyncResult.isSuccess(toggleExit)).toBe(true);

        const afterToggle = yield* awaitAtomResult(registry, rulesAtom);
        expect(afterToggle.rules[0]!.enabled).toBe(false);

        const dryRunExit = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.dryRun, {
            environmentId: envId,
            input: { projectId, ruleId },
          }),
        );
        expect(AsyncResult.isSuccess(dryRunExit)).toBe(true);

        const ksExit = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.setGlobalKillSwitch, {
            environmentId: envId,
            input: { scope: "global", active: false },
          }),
        );
        expect(AsyncResult.isSuccess(ksExit)).toBe(true);
        const afterResume = yield* awaitAtomResult(registry, rulesAtom);
        expect(afterResume.globalKillSwitch).toBe(false);
        expect(getRuleReads()).toBe(4);

        const freshRegistry = yield* Effect.acquireRelease(
          Effect.sync(() => AtomRegistry.make()),
          (r) => Effect.sync(() => r.dispose()),
        );
        yield* AtomRegistry.mount(freshRegistry, rulesAtom);
        const reloadedRules = yield* awaitAtomResult(freshRegistry, rulesAtom);
        expect(reloadedRules.globalKillSwitch).toBe(false);

        const deleteExit = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.deleteRule, {
            environmentId: envId,
            input: { id: afterCreate.rules[1]!.id },
          }),
        );
        expect(AsyncResult.isSuccess(deleteExit)).toBe(true);

        const afterDelete = yield* awaitAtomResult(registry, rulesAtom);
        expect(afterDelete.rules).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it("parses and formats comma-separated filter lists cleanly", () => {
    expect(parseRepoMonitorCommaList(" main , feature/* , , ")).toEqual(["main", "feature/*"]);
    expect(parseRepoMonitorCommaList("   ")).toBeUndefined();
    expect(formatRepoMonitorCommaList(["bug", "urgent"])).toBe("bug, urgent");
    expect(formatRepoMonitorCommaList(undefined)).toBe("");
  });
});

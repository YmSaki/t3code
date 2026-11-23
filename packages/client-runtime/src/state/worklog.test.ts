import {
  type AgentWorklogEntry,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  WorklogEntryId,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE, PrimaryConnectionTarget } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { runAtomCommand } from "./runtime.ts";

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
import {
  buildWorklogWindowRange,
  createWorklogEnvironmentAtoms,
  mergeEnvironmentWorklogs,
  shiftWorklogAnchorMs,
} from "./worklog.ts";

function makeWorklogEntry(
  overrides: Partial<AgentWorklogEntry> & { readonly id: string },
): AgentWorklogEntry {
  return {
    source: "t3_run",
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("proj-1"),
    projectTitle: TrimmedNonEmptyString.make("T3 Code"),
    threadId: ThreadId.make(`thread-${overrides.id}`),
    runId: RunId.make(`run-${overrides.id}`),
    threadRole: "worker",
    provider: ProviderDriverKind.make("codex"),
    title: TrimmedNonEmptyString.make(`Task ${overrides.id}`),
    status: "completed",
    startedAt: "2026-11-22T01:00:00.000Z",
    endedAt: "2026-11-22T02:00:00.000Z",
    durationMs: NonNegativeInt.make(3_600_000),
    turnCount: PositiveInt.make(2),
    stats: {
      changedFilesCount: NonNegativeInt.make(2),
      commandsCount: NonNegativeInt.make(3),
      inputTokens: NonNegativeInt.make(4000),
      outputTokens: NonNegativeInt.make(1000),
      cachedTokens: NonNegativeInt.make(1500),
      estimatedCostUsd: 0.1,
    },
    ...overrides,
  };
}

describe("client-runtime worklog state", () => {
  it("merges entries across multiple environments, deduplicates overlapping imported CLI runs, and computes daily layout & stats", () => {
    const hubEntry = makeWorklogEntry({
      id: WorklogEntryId.make("wl-hub-1"),
      environmentId: EnvironmentId.make("env-hub"),
      provider: ProviderDriverKind.make("codex"),
      startedAt: "2026-11-22T01:00:00.000Z",
      endedAt: "2026-11-22T02:30:00.000Z",
      durationMs: NonNegativeInt.make(5_400_000),
    });

    const overlappingCli = makeWorklogEntry({
      id: WorklogEntryId.make("wl-hub-cli-dup"),
      source: "imported_cli",
      environmentId: EnvironmentId.make("env-hub"),
      provider: ProviderDriverKind.make("codex"),
      threadId: null,
      runId: null,
      startedAt: "2026-11-22T01:15:00.000Z",
      endedAt: "2026-11-22T02:00:00.000Z",
      durationMs: NonNegativeInt.make(2_700_000),
    });

    const workerPcEntry = makeWorklogEntry({
      id: WorklogEntryId.make("wl-pc-1"),
      environmentId: EnvironmentId.make("env-laptop"),
      provider: ProviderDriverKind.make("claudeAgent"),
      projectId: ProjectId.make("proj-2"),
      projectTitle: TrimmedNonEmptyString.make("Mobile App"),
      startedAt: "2026-11-22T01:30:00.000Z",
      endedAt: "2026-11-22T03:30:00.000Z",
      durationMs: NonNegativeInt.make(7_200_000),
    });

    const merged = mergeEnvironmentWorklogs({
      entriesByEnvironment: [[hubEntry, overlappingCli], [workerPcEntry]],
      mode: "merged",
      gapToleranceMinutes: 5,
      timeZone: "UTC",
    });

    expect(merged.entries.map((e) => e.id)).toEqual(["wl-hub-1", "wl-pc-1"]);
    expect(merged.blocks).toHaveLength(2);
    expect(merged.stats.totalEntriesCount).toBe(2);
    expect(merged.stats.maxConcurrency).toBe(2);
    expect(merged.stats.byProvider).toHaveLength(2);
    expect(merged.dayLayouts["2026-11-22"]).toHaveLength(2);
    expect(merged.dayLayouts["2026-11-22"]?.[0]?.columnCount).toBe(2);
  });

  it("builds deterministic week/day windows and shifts anchor timestamps", () => {
    // 2026-11-22 is a Sunday. With weekStartsOn=1 (Monday), the week is 2026-11-16..2026-11-22
    const anchorMs = Date.parse("2026-11-22T12:00:00.000Z");
    const week = buildWorklogWindowRange({
      anchorMs,
      viewMode: "week",
      timeZone: "Asia/Tokyo",
      weekStartsOn: 1,
    });

    expect(week.days).toHaveLength(7);
    expect(week.days[0]?.dayKey).toBe("2026-11-16");
    expect(week.days[6]?.dayKey).toBe("2026-11-22");
    expect(week.days[6]?.dateLabel).toBe("11/22");

    const dayOnly = buildWorklogWindowRange({
      anchorMs: shiftWorklogAnchorMs(anchorMs, -1, "day"),
      viewMode: "day",
      timeZone: "Asia/Tokyo",
    });
    expect(dayOnly.days).toHaveLength(1);
    expect(dayOnly.days[0]?.dayKey).toBe("2026-11-21");
  });

  it.effect(
    "wires query, stats, listIcalFeeds, and commands via createWorklogEnvironmentAtoms",
    () =>
      Effect.gen(function* () {
        const envId = EnvironmentId.make("env-hub");
        const sampleEntry = makeWorklogEntry({ id: WorklogEntryId.make("wl-rpc-1") });
        let feedCount = 0;

        const client = {
          [WS_METHODS.worklogQuery]: () =>
            Effect.succeed({
              entries: [sampleEntry],
              blocks: [],
              dailySummaries: [],
              dayLayouts: {},
            }),
          [WS_METHODS.worklogListIcalFeeds]: () =>
            Effect.succeed({
              feeds: Array.from({ length: feedCount }, (_, index) => ({
                id: `feed-${index + 1}`,
                name: `Feed ${index + 1}`,
                enabled: true,
                timeZone: "UTC",
                gapToleranceMinutes: 5,
                filter: {},
                includeStatsInDescription: true,
                includeThreadUrl: true,
                revokedAt: null,
                createdAt: "2026-11-22T00:00:00.000Z",
                updatedAt: "2026-11-22T00:00:00.000Z",
              })),
            }),
          [WS_METHODS.worklogCreateIcalFeed]: ({ name }: { name: string }) =>
            Effect.sync(() => {
              feedCount += 1;
              return {
                feed: {
                  id: `feed-${feedCount}`,
                  name,
                  enabled: true,
                  timeZone: "UTC",
                  gapToleranceMinutes: 5,
                  filter: {},
                  includeStatsInDescription: true,
                  includeThreadUrl: true,
                  revokedAt: null,
                  createdAt: "2026-11-22T00:00:00.000Z",
                  updatedAt: "2026-11-22T00:00:00.000Z",
                },
                rawToken: "raw-token-123",
              };
            }),
        } as unknown as RpcSession["client"];

        const supervisorState = yield* SubscriptionRef.make({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online" as const,
          phase: "connected" as const,
          attempt: 1,
          generation: 1,
        });
        const supervisor = EnvironmentSupervisor.of({
          target: new PrimaryConnectionTarget({
            environmentId: envId,
            label: "Hub",
            httpBaseUrl: "https://hub.example.test",
            wsBaseUrl: "wss://hub.example.test",
          }),
          state: supervisorState,
          session: yield* SubscriptionRef.make(
            Option.some({
              client,
              scopes: ["orchestration.read", "orchestration.operate"],
            } as unknown as RpcSession),
          ),
        } as unknown as EnvironmentSupervisor["Service"]);

        const streamGeneration = yield* SubscriptionRef.make(0);
        const run: EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
          effect.pipe(
            Effect.provideService(EnvironmentSupervisor, supervisor),
            Effect.provideService(RpcPermissionGuard, {
              authorize: () => Effect.void,
            }),
          );
        const followStream: EnvironmentRegistry["Service"]["followStream"] = (_id, stream) =>
          SubscriptionRef.changes(streamGeneration).pipe(
            Stream.switchMap(() =>
              Stream.provideService(stream, EnvironmentSupervisor, supervisor),
            ),
          );
        const environmentRegistry = EnvironmentRegistry.of({
          run,
          followStream,
          stateChanges: () => SubscriptionRef.changes(supervisorState),
        } as unknown as EnvironmentRegistry["Service"]);

        const runtime = Atom.runtime(
          Layer.mergeAll(
            Layer.succeed(EnvironmentRegistry, environmentRegistry),
            Layer.succeed(EnvironmentSupervisor, supervisor),
          ),
        );
        const worklogAtoms = createWorklogEnvironmentAtoms(runtime);
        const registry = yield* Effect.acquireRelease(
          Effect.sync(() => AtomRegistry.make()),
          (r) => Effect.sync(() => r.dispose()),
        );

        const queryAtom = worklogAtoms.query({
          environmentId: envId,
          input: { timeZone: "UTC" },
        });
        const feedsAtom = worklogAtoms.listIcalFeeds({
          environmentId: envId,
          input: {},
        });

        const unmountQuery = registry.mount(queryAtom);
        const unmountFeeds = registry.mount(feedsAtom);
        try {
          const queryResult = yield* AtomRegistry.getResult(registry, queryAtom, {
            suspendOnWaiting: true,
          });
          expect(queryResult.entries).toHaveLength(1);

          const feedsBefore = yield* AtomRegistry.getResult(registry, feedsAtom, {
            suspendOnWaiting: true,
          });
          expect(feedsBefore.feeds).toHaveLength(0);

          const created = yield* Effect.promise(() =>
            runAtomCommand(registry, worklogAtoms.createIcalFeed, {
              environmentId: envId,
              input: { name: "New Feed", timeZone: "UTC" },
            }),
          );
          expect(created._tag).toBe("Success");

          const feedsAfter = yield* AtomRegistry.getResult(registry, feedsAtom, {
            suspendOnWaiting: true,
          });
          expect(feedsAfter.feeds).toHaveLength(1);
          expect(feedsAfter.feeds[0]?.name).toBe("Feed 1");
        } finally {
          unmountQuery();
          unmountFeeds();
        }
      }).pipe(Effect.scoped),
  );
});

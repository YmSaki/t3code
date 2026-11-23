// @effect-diagnostics anyUnknownInErrorContext:off -- test mock for EnvironmentRegistry
import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  EnvironmentId,
  MetaProjectId,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type MetaProject,
  type MetaProjectListResult,
  type MetaProjectMutation,
} from "@t3tools/contracts";
// @effect-diagnostics anyUnknownInErrorContext:off -- test mock for EnvironmentRegistry
import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics anyUnknownInErrorContext:off -- test mock for EnvironmentRegistry
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
// @effect-diagnostics anyUnknownInErrorContext:off -- test mock for EnvironmentRegistry
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

// @effect-diagnostics anyUnknownInErrorContext:off -- test mock for EnvironmentRegistry
import { EnvironmentRegistry } from "../connection/registry.ts";
// @effect-diagnostics anyUnknownInErrorContext:off -- test mock for EnvironmentRegistry
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
// @effect-diagnostics anyUnknownInErrorContext:off -- test mock for EnvironmentRegistry
import {
  applyOptimisticMetaProjectMutation,
  createMetaProjectEnvironmentAtoms,
} from "./metaProjects.ts";
// @effect-diagnostics anyUnknownInErrorContext:off -- test mock for EnvironmentRegistry
import { runAtomCommand } from "./runtime.ts";

const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationOperateScope],
      permissions: [AuthOrchestrationOperateScope],
    }),
  ),
);

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));

const envId = EnvironmentId.make("env-hub");
const projId = ProjectId.make("proj-web");
const projApiId = ProjectId.make("proj-api");
const mpId = MetaProjectId.make("mp-platform");
const threadId = ThreadId.make("th-pm");

const baseMetaProject: MetaProject = {
  id: mpId,
  title: "Platform",
  description: "Shared suite",
  instructionsMd: "Keep core pure.",
  members: [
    {
      environmentId: envId,
      projectId: projId,
      role: "frontend",
    },
  ],
  threadLinks: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
  deletedAt: null,
};

describe("applyOptimisticMetaProjectMutation", () => {
  it("applies update, member, thread link, and delete mutations deterministically", () => {
    const updated = applyOptimisticMetaProjectMutation(
      [baseMetaProject],
      {
        type: "metaProject.update",
        metaProjectId: mpId,
        title: "Platform V2",
        archived: true,
      },
      "2026-03-02T00:00:00.000Z",
    );
    expect(updated[0]?.title).toBe("Platform V2");
    expect(updated[0]?.archivedAt).toBe("2026-03-02T00:00:00.000Z");

    const linked = applyOptimisticMetaProjectMutation(updated, {
      type: "metaProject.linkThread",
      metaProjectId: mpId,
      threadLink: { environmentId: envId, threadId, role: "pm" },
    });
    expect(linked[0]?.threadLinks).toHaveLength(1);

    const removedMember = applyOptimisticMetaProjectMutation(linked, {
      type: "metaProject.removeMember",
      metaProjectId: mpId,
      environmentId: envId,
      projectId: projId,
    });
    expect(removedMember[0]?.members).toHaveLength(0);

    const deleted = applyOptimisticMetaProjectMutation(removedMember, {
      type: "metaProject.delete",
      metaProjectId: mpId,
    });
    expect(deleted).toEqual([]);
  });
});

it.effect("refreshes queries and surfaces optimistic updates during metaProject mutations", () =>
  Effect.gen(function* () {
    let serverProjects: ReadonlyArray<MetaProject> = [baseMetaProject];
    const gate = yield* Deferred.make<void>();
    const mutationStarted = yield* Deferred.make<void>();

    const client = {
      [WS_METHODS.metaProjectsList]: () =>
        Effect.sync((): MetaProjectListResult => ({
          metaProjects: serverProjects,
          updatedAt: "2026-03-01T00:00:00.000Z",
        })),
      [WS_METHODS.metaProjectsGetTree]: () =>
        Effect.sync(() => ({
          metaProjects: [],
          uncategorizedRepositories: [],
        })),
      [WS_METHODS.metaProjectsGetContext]: () => Effect.succeed(null),
      [WS_METHODS.metaProjectsGetRollup]: () =>
        Effect.sync(() => ({
          pullRequests: [],
          issues: [],
          activeThreads: [],
          counts: {
            pullRequests: {
              total: 0,
              open: 0,
              draft: 0,
              failingChecks: 0,
              conflicting: 0,
              reviewRequested: 0,
              changesRequested: 0,
              approved: 0,
              merged: 0,
              closed: 0,
            },
            issues: {
              total: 0,
              open: 0,
              closed: 0,
              assignedToViewer: 0,
              mentioned: 0,
            },
            threads: {
              total: 0,
              active: 0,
              running: 0,
              needsAttention: 0,
              pm: 0,
              crossCutting: 0,
              standard: 0,
              settled: 0,
            },
          },
        })),
      [WS_METHODS.metaProjectsMutate]: (mutation: MetaProjectMutation) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(mutationStarted, undefined);
          yield* Deferred.await(gate);
          serverProjects = applyOptimisticMetaProjectMutation(
            serverProjects,
            mutation,
            "2026-03-02T00:00:00.000Z",
          );
          if (mutation.type === "metaProject.delete") {
            return { metaProjectId: mutation.metaProjectId, deleted: true };
          }
          if (mutation.type === "metaProject.removeMember") {
            return {
              metaProject: serverProjects[0] ?? baseMetaProject,
              removed: true,
            };
          }
          if (mutation.type === "metaProject.unlinkThread") {
            return {
              metaProject: serverProjects[0] ?? baseMetaProject,
              unlinked: true,
            };
          }
          return {
            metaProject: serverProjects[0] ?? baseMetaProject,
          };
        }),
    } as unknown as RpcSession["client"];

    const supervisor = EnvironmentSupervisor.of({
      target: { environmentId: envId, label: "Meta Test Env" },
      state: yield* SubscriptionRef.make({ phase: "connected" as const }),
      session: yield* SubscriptionRef.make(Option.some({ client })),
    } as unknown as EnvironmentSupervisor["Service"]);

    const registryLayer = Layer.succeed(
      EnvironmentRegistry,
      EnvironmentRegistry.of({
        getSupervisor: () => supervisor,
        run: (_id: EnvironmentId, effect: Effect.Effect<unknown, unknown, EnvironmentSupervisor>) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        withSupervisor: (
          _id: EnvironmentId,
          effect: Effect.Effect<unknown, unknown, EnvironmentSupervisor>,
        ) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        followStream: (
          _id: EnvironmentId,
          stream: Stream.Stream<unknown, unknown, EnvironmentSupervisor>,
        ) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as unknown as EnvironmentRegistry["Service"]),
    );

    const atoms = createMetaProjectEnvironmentAtoms(Atom.runtime(registryLayer));
    const registry = yield* Effect.acquireRelease(
      Effect.sync(() => AtomRegistry.make()),
      (reg) => Effect.sync(() => reg.dispose()),
    );

    const listUpdates = yield* Queue.unbounded<MetaProjectListResult>();
    const unsub = registry.subscribe(
      atoms.list({ environmentId: envId, input: {} }),
      (result) => {
        if (AsyncResult.isSuccess(result)) {
          Queue.offerUnsafe(listUpdates, result.value);
        }
      },
      { immediate: true },
    );

    const initial = yield* Queue.take(listUpdates);
    expect(initial.metaProjects).toHaveLength(1);
    expect(initial.metaProjects[0]?.members).toHaveLength(1);

    const addMemberPromise = runAtomCommand(registry, atoms.addMember, {
      environmentId: envId,
      input: {
        metaProjectId: mpId,
        member: {
          environmentId: envId,
          projectId: projApiId,
          role: "backend",
        },
      },
    });

    yield* Deferred.await(mutationStarted);
    const optimistic = yield* Queue.take(listUpdates);
    expect(optimistic.metaProjects[0]?.members.map((m) => m.projectId)).toEqual([
      projId,
      projApiId,
    ]);

    yield* Deferred.succeed(gate, undefined);
    const commandResult = yield* Effect.promise(() => addMemberPromise);
    expect(commandResult._tag).toBe("Success");

    const refreshed = yield* Queue.take(listUpdates);
    expect(refreshed.metaProjects[0]?.members.map((m) => m.projectId)).toEqual([projId, projApiId]);

    const selected = registry.get(
      atoms.get({ environmentId: envId, input: { metaProjectId: mpId } }),
    );
    expect(AsyncResult.isSuccess(selected) ? selected.value?.members : []).toHaveLength(2);

    unsub();
  }).pipe(Effect.scoped),
);

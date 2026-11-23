import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type AuthSessionState,
  type PmBoardWorkerSummary,
  type PmWorkerPolicy,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE, type PreparedConnection } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  buildPmPolicyUpdateInput,
  countActivePmWorkers,
  createPmBoardEnvironmentAtoms,
} from "./pmBoard.ts";
import { awaitAtomResult, runAtomCommand } from "./runtime.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessionsAtom }),
}));

const grantedSession: AuthSessionState = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [AuthOrchestrationOperateScope],
  permissions: [AuthOrchestrationOperateScope],
};

const sessionsAtom = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.success(grantedSession)),
);

const envId = EnvironmentId.make("env-pm");
const pmThreadId = ThreadId.make("thread-pm");
const projId = ProjectId.make("proj-pm");

const basePolicy: PmWorkerPolicy = {
  maxConcurrentWorkers: 3,
  requireWorktreeIsolation: true,
  allowNestedDelegation: false,
  allowedTargets: [],
  maxDelegatedTurns: 20,
  directEditSuppressedProviders: [],
};

function createTestBoardAtoms() {
  return Effect.gen(function* () {
    let activeKillSwitch = false;
    let boardReads = 0;
    const workers: Array<PmBoardWorkerSummary> = [
      {
        threadId: ThreadId.make("w-1"),
        environmentId: envId,
        projectId: projId,
        title: "Build UI",
        status: "running",
        targetRepoRole: "frontend",
        providerInstanceId: null,
        turnCount: 2,
        lastMessagePreview: "Working on layout",
        startedAt: "2026-11-22T10:00:00.000Z",
        updatedAt: "2026-11-22T10:02:00.000Z",
      },
    ];
    const calls: Array<string> = [];

    const client = {
      [WS_METHODS.pmGetBoard]: () =>
        Effect.sync(() => {
          boardReads += 1;
          return {
            pmThreadId,
            metaProjectId: "meta-1",
            policy: basePolicy,
            killSwitchActive: activeKillSwitch,
            delegatedTurnCount: workers.length,
            workers: [...workers],
            generatedAt: "2026-11-22T10:05:00.000Z",
            pendingQuestions: [],
          };
        }),
      [WS_METHODS.pmSetRole]: (input: { readonly role: string }) =>
        Effect.sync(() => {
          calls.push(`setRole:${input.role}`);
          return {
            threadId: pmThreadId,
            metaProjectId: "meta-1",
            role: input.role,
            delegationDepth: 0,
            policy: basePolicy,
            killSwitchActive: activeKillSwitch,
            delegatedTurnCount: 1,
            createdAt: "2026-11-22T10:00:00.000Z",
            updatedAt: "2026-11-22T10:05:00.000Z",
          };
        }),
      [WS_METHODS.pmSetKillSwitch]: (input: { readonly active: boolean }) =>
        Effect.sync(() => {
          activeKillSwitch = input.active;
          calls.push(`killSwitch:${input.active}`);
          return { scope: "thread" as const, active: input.active, threadId: pmThreadId };
        }),
      [WS_METHODS.pmStopAllWorkers]: () =>
        Effect.sync(() => {
          activeKillSwitch = true;
          workers[0] = { ...workers[0]!, status: "cancelled" };
          calls.push("stopAll");
          return {
            pmThreadId,
            killSwitchActive: true,
            stoppedWorkerThreadIds: [ThreadId.make("w-1")],
          };
        }),
      [WS_METHODS.pmDispatchBatch]: () =>
        Effect.sync(() => {
          calls.push("dispatchBatch");
          return {
            pmThreadId,
            dispatched: [],
            rejected: [],
          };
        }),
    } as unknown as RpcSession["client"];

    const supervisor = EnvironmentSupervisor.of({
      target: { environmentId: envId, label: "PM Env" },
      session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
      state: yield* SubscriptionRef.make({
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        network: "online",
        phase: "connected",
        attempt: 1,
        generation: 1,
      }),
      prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } as unknown as EnvironmentSupervisor["Service"]);

    const run: EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor, supervisor);
    const followStream: EnvironmentRegistry["Service"]["followStream"] = (_id, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisor);
    const registryService = EnvironmentRegistry.of({
      run,
      followStream,
    } as unknown as EnvironmentRegistry["Service"]);

    const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, registryService));
    return {
      atoms: createPmBoardEnvironmentAtoms(runtime),
      calls,
      getBoardReads: () => boardReads,
    };
  });
}

describe("createPmBoardEnvironmentAtoms", () => {
  it.effect("reads the PM board and refreshes cached queries after commands", () =>
    Effect.gen(function* () {
      const { atoms, calls, getBoardReads } = yield* createTestBoardAtoms();
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (r) => Effect.sync(() => r.dispose()),
      );
      registry.mount(sessionsAtom(envId));
      const boardAtom = atoms.board({ environmentId: envId, input: { pmThreadId } });
      yield* AtomRegistry.mount(registry, boardAtom);

      const initial = yield* awaitAtomResult(registry, boardAtom);
      expect(initial.killSwitchActive).toBe(false);
      expect(countActivePmWorkers(initial.workers)).toBe(1);
      expect(getBoardReads()).toBe(1);

      const stopExit = yield* Effect.promise(() =>
        runAtomCommand(registry, atoms.stopAll, {
          environmentId: envId,
          input: { pmThreadId, activateKillSwitch: true, reason: "halt" },
        }),
      );
      expect(AsyncResult.isSuccess(stopExit)).toBe(true);

      const afterStop = yield* awaitAtomResult(registry, boardAtom);
      expect(afterStop.killSwitchActive).toBe(true);
      expect(countActivePmWorkers(afterStop.workers)).toBe(0);

      const resetExit = yield* Effect.promise(() =>
        runAtomCommand(registry, atoms.resetKillSwitch, {
          environmentId: envId,
          input: { scope: "thread", threadId: pmThreadId, active: false },
        }),
      );
      expect(AsyncResult.isSuccess(resetExit)).toBe(true);
      expect(calls).toEqual(["stopAll", "killSwitch:false"]);
    }).pipe(Effect.scoped),
  );

  it("builds PM policy update inputs cleanly", () => {
    expect(
      buildPmPolicyUpdateInput({
        environmentId: envId,
        threadId: pmThreadId,
        role: "pm",
        policy: basePolicy,
        metaProjectId: "meta-1",
      }),
    ).toEqual({
      environmentId: envId,
      input: {
        threadId: pmThreadId,
        role: "pm",
        policy: basePolicy,
        metaProjectId: "meta-1",
      },
    });
  });
});

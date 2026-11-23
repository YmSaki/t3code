import {
  AuthSettingsWriteScope,
  EnvironmentId,
  WS_METHODS,
  type AuthSessionState,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadStreamItem,
  type PeerLinkSummary,
  type PeerNodeHealthListResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { AVAILABLE_CONNECTION_STATE, type PreparedConnection } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { LinkedThreadView } from "../linkedThread.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { v2MessageRow, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { createPeerLinkEnvironmentAtoms, linkThroughRoutes } from "./peerLinks.ts";
import { awaitAtomResult, runAtomCommand } from "./runtime.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: mockSessions }),
}));

const mockSessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);

// regression: #40544 earlier messages vanished when a linked thread's view opened again
it.effect(
  "keeps loaded messages when a linked thread's view opens again on the same snapshot",
  () =>
    Effect.gen(function* () {
      const recent = v2MessageRow("Recent message", 2);
      const older = v2MessageRow("Earlier message", 1);
      const snapshot = (historyCursor: string): OrchestrationV2ThreadStreamItem => ({
        kind: "snapshot",
        snapshotSequence: 7,
        projection: { ...v2Projection, turnItems: [recent.item], visibleTurnItems: [recent] },
        historyCursor,
        hasMoreHistory: true,
      });
      const subscriptions = yield* Queue.unbounded<{
        items: Queue.Queue<OrchestrationV2ThreadStreamItem>;
        stopped: Deferred.Deferred<void>;
      }>();
      const requested: string[] = [];
      const client = {
        [WS_METHODS.peerLinksSubscribeThread]: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const items = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
              const stopped = yield* Deferred.make<void>();
              yield* Effect.addFinalizer(() => Deferred.succeed(stopped, undefined));
              yield* Queue.offer(subscriptions, { items, stopped });
              return Stream.fromQueue(items);
            }),
          ),
        [WS_METHODS.peerLinksThreadHistoryPage]: ({ cursor }: { cursor: string }) =>
          Effect.sync((): OrchestrationV2ThreadHistoryPage => {
            requested.push(cursor);
            return cursor === "before-recent"
              ? {
                  snapshotSequence: 7,
                  items: [older],
                  nextCursor: "before-earlier",
                  hasMoreHistory: true,
                }
              : { snapshotSequence: 7, items: [], nextCursor: null, hasMoreHistory: false };
          }),
      } as unknown as RpcSession["client"];
      const target = {
        environmentId: EnvironmentId.make("via"),
        input: { environmentId: EnvironmentId.make("linked"), threadId: v2ThreadId },
      };
      const supervisor = EnvironmentSupervisor.of({
        target: { environmentId: target.environmentId, label: "Via" },
        session: yield* SubscriptionRef.make(Option.some({ client })),
      } as unknown as EnvironmentSupervisor["Service"]);
      const environment = EnvironmentRegistry.of({
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as Pick<EnvironmentRegistry["Service"], "followStream"> as EnvironmentRegistry["Service"]);
      const links = createPeerLinkEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry, environment)),
      );
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (registry) => Effect.sync(() => registry.dispose()),
      );
      const views = yield* Queue.unbounded<LinkedThreadView>();
      const open = () =>
        registry.subscribe(links.threadView(target), (result) => {
          if (AsyncResult.isSuccess(result)) Queue.offerUnsafe(views, result.value);
        });
      const visibleMessages = (view: LinkedThreadView) =>
        view.thread.projection?.visibleTurnItems.map((row) => row.sourceItemId);

      const unmount = open();
      const first = yield* Queue.take(subscriptions);
      yield* Queue.offer(first.items, snapshot("before-recent"));
      (yield* Queue.take(views)).loadEarlier();
      yield* Queue.take(views); // Loading.
      expect(visibleMessages(yield* Queue.take(views))).toEqual([
        older.sourceItemId,
        recent.sourceItemId,
      ]);
      unmount();
      yield* Deferred.await(first.stopped);

      open();
      const reopened = yield* Queue.take(subscriptions);
      yield* Queue.offer(reopened.items, snapshot("before-recent"));
      const resumed = yield* Queue.take(views);
      expect(visibleMessages(resumed)).toEqual([older.sourceItemId, recent.sourceItemId]);
      // Paging goes on from where the closed view stopped, without reading the same page again.
      expect(resumed.thread.historyCursor).toBe("before-earlier");
      expect(requested).toEqual(["before-recent"]);

      // A snapshot of another window replaces the rows held for the old one.
      yield* Queue.offer(reopened.items, snapshot("new-window"));
      const refreshed = yield* Queue.take(views);
      expect(visibleMessages(refreshed)).toEqual([recent.sourceItemId]);
      expect(refreshed.thread.historyCursor).toBe("new-window");
    }).pipe(Effect.scoped),
);

const now = DateTime.makeUnsafe("2026-11-20T00:00:00.000Z");
const id = (value: string) => EnvironmentId.make(value);

const link = (target: string, overrides: Partial<PeerLinkSummary> = {}): PeerLinkSummary => ({
  environmentId: id(target),
  label: target,
  urls: [`https://${target}.example`],
  access: "full-access",
  status: "reachable",
  linkedAt: now,
  lastReachedAt: now,
  lastError: null,
  expiresAt: DateTime.makeUnsafe("2026-12-20T00:00:00.000Z"),
  ...overrides,
});

describe("linkThroughRoutes", () => {
  it("offers only machines another environment reaches over a full-access link that answers", () => {
    const routes = linkThroughRoutes({
      sourceEnvironmentId: id("source"),
      hosts: [
        { environmentId: id("source"), links: [link("own")] },
        {
          environmentId: id("via"),
          links: [
            link("open"),
            link("source"),
            link("supervised", { access: "approval-required" }),
            link("down", { status: "unreachable" }),
            link("lapsed", { expiresAt: now }),
          ],
        },
        { environmentId: id("later"), links: [link("open")] },
      ],
      now,
    });
    expect([...routes.values()]).toEqual([
      {
        viaEnvironmentId: id("via"),
        environmentId: id("open"),
        label: "open",
        urls: ["https://open.example"],
      },
    ]);
  });
});

describe("peerHealth atoms", () => {
  it.effect("reads peer health list and refreshes after probeHealth", () =>
    Effect.gen(function* () {
      const hubId = EnvironmentId.make("hub");
      const workerId = EnvironmentId.make("worker-1");
      let latencyMs = 80;
      let listCalls = 0;
      let probeCalls = 0;

      const snapshot = (): PeerNodeHealthListResult => ({
        nodes: [
          {
            environmentId: workerId,
            label: "Worker 1",
            online: true,
            grade: "healthy",
            recommendedScore: 92,
            reasons: [],
            latencyMs,
            activeWorkers: 1,
            maxWorkers: 8,
            checkedAt: "2026-11-22T00:00:00.000Z",
            lastError: null,
          },
        ],
        recommendedEnvironmentId: workerId,
        checkedAt: "2026-11-22T00:00:00.000Z",
      });

      const client = {
        [WS_METHODS.peerHealthList]: () =>
          Effect.sync(() => {
            listCalls += 1;
            return snapshot();
          }),
        [WS_METHODS.peerHealthProbe]: () =>
          Effect.sync(() => {
            probeCalls += 1;
            latencyMs = 24;
            return snapshot();
          }),
        [WS_METHODS.peerLinksList]: () => Effect.succeed({ links: [] }),
        [WS_METHODS.peerLinksNames]: () => Effect.succeed({ links: [] }),
      } as unknown as RpcSession["client"];

      const supervisor = EnvironmentSupervisor.of({
        target: { environmentId: hubId, label: "Hub" },
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

      const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, registryService));
      const links = createPeerLinkEnvironmentAtoms(runtime);
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (r) => Effect.sync(() => r.dispose()),
      );
      registry.mount(mockSessions(hubId));
      registry.set(
        mockSessions(hubId),
        AsyncResult.success({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "test",
          },
          scopes: [AuthSettingsWriteScope],
          permissions: [AuthSettingsWriteScope],
        }),
      );

      const healthAtom = links.health({ environmentId: hubId, input: {} });
      yield* AtomRegistry.mount(registry, healthAtom);

      const initial = yield* awaitAtomResult(registry, healthAtom);
      expect(initial.nodes[0]?.latencyMs).toBe(80);
      expect(listCalls).toBe(1);

      const probeExit = yield* Effect.promise(() =>
        runAtomCommand(registry, links.probeHealth, {
          environmentId: hubId,
          input: {},
        }),
      );
      expect(probeExit._tag).toBe("Success");
      expect(probeCalls).toBe(1);

      const refreshed = yield* awaitAtomResult(registry, healthAtom);
      expect(refreshed.nodes[0]?.latencyMs).toBe(24);
      expect(listCalls).toBe(2);
    }).pipe(Effect.scoped),
  );
});

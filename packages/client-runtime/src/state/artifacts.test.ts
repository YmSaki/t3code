// @effect-diagnostics anyUnknownInErrorContext:off -- test mock for EnvironmentRegistry
import {
  type Artifact,
  ArtifactId,
  type ArtifactListResult,
  type ArtifactPatchStateResult,
  type ArtifactResult,
  type ArtifactVersion,
  type ArtifactVersionSummary,
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  EnvironmentId,
  ProjectId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
// @effect-diagnostics anyUnknownInErrorContext:off -- test mock for EnvironmentRegistry
import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics anyUnknownInErrorContext:off -- test mock for EnvironmentRegistry
import { vi } from "vite-plus/test";
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
import { createArtifactEnvironmentAtoms } from "./artifacts.ts";
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

const environmentId = EnvironmentId.make("env-artifacts");
const projectId = ProjectId.make("project-artifacts");
const threadId = ThreadId.make("thread-artifacts");
const artifactId = ArtifactId.make("artifact-1");
const at = "2026-10-05T00:00:00.000Z";

function makeArtifactRecord(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: artifactId,
    environmentId,
    projectId,
    threadId,
    kind: "markdown",
    title: "Plan",
    currentVersion: 1,
    stateVersion: 0,
    state: {},
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    ...overrides,
  };
}

function makeVersionRecord(overrides: Partial<ArtifactVersion> = {}): ArtifactVersion {
  return {
    artifactId,
    version: 1,
    author: "agent",
    content: "- [ ] Step 1",
    createdAt: at,
    ...overrides,
  };
}

describe("createArtifactEnvironmentAtoms", () => {
  it.effect("queries and mutates artifacts and invalidates cached list/get/version queries", () =>
    Effect.gen(function* () {
      let currentArtifact = makeArtifactRecord();
      let currentVersion = makeVersionRecord();
      const versions: ArtifactVersionSummary[] = [
        {
          artifactId,
          version: 1,
          author: "agent",
          contentLength: currentVersion.content.length,
          createdAt: at,
        },
      ];
      let getCallCount = 0;
      let listCallCount = 0;
      const recordedActions: Array<unknown> = [];

      const client = {
        [WS_METHODS.artifactsList]: () =>
          Effect.sync((): ArtifactListResult => {
            listCallCount += 1;
            return { artifacts: currentArtifact.archivedAt ? [] : [currentArtifact] };
          }),
        [WS_METHODS.artifactsGet]: (input: { readonly version?: number }) =>
          Effect.sync((): ArtifactResult => {
            getCallCount += 1;
            return {
              artifact: currentArtifact,
              version: input.version === 1 ? makeVersionRecord({ version: 1 }) : currentVersion,
            };
          }),
        [WS_METHODS.artifactsListVersions]: () => Effect.sync(() => ({ versions: [...versions] })),
        [WS_METHODS.artifactsCreate]: (input: {
          readonly title: string;
          readonly kind: "html" | "markdown";
          readonly content: string;
        }) =>
          Effect.sync((): ArtifactResult => {
            currentArtifact = makeArtifactRecord({
              title: input.title,
              kind: input.kind,
            });
            currentVersion = makeVersionRecord({ content: input.content });
            return { artifact: currentArtifact, version: currentVersion };
          }),
        [WS_METHODS.artifactsRevise]: (input: {
          readonly content: string;
          readonly summary?: string;
        }) =>
          Effect.sync((): ArtifactResult => {
            currentArtifact = makeArtifactRecord({
              ...currentArtifact,
              currentVersion: 2,
            });
            currentVersion = makeVersionRecord({
              version: 2,
              author: "user",
              content: input.content,
              ...(input.summary === undefined ? {} : { summary: input.summary }),
            });
            versions.unshift({
              artifactId,
              version: 2,
              author: "user",
              contentLength: input.content.length,
              createdAt: at,
            });
            return { artifact: currentArtifact, version: currentVersion };
          }),
        [WS_METHODS.artifactsSwitchVersion]: (input: { readonly version: number }) =>
          Effect.sync((): ArtifactResult => {
            currentArtifact = makeArtifactRecord({
              ...currentArtifact,
              currentVersion: input.version,
            });
            return {
              artifact: currentArtifact,
              version: makeVersionRecord({ version: input.version }),
            };
          }),
        [WS_METHODS.artifactsPatchState]: (input: {
          readonly patch: Readonly<Record<string, unknown>>;
        }) =>
          Effect.sync((): ArtifactPatchStateResult => {
            currentArtifact = makeArtifactRecord({
              ...currentArtifact,
              stateVersion: currentArtifact.stateVersion + 1,
              state: { ...currentArtifact.state, ...input.patch },
            });
            return { artifact: currentArtifact };
          }),
        [WS_METHODS.artifactsSubmitUserAction]: (input: unknown) =>
          Effect.sync(() => {
            recordedActions.push(input);
            return {
              accepted: true,
              stateVersion: currentArtifact.stateVersion,
              startedTurn: true,
              prompt: "Action submitted",
            };
          }),
        [WS_METHODS.artifactsArchive]: (input: { readonly archived: boolean }) =>
          Effect.sync((): Artifact => {
            currentArtifact = makeArtifactRecord({
              ...currentArtifact,
              archivedAt: input.archived ? at : null,
            });
            return currentArtifact;
          }),
      } as unknown as RpcSession["client"];

      const supervisor = EnvironmentSupervisor.of({
        target: { environmentId, label: "Artifact Test Env" },
        state: yield* SubscriptionRef.make({ phase: "connected" as const }),
        session: yield* SubscriptionRef.make(Option.some({ client })),
      } as unknown as EnvironmentSupervisor["Service"]);

      const registryLayer = Layer.succeed(
        EnvironmentRegistry,
        EnvironmentRegistry.of({
          getSupervisor: () => supervisor,
          run: (
            _id: EnvironmentId,
            effect: Effect.Effect<unknown, unknown, EnvironmentSupervisor>,
          ) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
          withSupervisor: (
            _id: EnvironmentId,
            run: Effect.Effect<unknown, unknown, EnvironmentSupervisor>,
          ) => Effect.provideService(run, EnvironmentSupervisor, supervisor),
          followStream: (
            _id: EnvironmentId,
            stream: Stream.Stream<unknown, unknown, EnvironmentSupervisor>,
          ) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        } as unknown as EnvironmentRegistry["Service"]),
      );

      const atoms = createArtifactEnvironmentAtoms(Atom.runtime(registryLayer));
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (reg) => Effect.sync(() => reg.dispose()),
      );
      registry.mount(sessions(environmentId));

      const listAtom = atoms.list({ environmentId, input: { threadId } });
      const getAtom = atoms.get({ environmentId, input: { artifactId } });
      const listUpdates = yield* Queue.unbounded<ArtifactListResult>();
      const getUpdates = yield* Queue.unbounded<ArtifactResult>();

      const unsubList = registry.subscribe(
        listAtom,
        (result) => {
          if (AsyncResult.isSuccess(result)) Queue.offerUnsafe(listUpdates, result.value);
        },
        { immediate: true },
      );
      const unsubGet = registry.subscribe(
        getAtom,
        (result) => {
          if (AsyncResult.isSuccess(result)) Queue.offerUnsafe(getUpdates, result.value);
        },
        { immediate: true },
      );

      const initialList = yield* Queue.take(listUpdates);
      const initialGet = yield* Queue.take(getUpdates);
      expect(initialList.artifacts).toHaveLength(1);
      expect(initialGet.version.version).toBe(1);
      expect(listCallCount).toBe(1);
      expect(getCallCount).toBe(1);

      const patchResult = yield* Effect.promise(() =>
        runAtomCommand(registry, atoms.patchState, {
          environmentId,
          input: { artifactId, patch: { step: 2 }, expectedVersion: 0 },
        }),
      );
      expect(patchResult._tag).toBe("Success");

      const refreshedList = yield* Queue.take(listUpdates);
      const refreshedGet = yield* Queue.take(getUpdates);
      expect(refreshedList.artifacts[0]?.stateVersion).toBe(1);
      expect(refreshedGet.artifact.state).toEqual({ step: 2 });

      const actionResult = yield* Effect.promise(() =>
        runAtomCommand(registry, atoms.dispatchAction, {
          environmentId,
          input: {
            artifactId,
            action: { actionName: "approve", payload: { ok: true }, promptText: "Approved" },
          },
        }),
      );
      expect(actionResult._tag).toBe("Success");
      expect(recordedActions).toHaveLength(1);
      // dispatchAction also refreshes getAtom, emitting a success snapshot before revise runs.
      yield* Queue.take(getUpdates);

      const reviseResult = yield* Effect.promise(() =>
        runAtomCommand(registry, atoms.revise, {
          environmentId,
          input: { artifactId, content: "- [x] Step 1" },
        }),
      );
      expect(reviseResult._tag).toBe("Success");

      const revisedList = yield* Queue.take(listUpdates);
      expect(revisedList.artifacts[0]?.currentVersion).toBe(2);
      const revisedGet = yield* Queue.take(getUpdates);
      expect(revisedGet.artifact.currentVersion).toBe(2);
      expect(revisedGet.version.content).toBe("- [x] Step 1");

      const archiveResult = yield* Effect.promise(() =>
        runAtomCommand(registry, atoms.archive, {
          environmentId,
          input: { artifactId, archived: true },
        }),
      );
      expect(archiveResult._tag).toBe("Success");
      const archivedList = yield* Queue.take(listUpdates);
      expect(archivedList.artifacts).toHaveLength(0);

      unsubList();
      unsubGet();
    }).pipe(Effect.scoped),
  );
});

import {
  type EnvironmentId,
  IsoDateTime,
  isUnfinishedRunStatus,
  type OrchestratorMcpFailure,
  type PeerLink,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { RollupThreadStatus } from "@t3tools/shared/metaProjectRollup.core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import {
  MetaProjectDataSource,
  type MetaProjectDataSourceShape,
  type MetaProjectEnvironmentSnapshot,
} from "./MetaProjectService.ts";

/** Pages of 100; a peer with more projects or threads than this is cut off rather than stalling a rollup. */
const MAX_PAGES = 5;
const PAGE_LIMIT = 100;
const READ_ONLY_LIMITS = { runtimeMode: "approval-required", interactionMode: "plan" } as const;

// Only the fields a rollup reads: peers on other versions add or drop the rest.
const RemoteProjectPage = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      id: ProjectId,
      title: Schema.String,
      workspaceRoot: Schema.String,
      pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
      archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
      deletedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
    }),
  ),
  nextCursor: Schema.NullOr(Schema.Number),
});

const RemoteThreadPage = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      projectId: ProjectId,
      title: Schema.String,
      status: Schema.String,
      settled: Schema.Boolean,
      updatedAt: IsoDateTime,
    }),
  ),
  nextCursor: Schema.NullOr(Schema.Number),
});

/** `waiting` does not say whether the agent waits on an approval or an answer; both need the user. */
export function toRollupThreadStatus(status: string, settled: boolean): RollupThreadStatus {
  if (settled) return "settled";
  if (status === "waiting") return "waiting_input";
  if (status === "failed") return "error";
  return isUnfinishedRunStatus(status) ? "running" : "idle";
}

const collectPages = Effect.fn("MetaProjectRuntimeWiring.collectPages")(function* <A>(
  fetchPage: (cursor: number) => Effect.Effect<
    {
      readonly items: ReadonlyArray<A>;
      readonly nextCursor: number | null;
    },
    OrchestratorMcpFailure
  >,
) {
  const items: A[] = [];
  let cursor: number | null = 0;
  for (let page = 0; page < MAX_PAGES && cursor !== null; page++) {
    const result: { readonly items: ReadonlyArray<A>; readonly nextCursor: number | null } =
      yield* fetchPage(cursor);
    items.push(...result.items);
    cursor = result.nextCursor;
  }
  return items;
});

const makeRemoteSnapshotFetcher = Effect.fn("MetaProjectRuntimeWiring.makeFetcher")(function* () {
  const peerLinks = yield* PeerLinks.PeerLinks;
  const client = yield* PeerMcpClient.PeerMcpClient;

  const fetchRemote = Effect.fn("MetaProjectRuntimeWiring.fetchRemoteEnvironmentSnapshot")(
    function* (
      environmentId: EnvironmentId,
      projectIds: ReadonlyArray<ProjectId>,
    ): Effect.fn.Return<MetaProjectEnvironmentSnapshot | null, OrchestratorMcpFailure> {
      const wanted = new Set(projectIds);
      const keep = (projectId: ProjectId) => wanted.size === 0 || wanted.has(projectId);
      const projects = yield* collectPages((cursor) =>
        client
          .call({
            environmentId,
            tool: "t3_project_list",
            arguments: { cursor, limit: PAGE_LIMIT },
            limits: READ_ONLY_LIMITS,
            success: RemoteProjectPage,
          })
          .pipe(Effect.map((page) => ({ items: page.projects, nextCursor: page.nextCursor }))),
      );
      const threads = yield* collectPages((cursor) =>
        client
          .call({
            environmentId,
            tool: "t3_thread_list",
            arguments: { allProjects: true, includeSubagents: false, cursor, limit: PAGE_LIMIT },
            limits: READ_ONLY_LIMITS,
            success: RemoteThreadPage,
          })
          .pipe(Effect.map((page) => ({ items: page.threads, nextCursor: page.nextCursor }))),
      );
      const link = yield* peerLinks
        .get(environmentId)
        .pipe(Effect.orElseSucceed(() => Option.none<PeerLink>()));
      const visibleThreads = threads.filter((thread) => keep(thread.projectId));
      return {
        environment: {
          environmentId,
          label: Option.match(link, { onNone: () => environmentId, onSome: (l) => l.label }),
          isLocal: false,
          online: true,
        },
        physicalProjects: projects
          .filter((project) => keep(project.id))
          .map((project) => ({
            environmentId,
            projectId: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            pinnedAt: project.pinnedAt ?? null,
            archivedAt: project.archivedAt ?? null,
            deletedAt: project.deletedAt ?? null,
          })),
        threads: visibleThreads.map((thread) => ({
          environmentId,
          projectId: thread.projectId,
          threadId: thread.threadId,
          title: thread.title,
          updatedAt: thread.updatedAt,
          isActive: isUnfinishedRunStatus(thread.status),
        })),
        rollupThreads: visibleThreads.map((thread) => ({
          environmentId,
          projectId: thread.projectId,
          threadId: thread.threadId,
          title: thread.title,
          status: toRollupThreadStatus(thread.status, thread.settled),
          updatedAt: thread.updatedAt,
        })),
      };
    },
  );

  /** An unreachable peer still shows in the tree, marked offline; an unknown link shows nothing. */
  const offlineSnapshot = (environmentId: EnvironmentId) =>
    peerLinks.get(environmentId).pipe(
      Effect.orElseSucceed(() => Option.none<PeerLink>()),
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: (link): MetaProjectEnvironmentSnapshot => ({
            environment: { environmentId, label: link.label, isLocal: false, online: false },
            physicalProjects: [],
            threads: [],
          }),
        }),
      ),
    );

  const fetchRemoteEnvironmentSnapshot: NonNullable<
    MetaProjectDataSourceShape["fetchRemoteEnvironmentSnapshot"]
  > = (environmentId, projectIds) =>
    fetchRemote(environmentId, projectIds).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("linked environment rollup unavailable", { environmentId, cause }).pipe(
          Effect.andThen(offlineSnapshot(environmentId)),
        ),
      ),
    );

  return { fetchRemoteEnvironmentSnapshot } satisfies MetaProjectDataSourceShape;
});

/** Provide before `MetaProjectService.layer`, which reads the data source when it is built. */
export const layer = Layer.effect(MetaProjectDataSource, makeRemoteSnapshotFetcher());

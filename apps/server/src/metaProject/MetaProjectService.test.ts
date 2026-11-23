import { expect, it } from "@effect/vitest";
import { EnvironmentId, MetaProjectId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as MetaProjectService from "./MetaProjectService.ts";
import * as MetaProjectStore from "./MetaProjectStore.ts";

const envLocal = EnvironmentId.make("env-local");
const envRemote = EnvironmentId.make("env-remote");
const projWeb = ProjectId.make("proj-web");
const projApi = ProjectId.make("proj-api");
const projSolo = ProjectId.make("proj-solo");
const thPm = ThreadId.make("th-pm");
const thApi = ThreadId.make("th-api");
const mpCore = MetaProjectId.make("mp-core");

const testLayer = MetaProjectService.layerWithDataSource({
  getLocalSnapshot: () =>
    Effect.succeed({
      environment: {
        environmentId: envLocal,
        label: "Local Laptop",
        isLocal: true,
        online: true,
      },
      physicalProjects: [
        {
          environmentId: envLocal,
          projectId: projWeb,
          title: "Web App",
          workspaceRoot: "/work/web",
        },
        {
          environmentId: envLocal,
          projectId: projSolo,
          title: "Solo Script",
          workspaceRoot: "/work/solo",
        },
      ],
      threads: [
        {
          environmentId: envLocal,
          projectId: projWeb,
          threadId: thPm,
          title: "Product PM Thread",
          updatedAt: "2026-03-01T10:00:00.000Z",
          isActive: true,
        },
      ],
      pullRequests: [
        {
          environmentId: envLocal,
          projectId: projWeb,
          host: "github.com",
          repository: "acme/platform",
          number: 101,
          title: "Feat: Shared Rollup",
          url: "https://github.com/acme/platform/pull/101",
          state: "open",
          checksState: "passing",
          updatedAt: "2026-03-01T10:00:00.000Z",
        },
      ],
      issues: [
        {
          environmentId: envLocal,
          projectId: projWeb,
          tracker: "github",
          host: "github.com",
          scope: "acme/platform",
          key: "12",
          displayKey: "#12",
          title: "Track cross-repo rollout",
          url: "https://github.com/acme/platform/issues/12",
          stateCategory: "open",
          isAssignedToViewer: true,
          updatedAt: "2026-03-01T09:00:00.000Z",
        },
      ],
    }),
  fetchRemoteEnvironmentSnapshot: (environmentId) =>
    environmentId === envRemote
      ? Effect.succeed({
          environment: {
            environmentId: envRemote,
            label: "Remote Build Server",
            isLocal: false,
            online: true,
          },
          physicalProjects: [
            {
              environmentId: envRemote,
              projectId: projApi,
              title: "API Service",
              workspaceRoot: "/srv/api",
            },
          ],
          threads: [
            {
              environmentId: envRemote,
              projectId: projApi,
              threadId: thApi,
              title: "API Worker Thread",
              updatedAt: "2026-03-01T11:00:00.000Z",
              isActive: true,
            },
          ],
          pullRequests: [
            {
              environmentId: envRemote,
              projectId: projApi,
              host: "github.com",
              repository: "acme/platform",
              number: 101,
              title: "Feat: Shared Rollup (Updated)",
              url: "https://github.com/acme/platform/pull/101",
              state: "open",
              checksState: "failing",
              updatedAt: "2026-03-01T12:00:00.000Z",
            },
          ],
          issues: [],
        })
      : Effect.succeed(null),
}).pipe(
  Layer.provideMerge(MetaProjectStore.layer),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

it.effect(
  "orchestrates MetaProject mutations, hierarchy tree, shared context, rollup, and cleanup",
  () =>
    Effect.gen(function* () {
      const service = yield* MetaProjectService.MetaProjectService;

      const created = yield* service.create({
        id: mpCore,
        title: "Acme Core",
        description: "Distributed platform",
        instructionsMd: "Keep functional core free of I/O.",
        members: [
          {
            environmentId: envLocal,
            projectId: projWeb,
            role: "frontend",
            sortOrder: 0,
          },
        ],
        threadLinks: [
          {
            environmentId: envLocal,
            threadId: thPm,
            role: "pm",
            projectId: projWeb,
          },
        ],
      });
      expect(created.metaProject.id).toBe("mp-core");

      yield* service.mutate({
        type: "metaProject.addMember",
        metaProjectId: mpCore,
        member: {
          environmentId: envRemote,
          projectId: projApi,
          role: "backend",
          sortOrder: 1,
        },
      });

      const tree = yield* service.getTree();
      expect(tree.metaProjects).toHaveLength(1);
      expect(tree.metaProjects[0]?.pmThreads.map((t) => t.threadId)).toEqual(["th-pm"]);
      expect(tree.metaProjects[0]?.repositories.map((r) => r.projectId)).toEqual([
        "proj-web",
        "proj-api",
      ]);
      expect(tree.metaProjects[0]?.repositories[1]?.environmentBadge.label).toBe(
        "Remote Build Server",
      );
      expect(tree.uncategorizedRepositories.map((r) => r.projectId)).toEqual(["proj-solo"]);

      const sharedContext = yield* service.getSharedContext({
        environmentId: envLocal,
        projectId: projWeb,
      });
      expect(sharedContext).not.toBeNull();
      expect(sharedContext?.metaProjectId).toBe("mp-core");
      expect(sharedContext?.text).toContain("Keep functional core free of I/O.");
      expect(sharedContext?.text).toContain("**[frontend] Web App** [current]");
      expect(sharedContext?.text).toContain("**[backend] API Service**");

      const rollup = yield* service.getRollup({ metaProjectId: mpCore });
      expect(rollup.pullRequests).toHaveLength(1);
      expect(rollup.pullRequests[0]?.title).toBe("Feat: Shared Rollup (Updated)");
      expect(rollup.pullRequests[0]?.sources).toHaveLength(2);
      expect(rollup.counts.pullRequests.failingChecks).toBe(1);
      expect(rollup.counts.issues.assignedToViewer).toBe(1);
      expect(rollup.activeThreads.map((t) => t.threadId)).toEqual(["th-pm", "th-api"]);

      const cleanedAfterEnvDelete = yield* service.cleanupDeletedEnvironment(envRemote);
      expect(cleanedAfterEnvDelete).toHaveLength(1);
      expect(cleanedAfterEnvDelete[0]?.members.map((m) => m.projectId)).toEqual(["proj-web"]);
    }).pipe(Effect.provide(testLayer)),
);

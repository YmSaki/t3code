import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MetaProjectId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as MetaProjectService from "../../../metaProject/MetaProjectService.ts";
import * as MetaProjectStore from "../../../metaProject/MetaProjectStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as MetaProjectHandlers from "./handlers.ts";
import { MetaProjectToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:meta-test");
const threadId = ThreadId.make("thread:meta-test");
const projectId = ProjectId.make("project:meta-test");
const metaProjectId = MetaProjectId.make("mp-platform");

it.effect(
  "serves meta_project_list, meta_project_get_context, and meta_project_list_members over MCP",
  () =>
    Effect.gen(function* () {
      const shell = {
        ...liveThreadShell(threadId),
        projectId,
      };

      const baseLayer = Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "provider:meta",
          thread: {
            threadId,
            providerSessionId: "provider:meta",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
        }),
        MetaProjectService.layerWithDataSource({
          getLocalSnapshot: () =>
            Effect.succeed({
              environment: {
                environmentId,
                label: "Local Host",
                isLocal: true,
                online: true,
              },
              physicalProjects: [
                {
                  environmentId,
                  projectId,
                  title: "Platform Web",
                  workspaceRoot: "/work/platform-web",
                },
              ],
              threads: [],
            }),
        }).pipe(
          Layer.provideMerge(MetaProjectStore.layer),
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      );

      const fullLayer = McpToolAccess.HandlersLayer.layer(MetaProjectHandlers.layer).pipe(
        Layer.provideMerge(baseLayer),
      );

      yield* Effect.gen(function* () {
        const service = yield* MetaProjectService.MetaProjectService;
        yield* service.create({
          id: metaProjectId,
          title: "Platform Suite",
          instructionsMd: "Use Effect v4 Schema everywhere.",
          members: [
            {
              environmentId,
              projectId,
              role: "frontend",
              label: "Web Client",
            },
          ],
        });

        const toolkit = yield* MetaProjectToolkit;
        const callList = (params: Parameters<typeof toolkit.handle<"meta_project_list">>[1]) =>
          toolkit.handle("meta_project_list", params).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((parts) => parts.at(-1)?.result),
          );
        const callContext = (
          params: Parameters<typeof toolkit.handle<"meta_project_get_context">>[1],
        ) =>
          toolkit.handle("meta_project_get_context", params).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((parts) => parts.at(-1)?.result),
          );
        const callMembers = (
          params: Parameters<typeof toolkit.handle<"meta_project_list_members">>[1],
        ) =>
          toolkit.handle("meta_project_list_members", params).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((parts) => parts.at(-1)?.result),
          );

        const listResult = yield* callList({});
        expect(listResult).toMatchObject({
          metaProjects: [
            expect.objectContaining({
              id: "mp-platform",
              title: "Platform Suite",
            }),
          ],
        });

        const contextResult = yield* callContext({});
        expect(contextResult).toMatchObject({
          metaProjectId: "mp-platform",
          truncated: false,
        });
        expect(
          typeof contextResult === "object" &&
            contextResult !== null &&
            "text" in contextResult &&
            typeof contextResult.text === "string"
            ? contextResult.text
            : "",
        ).toContain("Use Effect v4 Schema everywhere.");

        const membersResult = yield* callMembers({ metaProjectId });
        expect(membersResult).toEqual({
          metaProjectId: "mp-platform",
          members: [
            expect.objectContaining({
              environmentId,
              projectId,
              role: "frontend",
              label: "Web Client",
            }),
          ],
        });

        const missingResult = yield* callMembers({
          metaProjectId: MetaProjectId.make("mp-nonexistent"),
        });
        expect(missingResult).toMatchObject({
          code: "invalid_request",
        });
      }).pipe(Effect.provide(fullLayer));
    }),
);

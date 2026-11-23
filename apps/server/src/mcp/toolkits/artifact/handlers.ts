import {
  type ArtifactError,
  OrchestratorMcpFailure,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ArtifactService from "../../../artifact/ArtifactService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ArtifactToolkit } from "./tools.ts";

const toMcpFailure = (error: ArtifactError): OrchestratorMcpFailure =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: error.message,
  });

const resolveTargetThreadId = Effect.fn("ArtifactToolkit.resolveTargetThreadId")(function* (
  explicitThreadId: ThreadId | undefined,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threadId = explicitThreadId ?? scope.thread?.threadId;
  if (threadId === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Pass threadId when calling from outside a thread.",
    });
  }
  return { environmentId: scope.environmentId, threadId };
});

const handlers = {
  artifact_create: McpToolAccess.writes(
    (input) =>
      Effect.gen(function* () {
        const { environmentId, threadId } = yield* resolveTargetThreadId(input.threadId);
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const shell = yield* threads
          .getThreadShell(threadId)
          .pipe(Effect.orElseSucceed(() => null));
        const projectId = shell?.projectId ?? ProjectId.make("project:default");
        const service = yield* ArtifactService.ArtifactService;
        return yield* service
          .create({
            environmentId,
            projectId,
            threadId,
            kind: input.kind,
            title: input.title,
            content: input.content,
            author: "agent",
            ...(input.initialState === undefined ? {} : { initialState: input.initialState }),
          })
          .pipe(Effect.mapError(toMcpFailure));
      }),
    { linkedCallers: "allowed" },
  ),

  artifact_revise: McpToolAccess.writes(
    (input) =>
      Effect.gen(function* () {
        const service = yield* ArtifactService.ArtifactService;
        return yield* service
          .revise({
            artifactId: input.artifactId,
            content: input.content,
            author: "agent",
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.summary === undefined ? {} : { summary: input.summary }),
          })
          .pipe(Effect.mapError(toMcpFailure));
      }),
    { linkedCallers: "allowed" },
  ),

  artifact_get: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* ArtifactService.ArtifactService;
      return yield* service
        .get({
          artifactId: input.artifactId,
          ...(input.version === undefined ? {} : { version: input.version }),
        })
        .pipe(Effect.mapError(toMcpFailure));
    }),
  ),

  artifact_patch_state: McpToolAccess.writes(
    (input) =>
      Effect.gen(function* () {
        const service = yield* ArtifactService.ArtifactService;
        return yield* service
          .patchState({
            artifactId: input.artifactId,
            patch: input.patch,
            ...(input.expectedVersion === undefined
              ? {}
              : { expectedVersion: input.expectedVersion }),
          })
          .pipe(Effect.mapError(toMcpFailure));
      }),
    { linkedCallers: "allowed" },
  ),

  artifact_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { threadId } = yield* resolveTargetThreadId(input.threadId);
      const service = yield* ArtifactService.ArtifactService;
      return yield* service
        .list({
          threadId,
          ...(input.includeArchived === undefined
            ? {}
            : { includeArchived: input.includeArchived }),
        })
        .pipe(Effect.mapError(toMcpFailure));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ArtifactToolkit.tools>;

export const layer = McpToolAccess.toLayer(ArtifactToolkit, handlers);

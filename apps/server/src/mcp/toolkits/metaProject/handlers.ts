import { type MetaProjectError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MetaProjectService from "../../../metaProject/MetaProjectService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { MetaProjectToolkit } from "./tools.ts";

const toMcpFailure = (error: MetaProjectError): OrchestratorMcpFailure =>
  error.reason === "storage_failed"
    ? unavailable()
    : new OrchestratorMcpFailure({
        code: "invalid_request",
        message: error.message,
      });

const access = Effect.gen(function* () {
  const caller = yield* readCaller();
  const service = yield* MetaProjectService.MetaProjectService;
  return { caller, service };
});

export const layer = McpToolAccess.toLayer(MetaProjectToolkit, {
  meta_project_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { service } = yield* access;
      return yield* service
        .list({ includeArchived: input.includeArchived })
        .pipe(Effect.mapError(toMcpFailure));
    }),
  ),
  meta_project_get_context: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller, service } = yield* access;
      const environmentId = input.environmentId ?? caller.scope.environmentId;
      const projectId = input.projectId ?? caller.caller?.projectId;

      if (input.metaProjectId === undefined && projectId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: "Pass metaProjectId or projectId.",
        });
      }

      const result = yield* service
        .getSharedContext({
          metaProjectId: input.metaProjectId,
          environmentId,
          projectId,
          maxChars: input.maxChars,
        })
        .pipe(Effect.mapError(toMcpFailure));

      if (result === null) {
        return {
          metaProjectId: null,
          text: "",
          charCount: 0,
          truncated: false,
          omittedRepositoryCount: 0,
          instructionsTruncated: false,
        };
      }

      return result;
    }),
  ),
  meta_project_list_members: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { service } = yield* access;
      const members = yield* service
        .listMembers(input.metaProjectId)
        .pipe(Effect.mapError(toMcpFailure));
      return {
        metaProjectId: input.metaProjectId,
        members,
      };
    }),
  ),
});

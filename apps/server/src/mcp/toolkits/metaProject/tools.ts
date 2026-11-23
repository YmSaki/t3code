import {
  EnvironmentId,
  MetaProjectId,
  MetaProjectListResult,
  MetaProjectMember,
  NonNegativeInt,
  OrchestratorMcpFailure,
  ProjectId,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as MetaProjectService from "../../../metaProject/MetaProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    MetaProjectService.MetaProjectService,
  ],
};

export const MetaProjectListTool = Tool.make("meta_project_list", {
  ...shared,
  description: "List meta-projects.",
  parameters: Schema.Struct({
    includeArchived: Schema.optional(Schema.Boolean),
  }),
  success: MetaProjectListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const MetaProjectGetContextTool = Tool.make("meta_project_get_context", {
  ...shared,
  description: "Read shared instructions and repositories for a meta-project.",
  parameters: Schema.Struct({
    metaProjectId: Schema.optional(MetaProjectId),
    environmentId: Schema.optional(EnvironmentId),
    projectId: Schema.optional(ProjectId),
    maxChars: Schema.optional(NonNegativeInt),
  }),
  success: Schema.Struct({
    metaProjectId: Schema.NullOr(MetaProjectId),
    text: Schema.String,
    charCount: NonNegativeInt,
    truncated: Schema.Boolean,
    omittedRepositoryCount: NonNegativeInt,
    instructionsTruncated: Schema.Boolean,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const MetaProjectListMembersTool = Tool.make("meta_project_list_members", {
  ...shared,
  description: "List member repositories of a meta-project.",
  parameters: Schema.Struct({
    metaProjectId: MetaProjectId,
  }),
  success: Schema.Struct({
    metaProjectId: MetaProjectId,
    members: Schema.Array(MetaProjectMember),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const MetaProjectToolkit = Toolkit.make(
  MetaProjectListTool,
  MetaProjectGetContextTool,
  MetaProjectListMembersTool,
);

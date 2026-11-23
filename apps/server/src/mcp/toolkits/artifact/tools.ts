import {
  ArtifactContent,
  ArtifactId,
  ArtifactKind,
  ArtifactListResult,
  ArtifactPatchStateResult,
  ArtifactResult,
  ArtifactState,
  ArtifactStateVersion,
  ArtifactTitle,
  ArtifactVersionNumber,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ArtifactService from "../../../artifact/ArtifactService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ArtifactService.ArtifactService,
  ],
};

export const ArtifactCreateTool = Tool.make("artifact_create", {
  ...shared,
  description: "Create an interactive HTML or Markdown artifact in this thread.",
  parameters: Schema.Struct({
    threadId: Schema.optionalKey(ThreadId),
    kind: ArtifactKind,
    title: ArtifactTitle,
    content: ArtifactContent,
    initialState: Schema.optionalKey(ArtifactState),
  }),
  success: ArtifactResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const ArtifactReviseTool = Tool.make("artifact_revise", {
  ...shared,
  description: "Save a new version of an existing artifact.",
  parameters: Schema.Struct({
    artifactId: ArtifactId,
    content: ArtifactContent,
    title: Schema.optionalKey(ArtifactTitle),
    summary: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  }),
  success: ArtifactResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const ArtifactGetTool = Tool.make("artifact_get", {
  ...shared,
  description: "Read an artifact and its active or requested version.",
  parameters: Schema.Struct({
    artifactId: ArtifactId,
    version: Schema.optionalKey(ArtifactVersionNumber),
  }),
  success: ArtifactResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const ArtifactPatchStateTool = Tool.make("artifact_patch_state", {
  ...shared,
  description: "Merge a JSON patch into an artifact's state (null deletes keys).",
  parameters: Schema.Struct({
    artifactId: ArtifactId,
    patch: Schema.Record(Schema.String, Schema.Unknown),
    expectedVersion: Schema.optionalKey(ArtifactStateVersion),
  }),
  success: ArtifactPatchStateResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const ArtifactListTool = Tool.make("artifact_list", {
  ...shared,
  description: "List artifacts belonging to a thread.",
  parameters: Schema.Struct({
    threadId: Schema.optionalKey(ThreadId),
    includeArchived: Schema.optionalKey(Schema.Boolean),
  }),
  success: ArtifactListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const ArtifactToolkit = Toolkit.make(
  ArtifactCreateTool,
  ArtifactReviseTool,
  ArtifactGetTool,
  ArtifactPatchStateTool,
  ArtifactListTool,
);

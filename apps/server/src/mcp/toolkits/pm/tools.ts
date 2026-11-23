import {
  NonNegativeInt,
  OrchestratorMcpFailure,
  PmBoardSnapshot,
  PmDispatchBatchInput,
  PmDispatchBatchResult,
  PmWorkerStatus,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  WorkerContextBrief,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PmService from "../../../pm/PmService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const sharedDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PmService.PmService,
];

const WorkerBriefSection = Schema.Literals(["core", "background", "handbook", "excerpts"]);

export const PmBoardStatusTool = Tool.make("pm_board_status", {
  description: "Read the PM worker board snapshot and pending questions.",
  parameters: Schema.Struct({
    pmThreadId: Schema.optional(ThreadId),
  }),
  success: Schema.Struct({
    ...PmBoardSnapshot.fields,
    pendingQuestions: Schema.Array(
      Schema.Struct({
        workerThreadId: ThreadId,
        title: TrimmedNonEmptyString,
        status: PmWorkerStatus,
        questions: Schema.Array(TrimmedNonEmptyString),
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: sharedDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const PmDispatchBatchTool = Tool.make("pm_dispatch_batch", {
  description: "Dispatch a batch of scoped worker briefs from a PM thread.",
  parameters: Schema.Struct({
    pmThreadId: Schema.optional(ThreadId),
    items: PmDispatchBatchInput.fields.items,
  }),
  success: PmDispatchBatchResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: sharedDependencies,
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const PmStopAllWorkersTool = Tool.make("pm_stop_all_workers", {
  description: "Activate the PM kill switch and stop active workers.",
  parameters: Schema.Struct({
    pmThreadId: Schema.optional(ThreadId),
    activateKillSwitch: Schema.optional(Schema.Boolean),
    reason: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({
    pmThreadId: ThreadId,
    killSwitchActive: Schema.Boolean,
    stoppedWorkerThreadIds: Schema.Array(ThreadId),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: sharedDependencies,
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const PmBuildWorkerBriefTool = Tool.make("pm_build_worker_brief", {
  description: "Build a budget-clamped prompt pack from a worker brief.",
  parameters: Schema.Struct({
    title: Schema.optional(TrimmedNonEmptyString),
    brief: WorkerContextBrief,
    targetRepoRole: Schema.optional(TrimmedNonEmptyString),
    handbookMarkdown: Schema.optional(Schema.String),
    maxBytes: Schema.optional(PositiveInt),
    maxTokens: Schema.optional(PositiveInt),
  }),
  success: Schema.Struct({
    prompt: Schema.String,
    byteLength: NonNegativeInt,
    estimatedTokens: NonNegativeInt,
    effectiveMaxBytes: PositiveInt,
    truncated: Schema.Boolean,
    includedSections: Schema.Array(WorkerBriefSection),
    truncatedSections: Schema.Array(WorkerBriefSection),
    includedExcerptPaths: Schema.Array(Schema.String),
    omittedExcerptPaths: Schema.Array(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: sharedDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const PmToolkit = Toolkit.make(
  PmBoardStatusTool,
  PmDispatchBatchTool,
  PmStopAllWorkersTool,
  PmBuildWorkerBriefTool,
);

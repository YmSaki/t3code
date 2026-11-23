import {
  clampedPositiveInt,
  NonNegativeInt,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  PositiveInt,
  ProjectId,
  RepoMonitorActionKind,
  RepoMonitorDryRunResult,
  RepoMonitorEventKind,
  RepoMonitorEventRecord,
  RepoMonitorFilter,
  RepoMonitorRule,
  RepoMonitorRuleId,
  RuntimeMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RepoMonitorService from "../../../repoMonitor/RepoMonitorService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const RepoMonitorPresetSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  eventKinds: Schema.Array(RepoMonitorEventKind),
  defaultFilter: RepoMonitorFilter,
  actionKind: RepoMonitorActionKind,
  defaultRuntimeMode: RuntimeMode,
  promptTemplate: TrimmedNonEmptyString,
  defaultCooldownSec: NonNegativeInt,
  defaultMaxTriggersPerHour: PositiveInt,
});

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    RepoMonitorService.RepoMonitorService,
  ],
};

export const RepoMonitorListRulesTool = Tool.make("repo_monitor_list_rules", {
  ...shared,
  description: "List repository monitor rules.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Struct({
    rules: Schema.Array(RepoMonitorRule),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const RepoMonitorDryRunTool = Tool.make("repo_monitor_dry_run", {
  ...shared,
  description: "Dry-run repository monitor rules without dispatching actions.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
    ruleId: Schema.optional(RepoMonitorRuleId),
  }),
  success: Schema.Struct({
    results: Schema.Array(RepoMonitorDryRunResult),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const RepoMonitorListEventsTool = Tool.make("repo_monitor_list_events", {
  ...shared,
  description: "List recorded repository monitor events.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
    ruleId: Schema.optional(RepoMonitorRuleId),
    limit: Schema.optional(clampedPositiveInt(200)),
  }),
  success: Schema.Struct({
    events: Schema.Array(RepoMonitorEventRecord),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const RepoMonitorListPresetsTool = Tool.make("repo_monitor_list_presets", {
  ...shared,
  description: "List built-in repository monitor presets.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: Schema.Struct({
    presets: Schema.Array(RepoMonitorPresetSchema),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const RepoMonitorToolkit = Toolkit.make(
  RepoMonitorListRulesTool,
  RepoMonitorDryRunTool,
  RepoMonitorListEventsTool,
  RepoMonitorListPresetsTool,
);

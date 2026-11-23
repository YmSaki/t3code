import { AgentWorklogEntry, OrchestratorMcpFailure, WorklogFilter } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as WorklogService from "../../../worklog/WorklogService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const WorklogQueryLocalTool = Tool.make("worklog_query_local", {
  description:
    "Query worklog entries recorded on this environment only (without forwarding to linked peers).",
  parameters: Schema.Struct({
    filter: Schema.optional(WorklogFilter),
  }),
  success: Schema.Struct({
    entries: Schema.Array(AgentWorklogEntry),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, WorklogService.WorklogService],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const WorklogToolkit = Toolkit.make(WorklogQueryLocalTool);

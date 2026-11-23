import { OrchestratorMcpFailure, type WorklogError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as WorklogService from "../../../worklog/WorklogService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { WorklogToolkit } from "./tools.ts";

function toMcpFailure(error: WorklogError): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: error.message,
  });
}

export const layer = McpToolAccess.toLayer(WorklogToolkit, {
  worklog_query_local: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const worklog = yield* WorklogService.WorklogService;
      // Always force includePeers: false so linked peers never recurse into each other.
      const result = yield* worklog
        .queryWorklog({ ...input.filter, includePeers: false })
        .pipe(Effect.mapError(toMcpFailure));
      return { entries: result.entries };
    }),
  ),
});

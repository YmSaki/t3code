import {
  NonNegativeInt,
  OrchestratorMcpFailure,
  PositiveInt,
  type RepoMonitorError,
  type RepoMonitorFilter,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import type { RepoMonitorFilterCriteria } from "@t3tools/shared/repoMonitorEval.core";
import * as Effect from "effect/Effect";

import * as RepoMonitorService from "../../../repoMonitor/RepoMonitorService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId } from "../../threadAccess.ts";
import { RepoMonitorToolkit } from "./tools.ts";

function toMcpFailure(error: RepoMonitorError): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: error.message,
  });
}

function toContractFilter(filter: RepoMonitorFilterCriteria): RepoMonitorFilter {
  const toTrimmedList = (items?: ReadonlyArray<string>) =>
    items
      ?.map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((item) => TrimmedNonEmptyString.make(item));

  const branchGlobs = toTrimmedList(filter.branchGlobs);
  const requiredLabels = toTrimmedList(filter.requiredLabels);
  const excludedLabels = toTrimmedList(filter.excludedLabels);
  const allowedAuthors = toTrimmedList(filter.allowedAuthors);
  const excludedAuthors = toTrimmedList(filter.excludedAuthors);
  const keywords = toTrimmedList(filter.keywords);

  return {
    ...(branchGlobs === undefined ? {} : { branchGlobs }),
    ...(requiredLabels === undefined ? {} : { requiredLabels }),
    ...(excludedLabels === undefined ? {} : { excludedLabels }),
    ...(allowedAuthors === undefined ? {} : { allowedAuthors }),
    ...(excludedAuthors === undefined ? {} : { excludedAuthors }),
    ...(filter.excludeBots === undefined ? {} : { excludeBots: filter.excludeBots }),
    ...(keywords === undefined ? {} : { keywords }),
  };
}

export const layer = McpToolAccess.toLayer(RepoMonitorToolkit, {
  repo_monitor_list_rules: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const service = yield* RepoMonitorService.RepoMonitorService;
      const projectId = input.projectId ?? context.caller?.projectId;
      const rules = yield* service.listRules(projectId).pipe(Effect.mapError(toMcpFailure));
      return { rules };
    }),
  ),

  repo_monitor_dry_run: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const projectId = yield* resolveProjectId(context, input.projectId);
      const service = yield* RepoMonitorService.RepoMonitorService;
      const results = yield* service
        .dryRunProject({
          projectId,
          ...(input.ruleId === undefined ? {} : { ruleId: input.ruleId }),
        })
        .pipe(Effect.mapError(toMcpFailure));
      return { results };
    }),
  ),

  repo_monitor_list_events: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const service = yield* RepoMonitorService.RepoMonitorService;
      const projectId = input.projectId ?? context.caller?.projectId;
      const events = yield* service
        .listEvents({
          ...(projectId === undefined ? {} : { projectId }),
          ...(input.ruleId === undefined ? {} : { ruleId: input.ruleId }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        .pipe(Effect.mapError(toMcpFailure));
      return { events };
    }),
  ),

  repo_monitor_list_presets: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* readCaller();
      const service = yield* RepoMonitorService.RepoMonitorService;
      const rawPresets = yield* service.listPresets;
      const presets = rawPresets.map((preset) => ({
        id: TrimmedNonEmptyString.make(preset.id),
        name: TrimmedNonEmptyString.make(preset.name),
        description: preset.description,
        eventKinds: preset.eventKinds,
        defaultFilter: toContractFilter(preset.defaultFilter),
        actionKind: preset.actionKind,
        defaultRuntimeMode: preset.defaultRuntimeMode,
        promptTemplate: TrimmedNonEmptyString.make(preset.promptTemplate),
        defaultCooldownSec: NonNegativeInt.make(preset.defaultCooldownSec),
        defaultMaxTriggersPerHour: PositiveInt.make(preset.defaultMaxTriggersPerHour),
      }));
      return { presets };
    }),
  ),
});

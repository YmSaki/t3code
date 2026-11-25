import { createRepoMonitorEnvironmentAtoms } from "@t3tools/client-runtime/state/repoMonitors";
import {
  PositiveInt,
  type EnvironmentId,
  type ProjectId,
  type RepoMonitorRuleId,
} from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const repoMonitorEnvironment = createRepoMonitorEnvironmentAtoms(connectionAtomRuntime);

export function useRepoMonitorRules(
  environmentId: EnvironmentId | null,
  projectId?: ProjectId | undefined,
) {
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : repoMonitorEnvironment.listRules({
          environmentId,
          input: projectId === undefined ? {} : { projectId },
        }),
  );
}

export function useRepoMonitorEvents(
  environmentId: EnvironmentId | null,
  filter?: {
    readonly projectId?: ProjectId | undefined;
    readonly ruleId?: RepoMonitorRuleId | undefined;
    readonly limit?: number | undefined;
  },
) {
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : repoMonitorEnvironment.listEvents({
          environmentId,
          input: {
            ...(filter?.projectId === undefined ? {} : { projectId: filter.projectId }),
            ...(filter?.ruleId === undefined ? {} : { ruleId: filter.ruleId }),
            ...(filter?.limit === undefined
              ? {}
              : { limit: PositiveInt.make(Math.max(1, Math.floor(filter.limit))) }),
          },
        }),
  );
}

export function useRepoMonitorPresets(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : repoMonitorEnvironment.presets({
          environmentId,
          input: {},
        }),
  );
}

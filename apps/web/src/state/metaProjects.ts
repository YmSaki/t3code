import {
  createMetaProjectEnvironmentAtoms,
  type MetaProjectRollupData,
  type MetaProjectTreeResult,
} from "@t3tools/client-runtime/state/metaProjects";
import type {
  EnvironmentId,
  MetaProject,
  MetaProjectId,
  MetaProjectListResult,
} from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery, type EnvironmentQueryView } from "./query";

export const metaProjectEnvironment = createMetaProjectEnvironmentAtoms(connectionAtomRuntime);

export function useMetaProjects(
  environmentId: EnvironmentId | null,
  options?: { readonly includeArchived?: boolean | undefined },
): EnvironmentQueryView<MetaProjectListResult> {
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : metaProjectEnvironment.list({
          environmentId,
          input:
            options?.includeArchived === undefined
              ? {}
              : { includeArchived: options.includeArchived },
        }),
  );
}

export function useMetaProject(
  environmentId: EnvironmentId | null,
  metaProjectId: MetaProjectId | null,
  options?: { readonly includeArchived?: boolean | undefined },
): EnvironmentQueryView<MetaProject | null> {
  return useEnvironmentQuery(
    environmentId === null || metaProjectId === null
      ? null
      : metaProjectEnvironment.get({
          environmentId,
          input: {
            metaProjectId,
            ...(options?.includeArchived === undefined
              ? {}
              : { includeArchived: options.includeArchived }),
          },
        }),
  );
}

export function useMetaProjectTree(
  environmentId: EnvironmentId | null,
  options?: { readonly includeArchived?: boolean | undefined },
): EnvironmentQueryView<MetaProjectTreeResult> {
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : metaProjectEnvironment.tree({
          environmentId,
          input:
            options?.includeArchived === undefined
              ? {}
              : { includeArchived: options.includeArchived },
        }),
  );
}

export function useMetaProjectRollup(
  environmentId: EnvironmentId | null,
  metaProjectId: MetaProjectId | null,
): EnvironmentQueryView<MetaProjectRollupData> {
  return useEnvironmentQuery(
    environmentId === null || metaProjectId === null
      ? null
      : metaProjectEnvironment.rollup({
          environmentId,
          input: { metaProjectId },
        }),
  );
}

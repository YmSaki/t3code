import { useAtomValue } from "@effect/atom-react";
import {
  createMetaProjectEnvironmentAtoms,
  type MetaProjectTreeResult,
} from "@t3tools/client-runtime/state/metaProjects";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const metaProjectEnvironment = createMetaProjectEnvironmentAtoms(connectionAtomRuntime);

const metaProjectTrees = Atom.family((key: string) => {
  const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
  return Atom.make((get): ReadonlyArray<MetaProjectTreeResult | null> =>
    environmentIds.map((environmentId) =>
      AsyncResult.getOrElse(
        get(metaProjectEnvironment.tree({ environmentId, input: {} })),
        () => null,
      ),
    ),
  ).pipe(Atom.withLabel(`mobile-meta-project-trees:${key}`));
});

/** Each environment's tree; one that failed or is still loading reads as null. */
export function useMetaProjectTrees(environmentIds: ReadonlyArray<EnvironmentId>) {
  return useAtomValue(metaProjectTrees(JSON.stringify(environmentIds)));
}

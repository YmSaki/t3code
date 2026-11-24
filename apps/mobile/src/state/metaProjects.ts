import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { NavigationContext } from "@react-navigation/native";
import {
  createMetaProjectEnvironmentAtoms,
  type MetaProjectTreeResult,
} from "@t3tools/client-runtime/state/metaProjects";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext, useEffect, useRef } from "react";
import { AppState } from "react-native";

import { connectionAtomRuntime } from "../connection/runtime";

export const metaProjectEnvironment = createMetaProjectEnvironmentAtoms(connectionAtomRuntime);

const metaProjectTrees = Atom.family((key: string) => {
  const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
  return Atom.readable(
    (get): ReadonlyArray<MetaProjectTreeResult | null> =>
      environmentIds.map((environmentId) =>
        AsyncResult.getOrElse(
          get(metaProjectEnvironment.tree({ environmentId, input: {} })),
          () => null,
        ),
      ),
    (refresh) =>
      environmentIds.forEach((environmentId) =>
        refresh(metaProjectEnvironment.tree({ environmentId, input: {} })),
      ),
  ).pipe(Atom.withLabel(`mobile-meta-project-trees:${key}`));
});

/** Each environment's tree; one that failed or is still loading reads as null. */
export function useMetaProjectTrees(environmentIds: ReadonlyArray<EnvironmentId>) {
  const atom = metaProjectTrees(JSON.stringify(environmentIds));
  const refresh = useAtomRefresh(atom);
  const navigation = useContext(NavigationContext);
  const hasBlurredRef = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to AppState and navigation focus/blur listeners while mounted
  useEffect(() => {
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    const unsubscribeBlur = navigation?.addListener("blur", () => {
      hasBlurredRef.current = true;
    });
    const unsubscribeFocus = navigation?.addListener("focus", () => {
      // Initial mount already fetches via `revalidateOnMount`; refresh when returning to Home.
      if (!hasBlurredRef.current) return;
      hasBlurredRef.current = false;
      refresh();
    });
    return () => {
      appStateSubscription?.remove();
      unsubscribeBlur?.();
      unsubscribeFocus?.();
    };
  }, [navigation, refresh]);

  return useAtomValue(atom);
}

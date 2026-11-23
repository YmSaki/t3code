import { createArtifactEnvironmentAtoms } from "@t3tools/client-runtime/state/artifacts";
import type { ArtifactId, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export const artifactEnvironment = createArtifactEnvironmentAtoms(connectionAtomRuntime);

export function useThreadArtifacts(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  includeArchived = false,
) {
  return useEnvironmentQuery(
    environmentId !== null && threadId !== null
      ? artifactEnvironment.list({
          environmentId,
          input: { threadId, ...(includeArchived ? { includeArchived: true } : {}) },
        })
      : null,
  );
}

export function useArtifact(
  environmentId: EnvironmentId | null,
  artifactId: ArtifactId | null,
  version?: number,
) {
  return useEnvironmentQuery(
    environmentId !== null && artifactId !== null
      ? artifactEnvironment.get({
          environmentId,
          input: { artifactId, ...(version === undefined ? {} : { version }) },
        })
      : null,
  );
}

export function useArtifactVersions(
  environmentId: EnvironmentId | null,
  artifactId: ArtifactId | null,
) {
  return useEnvironmentQuery(
    environmentId !== null && artifactId !== null
      ? artifactEnvironment.listVersions({
          environmentId,
          input: { artifactId },
        })
      : null,
  );
}

export function useArtifactCommands() {
  const create = useAtomCommand(artifactEnvironment.create, { reportFailure: false });
  const revise = useAtomCommand(artifactEnvironment.revise, { reportFailure: false });
  const switchVersion = useAtomCommand(artifactEnvironment.switchVersion, {
    reportFailure: false,
  });
  const patchState = useAtomCommand(artifactEnvironment.patchState, { reportFailure: false });
  const dispatchAction = useAtomCommand(artifactEnvironment.dispatchAction, {
    reportFailure: false,
  });
  const archive = useAtomCommand(artifactEnvironment.archive, { reportFailure: false });
  const exportStandalone = useAtomCommand(artifactEnvironment.exportStandalone, {
    reportFailure: false,
  });

  return {
    create,
    revise,
    switchVersion,
    patchState,
    dispatchAction,
    archive,
    exportStandalone,
  };
}

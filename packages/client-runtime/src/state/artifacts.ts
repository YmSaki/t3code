import {
  type ArtifactGetInput,
  type ArtifactListInput,
  type ArtifactListVersionsInput,
  type EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export interface ArtifactEnvironmentListTarget {
  readonly environmentId: EnvironmentId;
  readonly input: ArtifactListInput;
}

export interface ArtifactEnvironmentGetTarget {
  readonly environmentId: EnvironmentId;
  readonly input: ArtifactGetInput;
}

export interface ArtifactEnvironmentVersionsTarget {
  readonly environmentId: EnvironmentId;
  readonly input: ArtifactListVersionsInput;
}

export function createArtifactEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:artifacts:list",
    tag: WS_METHODS.artifactsList,
    staleTimeMs: 5_000,
  });

  const get = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:artifacts:get",
    tag: WS_METHODS.artifactsGet,
    staleTimeMs: 5_000,
  });

  const listVersions = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:artifacts:list-versions",
    tag: WS_METHODS.artifactsListVersions,
    staleTimeMs: 5_000,
  });

  const refreshArtifact = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    input: {
      readonly artifactId?: ArtifactGetInput["artifactId"];
      readonly threadId?: ArtifactListInput["threadId"];
    },
  ) =>
    Effect.sync(() => {
      if (input.artifactId !== undefined) {
        registry.refresh(get({ environmentId, input: { artifactId: input.artifactId } }));
        registry.refresh(listVersions({ environmentId, input: { artifactId: input.artifactId } }));
      }
      if (input.threadId !== undefined) {
        registry.refresh(list({ environmentId, input: { threadId: input.threadId } }));
        registry.refresh(
          list({ environmentId, input: { threadId: input.threadId, includeArchived: true } }),
        );
      }
    });

  return {
    list,
    get,
    listVersions,
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:artifacts:create",
      tag: WS_METHODS.artifactsCreate,
      onSuccess: ({ environmentId, input }, registry, result) =>
        refreshArtifact(registry, environmentId, {
          artifactId: result.artifact.id,
          threadId: input.threadId,
        }),
    }),
    revise: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:artifacts:revise",
      tag: WS_METHODS.artifactsRevise,
      onSuccess: ({ environmentId }, registry, result) =>
        refreshArtifact(registry, environmentId, {
          artifactId: result.artifact.id,
          threadId: result.artifact.threadId,
        }),
    }),
    switchVersion: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:artifacts:switch-version",
      tag: WS_METHODS.artifactsSwitchVersion,
      onSuccess: ({ environmentId }, registry, result) =>
        refreshArtifact(registry, environmentId, {
          artifactId: result.artifact.id,
          threadId: result.artifact.threadId,
        }),
    }),
    patchState: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:artifacts:patch-state",
      tag: WS_METHODS.artifactsPatchState,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.artifactId}`,
      },
      onSuccess: ({ environmentId }, registry, result) =>
        refreshArtifact(registry, environmentId, {
          artifactId: result.artifact.id,
          threadId: result.artifact.threadId,
        }),
    }),
    dispatchAction: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:artifacts:dispatch-action",
      tag: WS_METHODS.artifactsSubmitUserAction,
      onSuccess: ({ environmentId, input }, registry) =>
        refreshArtifact(registry, environmentId, {
          artifactId: input.artifactId,
        }),
    }),
    archive: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:artifacts:archive",
      tag: WS_METHODS.artifactsArchive,
      onSuccess: ({ environmentId }, registry, result) =>
        refreshArtifact(registry, environmentId, {
          artifactId: result.id,
          threadId: result.threadId,
        }),
    }),
    exportStandalone: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:artifacts:export-standalone",
      tag: WS_METHODS.artifactsExportStandalone,
    }),
  };
}

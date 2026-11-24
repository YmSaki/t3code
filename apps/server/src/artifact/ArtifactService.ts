import {
  ARTIFACT_STATE_MAX_BYTES,
  type Artifact,
  type ArtifactArchiveInput,
  ArtifactArchivedError,
  type ArtifactAuthor,
  type ArtifactError,
  type ArtifactGetInput,
  ArtifactId,
  ArtifactInvalidStateError,
  type ArtifactKind,
  type ArtifactListInput,
  type ArtifactListResult,
  type ArtifactListVersionsInput,
  type ArtifactListVersionsResult,
  ArtifactNotFoundError,
  type ArtifactPatchStateInput,
  type ArtifactPatchStateResult,
  type ArtifactResult,
  type ArtifactReviseInput,
  ArtifactStateConflictError,
  ArtifactStateTooLargeError,
  type ArtifactSwitchVersionInput,
  type ArtifactUserAction,
  type ArtifactUserActionResult,
  type ArtifactVersion,
  EnvironmentId,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  type ArtifactBridgeSecurityContext,
  buildArtifactSandboxCsp,
  injectArtifactBootstrap,
  verifyArtifactBridgeActivation,
  verifyArtifactBridgeMessage,
} from "@t3tools/shared/artifactBridge.core";
import {
  type ArtifactStateFailure,
  applyArtifactStatePatch,
  formatArtifactStateEnvelope,
  formatArtifactStateEnvelopes,
  validateArtifactState,
} from "@t3tools/shared/artifactState.core";
import {
  type MarkdownLineComment,
  buildMarkdownRevisionPrompt,
  buildUnifiedDiff,
  toggleTaskCheckbox,
} from "@t3tools/shared/markdownArtifact.core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ArtifactStore from "./ArtifactStore.ts";

export interface ArtifactServiceCreateInput {
  readonly id?: ArtifactId | undefined;
  readonly environmentId?: EnvironmentId | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly threadId: ThreadId;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly content: string;
  readonly author?: ArtifactAuthor | undefined;
  readonly summary?: string | undefined;
  readonly initialState?: Readonly<Record<string, unknown>> | undefined;
}

export interface ArtifactSubmitUserActionInput {
  readonly artifactId: ArtifactId;
  readonly action?: ArtifactUserAction | undefined;
  readonly bridgeMessage?: unknown;
  readonly securityContext?: ArtifactBridgeSecurityContext | undefined;
}

export interface ArtifactSubmitUserActionOutput extends ArtifactUserActionResult {
  readonly prompt: string;
  readonly record: ArtifactStore.ArtifactActionRecord;
}

export interface ArtifactTurnStartRequest {
  readonly artifact: Artifact;
  readonly action: ArtifactUserAction;
  readonly prompt: string;
}

export class ArtifactTurnStartError extends Schema.TaggedError<ArtifactTurnStartError>()(
  "ArtifactTurnStartError",
  { artifactId: ArtifactId, cause: Schema.Defect() },
) {}

/** Starts the agent turn a user action asks for; `started` is true only once a turn really began. */
export type ArtifactTurnStarter = (
  request: ArtifactTurnStartRequest,
) => Effect.Effect<{ readonly started: boolean }, ArtifactTurnStartError>;

export interface ArtifactServiceOptions {
  readonly turnStarter?: ArtifactTurnStarter | undefined;
}

export interface ArtifactStandaloneExport {
  readonly artifact: Artifact;
  readonly version: ArtifactVersion;
  readonly fileName: string;
  readonly mimeType: string;
  readonly content: string;
  readonly csp: string;
  readonly headers: Readonly<Record<string, string>>;
}

export class ArtifactService extends Context.Service<
  ArtifactService,
  {
    readonly create: (
      input: ArtifactServiceCreateInput,
    ) => Effect.Effect<ArtifactResult, ArtifactError>;
    readonly revise: (input: ArtifactReviseInput) => Effect.Effect<ArtifactResult, ArtifactError>;
    readonly get: (input: ArtifactGetInput) => Effect.Effect<ArtifactResult, ArtifactError>;
    readonly list: (input: ArtifactListInput) => Effect.Effect<ArtifactListResult, ArtifactError>;
    readonly listVersions: (
      input: ArtifactListVersionsInput,
    ) => Effect.Effect<ArtifactListVersionsResult, ArtifactError>;
    readonly switchVersion: (
      input: ArtifactSwitchVersionInput,
    ) => Effect.Effect<ArtifactResult, ArtifactError>;
    readonly archive: (input: ArtifactArchiveInput) => Effect.Effect<Artifact, ArtifactError>;
    readonly patchState: (
      input: ArtifactPatchStateInput,
    ) => Effect.Effect<ArtifactPatchStateResult, ArtifactError>;
    readonly submitUserAction: (
      input: ArtifactSubmitUserActionInput,
    ) => Effect.Effect<ArtifactSubmitUserActionOutput, ArtifactError>;
    readonly toggleMarkdownCheckbox: (input: {
      readonly artifactId: ArtifactId;
      readonly index: number;
      readonly checked?: boolean | undefined;
      readonly author?: ArtifactAuthor | undefined;
    }) => Effect.Effect<ArtifactResult, ArtifactError>;
    readonly buildRevisionPrompt: (input: {
      readonly artifactId: ArtifactId;
      readonly version?: number | undefined;
      readonly comments: ReadonlyArray<MarkdownLineComment>;
    }) => Effect.Effect<string | null, ArtifactError>;
    readonly diffVersions: (input: {
      readonly artifactId: ArtifactId;
      readonly fromVersion: number;
      readonly toVersion: number;
      readonly contextLines?: number | undefined;
    }) => Effect.Effect<string, ArtifactError>;
    readonly formatThreadStateEnvelopes: (
      threadId: ThreadId,
    ) => Effect.Effect<string | null, ArtifactError>;
    readonly exportStandalone: (input: {
      readonly artifactId: ArtifactId;
      readonly version?: number | undefined;
      readonly secret?: string | undefined;
      readonly allowBlobFrames?: boolean | undefined;
    }) => Effect.Effect<ArtifactStandaloneExport, ArtifactError>;
  }
>()("t3/artifact/ArtifactService") {}

const stateFailureToError = (
  artifactId: ArtifactId,
  failure: ArtifactStateFailure,
): ArtifactError => {
  switch (failure.reason) {
    case "too_large":
      return new ArtifactStateTooLargeError({
        artifactId,
        limitBytes: failure.limitBytes,
        actualBytes: failure.actualBytes,
      });
    case "invalid_key":
      return new ArtifactInvalidStateError({
        artifactId,
        detail: `Forbidden key "${failure.key}" in state patch.`,
      });
    case "too_deep":
      return new ArtifactInvalidStateError({
        artifactId,
        detail: `State exceeds maximum nesting depth at "${failure.path}".`,
      });
    case "not_json":
      return new ArtifactInvalidStateError({
        artifactId,
        detail: `State contains non-JSON value at "${failure.path}".`,
      });
  }
};

const safeFileBaseName = (title: string): string => {
  const cleaned = title
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return cleaned || "Artifact";
};

const formatUserActionPrompt = (artifact: Artifact, action: ArtifactUserAction): string => {
  const envelope = formatArtifactStateEnvelope({
    artifactId: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    stateVersion: artifact.stateVersion,
    state: artifact.state,
  });
  const lines = [
    envelope,
    `User triggered action "${action.actionName}" on artifact "${artifact.title}" (id: ${artifact.id}).`,
    `Action payload: ${JSON.stringify(action.payload)}`,
  ];
  if (action.promptText !== undefined) {
    lines.push(`User request: ${action.promptText}`);
  }
  return lines.join("\n");
};

const make = Effect.fn("ArtifactService.make")(function* (serviceOptions?: ArtifactServiceOptions) {
  const store = yield* ArtifactStore.ArtifactStore;
  let nextSequence = 0;

  const nextId = (prefix: string) => {
    nextSequence += 1;
    return `${prefix}-${nextSequence}`;
  };

  const create: ArtifactService["Service"]["create"] = Effect.fn("ArtifactService.create")(
    function* (input) {
      const id = input.id ?? ArtifactId.make(nextId("artifact"));
      const initialState = input.initialState ?? {};
      const stateProblem = validateArtifactState(initialState, ARTIFACT_STATE_MAX_BYTES);
      if (stateProblem !== null) {
        return yield* stateFailureToError(id, stateProblem);
      }
      return yield* store.create({
        id,
        environmentId: input.environmentId ?? EnvironmentId.make("environment:local"),
        projectId: input.projectId ?? ProjectId.make("project:default"),
        threadId: input.threadId,
        kind: input.kind,
        title: input.title,
        content: input.content,
        ...(input.author === undefined ? {} : { author: input.author }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        initialState,
      });
    },
  );

  const revise: ArtifactService["Service"]["revise"] = Effect.fn("ArtifactService.revise")(
    function* (input) {
      return yield* store.revise({
        artifactId: input.artifactId,
        content: input.content,
        ...(input.author === undefined ? {} : { author: input.author }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      });
    },
  );

  const get: ArtifactService["Service"]["get"] = Effect.fn("ArtifactService.get")(
    function* (input) {
      return yield* store.get({
        artifactId: input.artifactId,
        ...(input.version === undefined ? {} : { version: input.version }),
      });
    },
  );

  const list: ArtifactService["Service"]["list"] = Effect.fn("ArtifactService.list")(
    function* (input) {
      const artifacts = yield* store.listByThread({
        threadId: input.threadId,
        ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
      });
      return { artifacts };
    },
  );

  const listVersions: ArtifactService["Service"]["listVersions"] = Effect.fn(
    "ArtifactService.listVersions",
  )(function* (input) {
    const versions = yield* store.listVersions(input.artifactId);
    return { versions };
  });

  const switchVersion: ArtifactService["Service"]["switchVersion"] = Effect.fn(
    "ArtifactService.switchVersion",
  )(function* (input) {
    return yield* store.switchVersion(input);
  });

  const archive: ArtifactService["Service"]["archive"] = Effect.fn("ArtifactService.archive")(
    function* (input) {
      return yield* store.setArchived(input);
    },
  );

  const patchState: ArtifactService["Service"]["patchState"] = Effect.fn(
    "ArtifactService.patchState",
  )(function* (input) {
    const current = yield* store.findById(input.artifactId);
    if (current === null) {
      return yield* new ArtifactNotFoundError({ artifactId: input.artifactId });
    }
    if (current.archivedAt !== null) {
      return yield* new ArtifactArchivedError({ artifactId: input.artifactId });
    }
    const expectedVersion = input.expectedVersion ?? current.stateVersion;
    if (expectedVersion !== current.stateVersion) {
      return yield* new ArtifactStateConflictError({
        artifactId: input.artifactId,
        expectedVersion,
        actualVersion: current.stateVersion,
      });
    }
    const patched = applyArtifactStatePatch(current.state, input.patch, ARTIFACT_STATE_MAX_BYTES);
    if (!patched.ok) {
      return yield* stateFailureToError(input.artifactId, patched);
    }
    const updated = yield* store.updateStateOptimistic({
      artifactId: input.artifactId,
      expectedVersion,
      nextState: patched.state,
    });
    return { artifact: updated };
  });

  const submitUserAction: ArtifactService["Service"]["submitUserAction"] = Effect.fn(
    "ArtifactService.submitUserAction",
  )(function* (input) {
    let resolvedAction: ArtifactUserAction | undefined = input.action;

    if (input.bridgeMessage !== undefined) {
      const verified = verifyArtifactBridgeMessage(input.bridgeMessage, input.securityContext);
      if (!verified.ok) {
        return yield* new ArtifactInvalidStateError({
          artifactId: input.artifactId,
          detail: `[${verified.reason}] ${verified.message}`,
        });
      }
      if (verified.request.kind === "sendAction") {
        resolvedAction = {
          actionName: verified.request.actionName,
          payload: verified.request.payload,
          ...(verified.request.promptText === undefined
            ? {}
            : { promptText: verified.request.promptText }),
        };
      } else if (verified.request.kind === "sendMessage") {
        resolvedAction = {
          actionName: "message",
          payload: {},
          promptText: verified.request.text,
        };
      } else {
        return yield* new ArtifactInvalidStateError({
          artifactId: input.artifactId,
          detail: `Bridge method "${verified.request.kind}" is not a user action.`,
        });
      }
    } else if (input.securityContext !== undefined) {
      const activation = verifyArtifactBridgeActivation("sendAction", input.securityContext);
      if (!activation.ok) {
        return yield* new ArtifactInvalidStateError({
          artifactId: input.artifactId,
          detail: `[${activation.reason}] User activation or bridge secret verification failed.`,
        });
      }
    }

    if (resolvedAction === undefined) {
      return yield* new ArtifactInvalidStateError({
        artifactId: input.artifactId,
        detail: "User action payload is required.",
      });
    }

    const artifact = yield* store.findById(input.artifactId);
    if (artifact === null) {
      return yield* new ArtifactNotFoundError({ artifactId: input.artifactId });
    }
    if (artifact.archivedAt !== null) {
      return yield* new ArtifactArchivedError({ artifactId: input.artifactId });
    }

    const prompt = formatUserActionPrompt(artifact, resolvedAction);
    const record = yield* store.recordAction({
      id: nextId("artifact-action"),
      artifactId: artifact.id,
      threadId: artifact.threadId,
      action: resolvedAction,
      stateVersion: artifact.stateVersion,
    });

    const turnStarter = serviceOptions?.turnStarter;
    let startedTurn = false;
    if (resolvedAction.promptText !== undefined) {
      if (turnStarter === undefined) {
        yield* Effect.logWarning("artifact.user-action.no-turn-starter", {
          artifactId: artifact.id,
        });
      } else {
        // The action is already recorded, so a failed start is reported as not started, not as a lost action.
        startedTurn = yield* turnStarter({ artifact, action: resolvedAction, prompt }).pipe(
          Effect.map((result) => result.started),
          Effect.catch((cause) =>
            Effect.logWarning("artifact.user-action.turn-start-failed", {
              artifactId: artifact.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
      }
    }

    return {
      accepted: true,
      stateVersion: artifact.stateVersion,
      startedTurn,
      prompt,
      record,
    };
  });

  const toggleMarkdownCheckbox: ArtifactService["Service"]["toggleMarkdownCheckbox"] = Effect.fn(
    "ArtifactService.toggleMarkdownCheckbox",
  )(function* (input) {
    const current = yield* store.get({ artifactId: input.artifactId });
    if (current.artifact.kind !== "markdown") {
      return yield* new ArtifactInvalidStateError({
        artifactId: input.artifactId,
        detail: "Task checkboxes can only be toggled on markdown artifacts.",
      });
    }
    const toggled = toggleTaskCheckbox(current.version.content, input.index, input.checked);
    if (!toggled.ok) {
      return yield* new ArtifactInvalidStateError({
        artifactId: input.artifactId,
        detail: `Task checkbox index ${input.index} is out of range.`,
      });
    }
    return yield* store.revise({
      artifactId: input.artifactId,
      content: toggled.markdown,
      author: input.author ?? "user",
      expectedVersion: current.artifact.currentVersion,
      summary: `Toggled task #${input.index + 1} to ${toggled.checked ? "checked" : "unchecked"}`,
    });
  });

  const buildRevisionPrompt: ArtifactService["Service"]["buildRevisionPrompt"] = Effect.fn(
    "ArtifactService.buildRevisionPrompt",
  )(function* (input) {
    const { artifact, version } = yield* store.get({
      artifactId: input.artifactId,
      ...(input.version === undefined ? {} : { version: input.version }),
    });
    return buildMarkdownRevisionPrompt({
      artifactId: artifact.id,
      title: artifact.title,
      markdown: version.content,
      comments: input.comments,
    });
  });

  const diffVersions: ArtifactService["Service"]["diffVersions"] = Effect.fn(
    "ArtifactService.diffVersions",
  )(function* (input) {
    const from = yield* store.get({
      artifactId: input.artifactId,
      version: input.fromVersion,
    });
    const to = yield* store.get({
      artifactId: input.artifactId,
      version: input.toVersion,
    });
    return buildUnifiedDiff(from.version.content, to.version.content, {
      oldLabel: `v${from.version.version}`,
      newLabel: `v${to.version.version}`,
      ...(input.contextLines === undefined ? {} : { contextLines: input.contextLines }),
    });
  });

  const formatThreadStateEnvelopes: ArtifactService["Service"]["formatThreadStateEnvelopes"] =
    Effect.fn("ArtifactService.formatThreadStateEnvelopes")(function* (threadId) {
      const artifacts = yield* store.listByThread({ threadId, includeArchived: false });
      return formatArtifactStateEnvelopes(
        artifacts.map((artifact) => ({
          artifactId: artifact.id,
          title: artifact.title,
          kind: artifact.kind,
          stateVersion: artifact.stateVersion,
          state: artifact.state,
        })),
      );
    });

  const exportStandalone: ArtifactService["Service"]["exportStandalone"] = Effect.fn(
    "ArtifactService.exportStandalone",
  )(function* (input) {
    const { artifact, version } = yield* store.get({
      artifactId: input.artifactId,
      ...(input.version === undefined ? {} : { version: input.version }),
    });
    const cspOptions =
      input.allowBlobFrames === undefined ? {} : { allowBlobFrames: input.allowBlobFrames };
    const csp = buildArtifactSandboxCsp(cspOptions);
    const headers: Readonly<Record<string, string>> = {
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "no-referrer",
    };
    const baseName = safeFileBaseName(artifact.title);

    if (artifact.kind === "html") {
      const bootstrapped = injectArtifactBootstrap(version.content, {
        artifactId: artifact.id,
        initialState: artifact.state,
        initialStateVersion: artifact.stateVersion,
        ...(input.secret === undefined ? {} : { secret: input.secret }),
        csp: cspOptions,
      });
      return {
        artifact,
        version,
        fileName: `${baseName}.html`,
        mimeType: "text/html; charset=utf-8",
        content: bootstrapped,
        csp,
        headers,
      };
    }

    return {
      artifact,
      version,
      fileName: `${baseName}.md`,
      mimeType: "text/markdown; charset=utf-8",
      content: version.content,
      csp,
      headers,
    };
  });

  return ArtifactService.of({
    create,
    revise,
    get,
    list,
    listVersions,
    switchVersion,
    archive,
    patchState,
    submitUserAction,
    toggleMarkdownCheckbox,
    buildRevisionPrompt,
    diffVersions,
    formatThreadStateEnvelopes,
    exportStandalone,
  });
});

export const makeLayer = (options?: ArtifactServiceOptions) =>
  Layer.effect(ArtifactService, make(options));

export const layer = makeLayer();

import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const ARTIFACT_STATE_MAX_BYTES = 16_384;
const ARTIFACT_CONTENT_MAX_LENGTH = 1_000_000;
const ARTIFACT_TITLE_MAX_LENGTH = 200;
const ARTIFACT_ACTION_NAME_MAX_LENGTH = 128;
const ARTIFACT_PROMPT_TEXT_MAX_LENGTH = 8_000;

const textEncoder = new TextEncoder();

export const ArtifactId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("ArtifactId"),
);
export type ArtifactId = typeof ArtifactId.Type;

export const ArtifactKind = Schema.Literals(["html", "markdown"]);
export type ArtifactKind = typeof ArtifactKind.Type;

export const ArtifactAuthor = Schema.Literals(["agent", "user"]);
export type ArtifactAuthor = typeof ArtifactAuthor.Type;

export const ArtifactTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ARTIFACT_TITLE_MAX_LENGTH),
);
export const ArtifactContent = Schema.String.check(Schema.isMaxLength(ARTIFACT_CONTENT_MAX_LENGTH));
export const ArtifactVersionNumber = PositiveInt;
export const ArtifactStateVersion = NonNegativeInt;

const fitsStateBudget = Schema.makeFilter((value: Readonly<Record<string, unknown>>) =>
  textEncoder.encode(JSON.stringify(value)).length <= ARTIFACT_STATE_MAX_BYTES
    ? true
    : `Artifact state must be at most ${ARTIFACT_STATE_MAX_BYTES} bytes of UTF-8 JSON.`,
);

export const ArtifactState = Schema.Record(Schema.String, Schema.Unknown).check(fitsStateBudget);
export type ArtifactState = typeof ArtifactState.Type;

/** Top-level keys merge into the state. A `null` value deletes the key. */
export const ArtifactStatePatch = Schema.Struct({
  patch: Schema.Record(Schema.String, Schema.Unknown),
  expectedVersion: Schema.optionalKey(ArtifactStateVersion),
});
export type ArtifactStatePatch = typeof ArtifactStatePatch.Type;

export const ArtifactUserAction = Schema.Struct({
  actionName: TrimmedNonEmptyString.check(Schema.isMaxLength(ARTIFACT_ACTION_NAME_MAX_LENGTH)),
  payload: Schema.Record(Schema.String, Schema.Unknown),
  promptText: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(ARTIFACT_PROMPT_TEXT_MAX_LENGTH)),
  ),
});
export type ArtifactUserAction = typeof ArtifactUserAction.Type;

export const Artifact = Schema.Struct({
  id: ArtifactId,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  kind: ArtifactKind,
  title: ArtifactTitle,
  currentVersion: ArtifactVersionNumber,
  stateVersion: ArtifactStateVersion,
  state: ArtifactState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type Artifact = typeof Artifact.Type;

export const ArtifactVersion = Schema.Struct({
  artifactId: ArtifactId,
  version: ArtifactVersionNumber,
  author: ArtifactAuthor,
  content: ArtifactContent,
  summary: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  createdAt: IsoDateTime,
});
export type ArtifactVersion = typeof ArtifactVersion.Type;

export const ArtifactVersionSummary = Schema.Struct({
  artifactId: ArtifactId,
  version: ArtifactVersionNumber,
  author: ArtifactAuthor,
  summary: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  contentLength: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type ArtifactVersionSummary = typeof ArtifactVersionSummary.Type;

export const ArtifactCreateInput = Schema.Struct({
  threadId: ThreadId,
  kind: ArtifactKind,
  title: ArtifactTitle,
  content: ArtifactContent,
  author: Schema.optionalKey(ArtifactAuthor),
  initialState: Schema.optionalKey(ArtifactState),
});
export type ArtifactCreateInput = typeof ArtifactCreateInput.Type;

export const ArtifactReviseInput = Schema.Struct({
  artifactId: ArtifactId,
  content: ArtifactContent,
  author: Schema.optionalKey(ArtifactAuthor),
  title: Schema.optionalKey(ArtifactTitle),
  summary: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
});
export type ArtifactReviseInput = typeof ArtifactReviseInput.Type;

export const ArtifactGetInput = Schema.Struct({
  artifactId: ArtifactId,
  version: Schema.optionalKey(ArtifactVersionNumber),
});
export type ArtifactGetInput = typeof ArtifactGetInput.Type;

export const ArtifactListInput = Schema.Struct({
  threadId: ThreadId,
  includeArchived: Schema.optionalKey(Schema.Boolean),
});
export type ArtifactListInput = typeof ArtifactListInput.Type;

export const ArtifactListVersionsInput = Schema.Struct({ artifactId: ArtifactId });
export type ArtifactListVersionsInput = typeof ArtifactListVersionsInput.Type;

export const ArtifactSwitchVersionInput = Schema.Struct({
  artifactId: ArtifactId,
  version: ArtifactVersionNumber,
});
export type ArtifactSwitchVersionInput = typeof ArtifactSwitchVersionInput.Type;

export const ArtifactArchiveInput = Schema.Struct({
  artifactId: ArtifactId,
  archived: Schema.Boolean,
});
export type ArtifactArchiveInput = typeof ArtifactArchiveInput.Type;

export const ArtifactPatchStateInput = Schema.Struct({
  artifactId: ArtifactId,
  ...ArtifactStatePatch.fields,
});
export type ArtifactPatchStateInput = typeof ArtifactPatchStateInput.Type;

export const ArtifactUserActionInput = Schema.Struct({
  artifactId: ArtifactId,
  action: ArtifactUserAction,
});
export type ArtifactUserActionInput = typeof ArtifactUserActionInput.Type;

export const ArtifactResult = Schema.Struct({
  artifact: Artifact,
  version: ArtifactVersion,
});
export type ArtifactResult = typeof ArtifactResult.Type;

export const ArtifactListResult = Schema.Struct({
  artifacts: Schema.Array(Artifact),
});
export type ArtifactListResult = typeof ArtifactListResult.Type;

export const ArtifactListVersionsResult = Schema.Struct({
  versions: Schema.Array(ArtifactVersionSummary),
});
export type ArtifactListVersionsResult = typeof ArtifactListVersionsResult.Type;

export const ArtifactPatchStateResult = Schema.Struct({
  artifact: Artifact,
});
export type ArtifactPatchStateResult = typeof ArtifactPatchStateResult.Type;

export const ArtifactUserActionResult = Schema.Struct({
  accepted: Schema.Boolean,
  stateVersion: ArtifactStateVersion,
  startedTurn: Schema.Boolean,
});
export type ArtifactUserActionResult = typeof ArtifactUserActionResult.Type;

export class ArtifactNotFoundError extends Schema.TaggedError<ArtifactNotFoundError>()(
  "ArtifactNotFoundError",
  {
    artifactId: ArtifactId,
  },
) {
  override get message(): string {
    return `Artifact ${this.artifactId} was not found.`;
  }
}

export class ArtifactVersionNotFoundError extends Schema.TaggedError<ArtifactVersionNotFoundError>()(
  "ArtifactVersionNotFoundError",
  {
    artifactId: ArtifactId,
    version: ArtifactVersionNumber,
  },
) {
  override get message(): string {
    return `Artifact ${this.artifactId} has no version ${this.version}.`;
  }
}

export class ArtifactStateConflictError extends Schema.TaggedError<ArtifactStateConflictError>()(
  "ArtifactStateConflictError",
  {
    artifactId: ArtifactId,
    expectedVersion: ArtifactStateVersion,
    actualVersion: ArtifactStateVersion,
  },
) {
  override get message(): string {
    return `Artifact ${this.artifactId} state is at version ${this.actualVersion}, not ${this.expectedVersion}.`;
  }
}

export class ArtifactStateTooLargeError extends Schema.TaggedError<ArtifactStateTooLargeError>()(
  "ArtifactStateTooLargeError",
  {
    artifactId: ArtifactId,
    limitBytes: PositiveInt,
    actualBytes: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Artifact ${this.artifactId} state would be ${this.actualBytes} bytes; the limit is ${this.limitBytes}.`;
  }
}

export class ArtifactInvalidStateError extends Schema.TaggedError<ArtifactInvalidStateError>()(
  "ArtifactInvalidStateError",
  {
    artifactId: ArtifactId,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Artifact ${this.artifactId} state patch is invalid: ${this.detail}`;
  }
}

export class ArtifactArchivedError extends Schema.TaggedError<ArtifactArchivedError>()(
  "ArtifactArchivedError",
  {
    artifactId: ArtifactId,
  },
) {
  override get message(): string {
    return `Artifact ${this.artifactId} is archived.`;
  }
}

export const ArtifactError = Schema.Union([
  ArtifactNotFoundError,
  ArtifactVersionNotFoundError,
  ArtifactStateConflictError,
  ArtifactStateTooLargeError,
  ArtifactInvalidStateError,
  ArtifactArchivedError,
]);
export type ArtifactError = typeof ArtifactError.Type;

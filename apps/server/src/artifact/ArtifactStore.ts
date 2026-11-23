import {
  Artifact,
  type ArtifactAuthor,
  ArtifactArchivedError,
  type ArtifactError,
  ArtifactId,
  ArtifactInvalidStateError,
  ArtifactKind,
  ArtifactNotFoundError,
  type ArtifactResult,
  ArtifactState,
  ArtifactStateConflictError,
  ArtifactStateVersion,
  ArtifactTitle,
  type ArtifactUserAction,
  type ArtifactVersion,
  ArtifactVersionNotFoundError,
  ArtifactVersionNumber,
  type ArtifactVersionSummary,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

export interface ArtifactStoreCreateInput {
  readonly id: ArtifactId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly content: string;
  readonly author?: ArtifactAuthor | undefined;
  readonly summary?: string | undefined;
  readonly initialState?: ArtifactState | undefined;
}

export interface ArtifactStoreReviseInput {
  readonly artifactId: ArtifactId;
  readonly content: string;
  readonly author?: ArtifactAuthor | undefined;
  readonly title?: string | undefined;
  readonly summary?: string | undefined;
}

export interface ArtifactActionRecord {
  readonly id: string;
  readonly artifactId: ArtifactId;
  readonly threadId: ThreadId;
  readonly actionName: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly promptText?: string | undefined;
  readonly stateVersion: number;
  readonly createdAt: IsoDateTime;
}

export class ArtifactStore extends Context.Service<
  ArtifactStore,
  {
    readonly create: (
      input: ArtifactStoreCreateInput,
    ) => Effect.Effect<ArtifactResult, ArtifactError>;
    readonly revise: (
      input: ArtifactStoreReviseInput,
    ) => Effect.Effect<ArtifactResult, ArtifactError>;
    readonly get: (input: {
      readonly artifactId: ArtifactId;
      readonly version?: number | undefined;
    }) => Effect.Effect<ArtifactResult, ArtifactError>;
    readonly findById: (artifactId: ArtifactId) => Effect.Effect<Artifact | null, ArtifactError>;
    readonly listByThread: (input: {
      readonly threadId: ThreadId;
      readonly includeArchived?: boolean | undefined;
    }) => Effect.Effect<ReadonlyArray<Artifact>, ArtifactError>;
    readonly listVersions: (
      artifactId: ArtifactId,
    ) => Effect.Effect<ReadonlyArray<ArtifactVersionSummary>, ArtifactError>;
    readonly switchVersion: (input: {
      readonly artifactId: ArtifactId;
      readonly version: number;
    }) => Effect.Effect<ArtifactResult, ArtifactError>;
    readonly setArchived: (input: {
      readonly artifactId: ArtifactId;
      readonly archived: boolean;
    }) => Effect.Effect<Artifact, ArtifactError>;
    readonly updateStateOptimistic: (input: {
      readonly artifactId: ArtifactId;
      readonly expectedVersion: number;
      readonly nextState: ArtifactState;
    }) => Effect.Effect<Artifact, ArtifactError>;
    readonly recordAction: (input: {
      readonly id: string;
      readonly artifactId: ArtifactId;
      readonly threadId: ThreadId;
      readonly action: ArtifactUserAction;
      readonly stateVersion: number;
    }) => Effect.Effect<ArtifactActionRecord, ArtifactError>;
    readonly listActions: (
      artifactId: ArtifactId,
    ) => Effect.Effect<ReadonlyArray<ArtifactActionRecord>, ArtifactError>;
  }
>()("t3/artifact/ArtifactStore") {}

const ArtifactRow = Schema.Struct({
  id: ArtifactId,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  kind: ArtifactKind,
  title: ArtifactTitle,
  currentVersion: ArtifactVersionNumber,
  stateVersion: ArtifactStateVersion,
  state: Schema.fromJsonString(ArtifactState),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});

const ArtifactVersionRow = Schema.Struct({
  artifactId: ArtifactId,
  version: ArtifactVersionNumber,
  author: Schema.Literals(["agent", "user"]),
  content: Schema.String,
  summary: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ArtifactVersionSummaryRow = Schema.Struct({
  artifactId: ArtifactId,
  version: ArtifactVersionNumber,
  author: Schema.Literals(["agent", "user"]),
  summary: Schema.NullOr(TrimmedNonEmptyString),
  contentLength: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ArtifactActionRow = Schema.Struct({
  id: Schema.String,
  artifactId: ArtifactId,
  threadId: ThreadId,
  actionName: Schema.String,
  payload: Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
  promptText: Schema.NullOr(Schema.String),
  stateVersion: ArtifactStateVersion,
  createdAt: IsoDateTime,
});

const VersionLookupRequest = Schema.Struct({
  artifactId: ArtifactId,
  version: ArtifactVersionNumber,
});

const encodeStateJson = Schema.encodeEffect(Schema.fromJsonString(ArtifactState));
const encodePayloadJson = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const toArtifactVersion = (row: typeof ArtifactVersionRow.Type): ArtifactVersion => ({
  artifactId: row.artifactId,
  version: row.version,
  author: row.author,
  content: row.content,
  ...(row.summary === null ? {} : { summary: row.summary }),
  createdAt: row.createdAt,
});

const toArtifactVersionSummary = (
  row: typeof ArtifactVersionSummaryRow.Type,
): ArtifactVersionSummary => ({
  artifactId: row.artifactId,
  version: row.version,
  author: row.author,
  ...(row.summary === null ? {} : { summary: row.summary }),
  contentLength: row.contentLength,
  createdAt: row.createdAt,
});

const toArtifactActionRecord = (row: typeof ArtifactActionRow.Type): ArtifactActionRecord => ({
  id: row.id,
  artifactId: row.artifactId,
  threadId: row.threadId,
  actionName: row.actionName,
  payload: row.payload,
  ...(row.promptText === null ? {} : { promptText: row.promptText }),
  stateVersion: row.stateVersion,
  createdAt: row.createdAt,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const storageFailure = (artifactId: ArtifactId, detail: string) => (cause: unknown) =>
    new ArtifactInvalidStateError({
      artifactId,
      detail: cause instanceof Error ? `${detail}: ${cause.message}` : detail,
    });

  const artifactColumns = sql`
    id,
    environment_id AS "environmentId",
    project_id AS "projectId",
    thread_id AS "threadId",
    kind,
    title,
    active_version AS "currentVersion",
    state_version AS "stateVersion",
    state_json AS "state",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    archived_at AS "archivedAt"
  `;

  const versionColumns = sql`
    artifact_id AS "artifactId",
    version,
    author,
    content,
    summary,
    created_at AS "createdAt"
  `;

  const findArtifactById = SqlSchema.findOneOption({
    Request: ArtifactId,
    Result: ArtifactRow,
    execute: (artifactId) => sql`
      SELECT ${artifactColumns}
      FROM artifacts
      WHERE id = ${artifactId}
      LIMIT 1
    `,
  });

  const findVersion = SqlSchema.findOneOption({
    Request: VersionLookupRequest,
    Result: ArtifactVersionRow,
    execute: ({ artifactId, version }) => sql`
      SELECT ${versionColumns}
      FROM artifact_versions
      WHERE artifact_id = ${artifactId} AND version = ${version}
      LIMIT 1
    `,
  });

  const listActiveByThreadRows = SqlSchema.findAll({
    Request: ThreadId,
    Result: ArtifactRow,
    execute: (threadId) => sql`
      SELECT ${artifactColumns}
      FROM artifacts
      WHERE thread_id = ${threadId} AND archived_at IS NULL
      ORDER BY updated_at DESC, id ASC
    `,
  });

  const listAllByThreadRows = SqlSchema.findAll({
    Request: ThreadId,
    Result: ArtifactRow,
    execute: (threadId) => sql`
      SELECT ${artifactColumns}
      FROM artifacts
      WHERE thread_id = ${threadId}
      ORDER BY updated_at DESC, id ASC
    `,
  });

  const listVersionSummaryRows = SqlSchema.findAll({
    Request: ArtifactId,
    Result: ArtifactVersionSummaryRow,
    execute: (artifactId) => sql`
      SELECT
        artifact_id AS "artifactId",
        version,
        author,
        summary,
        length(content) AS "contentLength",
        created_at AS "createdAt"
      FROM artifact_versions
      WHERE artifact_id = ${artifactId}
      ORDER BY version DESC
    `,
  });

  const listActionRows = SqlSchema.findAll({
    Request: ArtifactId,
    Result: ArtifactActionRow,
    execute: (artifactId) => sql`
      SELECT
        id,
        artifact_id AS "artifactId",
        thread_id AS "threadId",
        action_name AS "actionName",
        payload_json AS "payload",
        prompt_text AS "promptText",
        state_version AS "stateVersion",
        created_at AS "createdAt"
      FROM artifact_actions
      WHERE artifact_id = ${artifactId}
      ORDER BY created_at DESC, id DESC
    `,
  });

  const requireArtifact = Effect.fn("ArtifactStore.requireArtifact")(function* (
    artifactId: ArtifactId,
  ) {
    const found = yield* findArtifactById(artifactId).pipe(
      Effect.mapError(storageFailure(artifactId, "Could not read artifact")),
    );
    if (Option.isNone(found)) {
      return yield* new ArtifactNotFoundError({ artifactId });
    }
    return found.value;
  });

  const create: ArtifactStore["Service"]["create"] = Effect.fn("ArtifactStore.create")(
    function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const state = input.initialState ?? {};
      const stateJson = yield* encodeStateJson(state).pipe(
        Effect.mapError(storageFailure(input.id, "Could not encode initial state")),
      );
      const author: ArtifactAuthor = input.author ?? "agent";
      const title = input.title.trim();
      const summary = input.summary?.trim() || null;

      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
            INSERT INTO artifacts (
              id,
              environment_id,
              project_id,
              thread_id,
              kind,
              title,
              active_version,
              state_version,
              state_json,
              created_at,
              updated_at,
              archived_at
            ) VALUES (
              ${input.id},
              ${input.environmentId},
              ${input.projectId},
              ${input.threadId},
              ${input.kind},
              ${title},
              1,
              0,
              ${stateJson},
              ${now},
              ${now},
              ${null}
            )
          `;
            yield* sql`
            INSERT INTO artifact_versions (
              artifact_id,
              version,
              author,
              content,
              summary,
              created_at
            ) VALUES (
              ${input.id},
              1,
              ${author},
              ${input.content},
              ${summary},
              ${now}
            )
          `;
          }),
        )
        .pipe(Effect.mapError(storageFailure(input.id, "Could not create artifact")));

      const artifact: Artifact = {
        id: input.id,
        environmentId: input.environmentId,
        projectId: input.projectId,
        threadId: input.threadId,
        kind: input.kind,
        title,
        currentVersion: 1,
        stateVersion: 0,
        state,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      const version: ArtifactVersion = {
        artifactId: input.id,
        version: 1,
        author,
        content: input.content,
        ...(summary === null ? {} : { summary }),
        createdAt: now,
      };
      return { artifact, version };
    },
  );

  const revise: ArtifactStore["Service"]["revise"] = Effect.fn("ArtifactStore.revise")(
    function* (input) {
      const existing = yield* requireArtifact(input.artifactId);
      if (existing.archivedAt !== null) {
        return yield* new ArtifactArchivedError({ artifactId: input.artifactId });
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      const author: ArtifactAuthor = input.author ?? "agent";
      const nextTitle = input.title !== undefined ? input.title.trim() : existing.title;
      const summary = input.summary?.trim() || null;

      const nextVersion = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const maxRows = yield* sql<{ readonly maxVersion: number }>`
            SELECT COALESCE(MAX(version), 0) AS "maxVersion"
            FROM artifact_versions
            WHERE artifact_id = ${input.artifactId}
          `;
            const versionNumber = (maxRows[0]?.maxVersion ?? existing.currentVersion) + 1;
            yield* sql`
            INSERT INTO artifact_versions (
              artifact_id,
              version,
              author,
              content,
              summary,
              created_at
            ) VALUES (
              ${input.artifactId},
              ${versionNumber},
              ${author},
              ${input.content},
              ${summary},
              ${now}
            )
          `;
            yield* sql`
            UPDATE artifacts
            SET
              active_version = ${versionNumber},
              title = ${nextTitle},
              updated_at = ${now}
            WHERE id = ${input.artifactId}
          `;
            return versionNumber;
          }),
        )
        .pipe(Effect.mapError(storageFailure(input.artifactId, "Could not revise artifact")));

      const artifact: Artifact = {
        ...existing,
        title: nextTitle,
        currentVersion: nextVersion,
        updatedAt: now,
      };
      const version: ArtifactVersion = {
        artifactId: input.artifactId,
        version: nextVersion,
        author,
        content: input.content,
        ...(summary === null ? {} : { summary }),
        createdAt: now,
      };
      return { artifact, version };
    },
  );

  const get: ArtifactStore["Service"]["get"] = Effect.fn("ArtifactStore.get")(function* (input) {
    const artifact = yield* requireArtifact(input.artifactId);
    const targetVersion = input.version ?? artifact.currentVersion;
    const versionRow = yield* findVersion({
      artifactId: input.artifactId,
      version: targetVersion,
    }).pipe(Effect.mapError(storageFailure(input.artifactId, "Could not read artifact version")));
    if (Option.isNone(versionRow)) {
      return yield* new ArtifactVersionNotFoundError({
        artifactId: input.artifactId,
        version: targetVersion,
      });
    }
    return {
      artifact,
      version: toArtifactVersion(versionRow.value),
    };
  });

  const findById: ArtifactStore["Service"]["findById"] = Effect.fn("ArtifactStore.findById")(
    function* (artifactId) {
      const found = yield* findArtifactById(artifactId).pipe(
        Effect.mapError(storageFailure(artifactId, "Could not read artifact")),
      );
      return Option.getOrNull(found);
    },
  );

  const listByThread: ArtifactStore["Service"]["listByThread"] = Effect.fn(
    "ArtifactStore.listByThread",
  )(function* (input) {
    const fallbackId = ArtifactId.make("artifact:list");
    const query = input.includeArchived === true ? listAllByThreadRows : listActiveByThreadRows;
    return yield* query(input.threadId).pipe(
      Effect.mapError(storageFailure(fallbackId, "Could not list thread artifacts")),
    );
  });

  const listVersions: ArtifactStore["Service"]["listVersions"] = Effect.fn(
    "ArtifactStore.listVersions",
  )(function* (artifactId) {
    yield* requireArtifact(artifactId);
    const rows = yield* listVersionSummaryRows(artifactId).pipe(
      Effect.mapError(storageFailure(artifactId, "Could not list artifact versions")),
    );
    return rows.map(toArtifactVersionSummary);
  });

  const switchVersion: ArtifactStore["Service"]["switchVersion"] = Effect.fn(
    "ArtifactStore.switchVersion",
  )(function* (input) {
    const existing = yield* requireArtifact(input.artifactId);
    if (existing.archivedAt !== null) {
      return yield* new ArtifactArchivedError({ artifactId: input.artifactId });
    }
    const versionRow = yield* findVersion({
      artifactId: input.artifactId,
      version: input.version,
    }).pipe(Effect.mapError(storageFailure(input.artifactId, "Could not read artifact version")));
    if (Option.isNone(versionRow)) {
      return yield* new ArtifactVersionNotFoundError({
        artifactId: input.artifactId,
        version: input.version,
      });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE artifacts
      SET active_version = ${input.version}, updated_at = ${now}
      WHERE id = ${input.artifactId}
    `.pipe(Effect.mapError(storageFailure(input.artifactId, "Could not switch artifact version")));

    return {
      artifact: {
        ...existing,
        currentVersion: input.version,
        updatedAt: now,
      },
      version: toArtifactVersion(versionRow.value),
    };
  });

  const setArchived: ArtifactStore["Service"]["setArchived"] = Effect.fn(
    "ArtifactStore.setArchived",
  )(function* (input) {
    const existing = yield* requireArtifact(input.artifactId);
    const now = DateTime.formatIso(yield* DateTime.now);
    const archivedAt = input.archived ? (existing.archivedAt ?? now) : null;
    yield* sql`
      UPDATE artifacts
      SET archived_at = ${archivedAt}, updated_at = ${now}
      WHERE id = ${input.artifactId}
    `.pipe(Effect.mapError(storageFailure(input.artifactId, "Could not update archive status")));

    return {
      ...existing,
      archivedAt,
      updatedAt: now,
    };
  });

  const updateStateOptimistic: ArtifactStore["Service"]["updateStateOptimistic"] = Effect.fn(
    "ArtifactStore.updateStateOptimistic",
  )(function* (input) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const stateJson = yield* encodeStateJson(input.nextState).pipe(
      Effect.mapError(storageFailure(input.artifactId, "Could not encode artifact state")),
    );

    const updated = yield* sql<{ readonly stateVersion: number }>`
      UPDATE artifacts
      SET
        state_json = ${stateJson},
        state_version = state_version + 1,
        updated_at = ${now}
      WHERE id = ${input.artifactId}
        AND state_version = ${input.expectedVersion}
        AND archived_at IS NULL
      RETURNING state_version AS "stateVersion"
    `.pipe(Effect.mapError(storageFailure(input.artifactId, "Could not update artifact state")));

    if (updated.length === 0) {
      const current = yield* requireArtifact(input.artifactId);
      if (current.archivedAt !== null) {
        return yield* new ArtifactArchivedError({ artifactId: input.artifactId });
      }
      return yield* new ArtifactStateConflictError({
        artifactId: input.artifactId,
        expectedVersion: input.expectedVersion,
        actualVersion: current.stateVersion,
      });
    }

    return yield* requireArtifact(input.artifactId);
  });

  const recordAction: ArtifactStore["Service"]["recordAction"] = Effect.fn(
    "ArtifactStore.recordAction",
  )(function* (input) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const payloadJson = yield* encodePayloadJson(input.action.payload).pipe(
      Effect.mapError(storageFailure(input.artifactId, "Could not encode action payload")),
    );
    const promptText = input.action.promptText ?? null;

    yield* sql`
      INSERT INTO artifact_actions (
        id,
        artifact_id,
        thread_id,
        action_name,
        payload_json,
        prompt_text,
        state_version,
        created_at
      ) VALUES (
        ${input.id},
        ${input.artifactId},
        ${input.threadId},
        ${input.action.actionName},
        ${payloadJson},
        ${promptText},
        ${input.stateVersion},
        ${now}
      )
    `.pipe(Effect.mapError(storageFailure(input.artifactId, "Could not record artifact action")));

    return {
      id: input.id,
      artifactId: input.artifactId,
      threadId: input.threadId,
      actionName: input.action.actionName,
      payload: input.action.payload,
      ...(promptText === null ? {} : { promptText }),
      stateVersion: input.stateVersion,
      createdAt: now,
    };
  });

  const listActions: ArtifactStore["Service"]["listActions"] = Effect.fn(
    "ArtifactStore.listActions",
  )(function* (artifactId) {
    yield* requireArtifact(artifactId);
    const rows = yield* listActionRows(artifactId).pipe(
      Effect.mapError(storageFailure(artifactId, "Could not list artifact actions")),
    );
    return rows.map(toArtifactActionRecord);
  });

  return ArtifactStore.of({
    create,
    revise,
    get,
    findById,
    listByThread,
    listVersions,
    switchVersion,
    setArchived,
    updateStateOptimistic,
    recordAction,
    listActions,
  });
});

export const layer = Layer.effect(ArtifactStore, make);

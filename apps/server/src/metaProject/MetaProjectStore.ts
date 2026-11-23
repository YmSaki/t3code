import {
  EnvironmentId,
  IsoDateTime,
  type MetaProject,
  MetaProjectError,
  MetaProjectId,
  type MetaProjectMember,
  MetaProjectRole,
  type MetaProjectThreadLink,
  MetaProjectThreadRole,
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

import Migration0106 from "../persistence/Migrations/106_MetaProjects.ts";

export interface MetaProjectStoreCreateInput {
  readonly id: MetaProjectId;
  readonly title: string;
  readonly description?: string | null | undefined;
  readonly instructionsMd?: string | undefined;
  readonly members?: ReadonlyArray<MetaProjectMember> | undefined;
  readonly threadLinks?: ReadonlyArray<MetaProjectThreadLink> | undefined;
  readonly now?: IsoDateTime | undefined;
}

export interface MetaProjectStoreUpdateInput {
  readonly metaProjectId: MetaProjectId;
  readonly title?: string | undefined;
  readonly description?: string | null | undefined;
  readonly instructionsMd?: string | undefined;
  readonly pinned?: boolean | undefined;
  readonly archived?: boolean | undefined;
  readonly now?: IsoDateTime | undefined;
}

export interface MetaProjectStoreShape {
  readonly list: (options?: {
    readonly includeArchived?: boolean | undefined;
    readonly includeDeleted?: boolean | undefined;
  }) => Effect.Effect<ReadonlyArray<MetaProject>, MetaProjectError>;
  readonly get: (
    metaProjectId: MetaProjectId,
    options?: { readonly includeDeleted?: boolean | undefined },
  ) => Effect.Effect<Option.Option<MetaProject>, MetaProjectError>;
  readonly create: (
    input: MetaProjectStoreCreateInput,
  ) => Effect.Effect<MetaProject, MetaProjectError>;
  readonly update: (
    input: MetaProjectStoreUpdateInput,
  ) => Effect.Effect<MetaProject, MetaProjectError>;
  readonly delete: (
    metaProjectId: MetaProjectId,
    options?: {
      readonly hard?: boolean | undefined;
      readonly now?: IsoDateTime | undefined;
    },
  ) => Effect.Effect<boolean, MetaProjectError>;
  readonly addMember: (input: {
    readonly metaProjectId: MetaProjectId;
    readonly member: MetaProjectMember;
    readonly now?: IsoDateTime | undefined;
  }) => Effect.Effect<MetaProject, MetaProjectError>;
  readonly updateMember: (input: {
    readonly metaProjectId: MetaProjectId;
    readonly member: MetaProjectMember;
    readonly now?: IsoDateTime | undefined;
  }) => Effect.Effect<MetaProject, MetaProjectError>;
  readonly removeMember: (input: {
    readonly metaProjectId: MetaProjectId;
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly now?: IsoDateTime | undefined;
  }) => Effect.Effect<
    { readonly metaProject: MetaProject; readonly removed: boolean },
    MetaProjectError
  >;
  readonly listMembers: (
    metaProjectId: MetaProjectId,
  ) => Effect.Effect<ReadonlyArray<MetaProjectMember>, MetaProjectError>;
  readonly linkThread: (input: {
    readonly metaProjectId: MetaProjectId;
    readonly threadLink: MetaProjectThreadLink;
    readonly now?: IsoDateTime | undefined;
  }) => Effect.Effect<MetaProject, MetaProjectError>;
  readonly unlinkThread: (input: {
    readonly metaProjectId: MetaProjectId;
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly now?: IsoDateTime | undefined;
  }) => Effect.Effect<
    { readonly metaProject: MetaProject; readonly unlinked: boolean },
    MetaProjectError
  >;
  readonly listThreadLinks: (
    metaProjectId: MetaProjectId,
  ) => Effect.Effect<ReadonlyArray<MetaProjectThreadLink>, MetaProjectError>;
  readonly findByMemberProject: (input: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => Effect.Effect<ReadonlyArray<MetaProject>, MetaProjectError>;
  readonly replaceMembersAndThreads: (input: {
    readonly metaProjectId: MetaProjectId;
    readonly members: ReadonlyArray<MetaProjectMember>;
    readonly threadLinks: ReadonlyArray<MetaProjectThreadLink>;
    readonly now?: IsoDateTime | undefined;
  }) => Effect.Effect<MetaProject, MetaProjectError>;
}

export class MetaProjectStore extends Context.Service<MetaProjectStore, MetaProjectStoreShape>()(
  "t3/metaProject/MetaProjectStore",
) {}

const MetaProjectRow = Schema.Struct({
  id: MetaProjectId,
  title: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  instructionsMd: Schema.String,
  pinnedAt: Schema.NullOr(IsoDateTime),
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
type MetaProjectRow = typeof MetaProjectRow.Type;

const MetaProjectMemberRow = Schema.Struct({
  metaProjectId: MetaProjectId,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  role: MetaProjectRole,
  label: Schema.NullOr(TrimmedNonEmptyString),
  description: Schema.NullOr(Schema.String),
  sortOrder: NonNegativeInt,
  addedAt: IsoDateTime,
});
type MetaProjectMemberRow = typeof MetaProjectMemberRow.Type;

const MetaProjectThreadRow = Schema.Struct({
  metaProjectId: MetaProjectId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  role: MetaProjectThreadRole,
  projectId: Schema.NullOr(ProjectId),
  title: Schema.NullOr(TrimmedNonEmptyString),
  linkedAt: IsoDateTime,
});
type MetaProjectThreadRow = typeof MetaProjectThreadRow.Type;

const toMember = (row: MetaProjectMemberRow): MetaProjectMember => ({
  environmentId: row.environmentId,
  projectId: row.projectId,
  role: row.role,
  label: row.label,
  description: row.description,
  sortOrder: row.sortOrder,
  addedAt: row.addedAt,
});

const toThreadLink = (row: MetaProjectThreadRow): MetaProjectThreadLink => ({
  environmentId: row.environmentId,
  threadId: row.threadId,
  role: row.role,
  projectId: row.projectId,
  title: row.title,
  linkedAt: row.linkedAt,
});

const isMetaProjectError = Schema.is(MetaProjectError);

const storageError = (
  operation: string,
  cause: unknown,
  metaProjectId?: MetaProjectId | undefined,
): MetaProjectError =>
  isMetaProjectError(cause)
    ? cause
    : new MetaProjectError({
        reason: "storage_failed",
        message: `MetaProject store operation '${operation}' failed.`,
        ...(metaProjectId === undefined ? {} : { metaProjectId }),
        cause,
      });

const notFoundError = (metaProjectId: MetaProjectId): MetaProjectError =>
  new MetaProjectError({
    reason: "not_found",
    message: `MetaProject '${metaProjectId}' was not found.`,
    metaProjectId,
  });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Migration0106;

  const currentIsoNow = Effect.map(DateTime.now, DateTime.formatIso);

  const metaColumns = sql`
    id,
    title,
    description,
    instructions_md AS "instructionsMd",
    pinned_at AS "pinnedAt",
    archived_at AS "archivedAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    deleted_at AS "deletedAt"
  `;

  const memberColumns = sql`
    meta_project_id AS "metaProjectId",
    environment_id AS "environmentId",
    project_id AS "projectId",
    role,
    label,
    description,
    sort_order AS "sortOrder",
    added_at AS "addedAt"
  `;

  const threadColumns = sql`
    meta_project_id AS "metaProjectId",
    environment_id AS "environmentId",
    thread_id AS "threadId",
    role,
    project_id AS "projectId",
    title,
    linked_at AS "linkedAt"
  `;

  const findMetaRowById = SqlSchema.findOneOption({
    Request: MetaProjectId,
    Result: MetaProjectRow,
    execute: (id) => sql`SELECT ${metaColumns} FROM meta_projects WHERE id = ${id}`,
  });

  const findAllMetaRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: MetaProjectRow,
    execute: () =>
      sql`SELECT ${metaColumns} FROM meta_projects ORDER BY CASE WHEN pinned_at IS NOT NULL THEN 0 ELSE 1 END, title ASC, id ASC`,
  });

  const findMembersByMetaId = SqlSchema.findAll({
    Request: MetaProjectId,
    Result: MetaProjectMemberRow,
    execute: (id) => sql`
      SELECT ${memberColumns} FROM meta_project_members
      WHERE meta_project_id = ${id}
      ORDER BY sort_order ASC, environment_id ASC, project_id ASC
    `,
  });

  const findAllMembers = SqlSchema.findAll({
    Request: Schema.Void,
    Result: MetaProjectMemberRow,
    execute: () => sql`
      SELECT ${memberColumns} FROM meta_project_members
      ORDER BY meta_project_id ASC, sort_order ASC, environment_id ASC, project_id ASC
    `,
  });

  const findThreadsByMetaId = SqlSchema.findAll({
    Request: MetaProjectId,
    Result: MetaProjectThreadRow,
    execute: (id) => sql`
      SELECT ${threadColumns} FROM meta_project_threads
      WHERE meta_project_id = ${id}
      ORDER BY linked_at DESC, environment_id ASC, thread_id ASC
    `,
  });

  const findAllThreads = SqlSchema.findAll({
    Request: Schema.Void,
    Result: MetaProjectThreadRow,
    execute: () => sql`
      SELECT ${threadColumns} FROM meta_project_threads
      ORDER BY meta_project_id ASC, linked_at DESC, environment_id ASC, thread_id ASC
    `,
  });

  const hydrateRow = (
    row: MetaProjectRow,
    members: ReadonlyArray<MetaProjectMember>,
    threadLinks: ReadonlyArray<MetaProjectThreadLink>,
  ): MetaProject => ({
    id: row.id,
    title: row.title,
    description: row.description,
    instructionsMd: row.instructionsMd,
    members,
    threadLinks,
    pinnedAt: row.pinnedAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });

  const get: MetaProjectStoreShape["get"] = Effect.fn("MetaProjectStore.get")(
    function* (metaProjectId, options) {
      const maybeRow = yield* findMetaRowById(metaProjectId).pipe(
        Effect.mapError((cause) => storageError("get", cause, metaProjectId)),
      );
      if (Option.isNone(maybeRow)) return Option.none();
      if (!options?.includeDeleted && maybeRow.value.deletedAt !== null) {
        return Option.none();
      }
      const members = (yield* findMembersByMetaId(metaProjectId).pipe(
        Effect.mapError((cause) => storageError("get.members", cause, metaProjectId)),
      )).map(toMember);
      const threadLinks = (yield* findThreadsByMetaId(metaProjectId).pipe(
        Effect.mapError((cause) => storageError("get.threads", cause, metaProjectId)),
      )).map(toThreadLink);
      return Option.some(hydrateRow(maybeRow.value, members, threadLinks));
    },
  );

  const requireExisting = (metaProjectId: MetaProjectId) =>
    get(metaProjectId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(notFoundError(metaProjectId)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const list: MetaProjectStoreShape["list"] = Effect.fn("MetaProjectStore.list")(
    function* (options) {
      const includeArchived = options?.includeArchived ?? false;
      const includeDeleted = options?.includeDeleted ?? false;

      const rows = (yield* findAllMetaRows(undefined).pipe(
        Effect.mapError((cause) => storageError("list", cause)),
      )).filter(
        (row) =>
          (includeDeleted || row.deletedAt === null) &&
          (includeArchived || row.archivedAt === null),
      );

      if (rows.length === 0) return [];

      const allMembers = yield* findAllMembers(undefined).pipe(
        Effect.mapError((cause) => storageError("list.members", cause)),
      );
      const allThreads = yield* findAllThreads(undefined).pipe(
        Effect.mapError((cause) => storageError("list.threads", cause)),
      );

      const membersByMeta = new Map<MetaProjectId, MetaProjectMember[]>();
      for (const memberRow of allMembers) {
        const bucket = membersByMeta.get(memberRow.metaProjectId);
        const member = toMember(memberRow);
        if (bucket !== undefined) {
          bucket.push(member);
        } else {
          membersByMeta.set(memberRow.metaProjectId, [member]);
        }
      }

      const threadsByMeta = new Map<MetaProjectId, MetaProjectThreadLink[]>();
      for (const threadRow of allThreads) {
        const bucket = threadsByMeta.get(threadRow.metaProjectId);
        const link = toThreadLink(threadRow);
        if (bucket !== undefined) {
          bucket.push(link);
        } else {
          threadsByMeta.set(threadRow.metaProjectId, [link]);
        }
      }

      return rows.map((row) =>
        hydrateRow(row, membersByMeta.get(row.id) ?? [], threadsByMeta.get(row.id) ?? []),
      );
    },
  );

  const insertMemberRow = (
    metaProjectId: MetaProjectId,
    member: MetaProjectMember,
    fallbackIndex: number,
    now: IsoDateTime,
  ) =>
    sql`
      INSERT INTO meta_project_members (
        meta_project_id, environment_id, project_id, role,
        label, description, sort_order, added_at
      ) VALUES (
        ${metaProjectId}, ${member.environmentId}, ${member.projectId}, ${member.role},
        ${member.label ?? null}, ${member.description ?? null},
        ${member.sortOrder ?? fallbackIndex}, ${member.addedAt ?? now}
      )
    `;

  const insertThreadRow = (
    metaProjectId: MetaProjectId,
    link: MetaProjectThreadLink,
    now: IsoDateTime,
  ) =>
    sql`
      INSERT INTO meta_project_threads (
        meta_project_id, environment_id, thread_id, role,
        project_id, title, linked_at
      ) VALUES (
        ${metaProjectId}, ${link.environmentId}, ${link.threadId}, ${link.role},
        ${link.projectId ?? null}, ${link.title ?? null}, ${link.linkedAt ?? now}
      )
    `;

  const create: MetaProjectStoreShape["create"] = Effect.fn("MetaProjectStore.create")(
    function* (input) {
      const now = input.now ?? (yield* currentIsoNow);
      const title = input.title.trim();

      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO meta_projects (
                id, title, description, instructions_md,
                pinned_at, archived_at, created_at, updated_at, deleted_at
              ) VALUES (
                ${input.id}, ${title}, ${input.description ?? null},
                ${input.instructionsMd ?? ""}, null, null, ${now}, ${now}, null
              )
            `;

            for (const [index, member] of (input.members ?? []).entries()) {
              yield* insertMemberRow(input.id, member, index, now);
            }

            for (const link of input.threadLinks ?? []) {
              yield* insertThreadRow(input.id, link, now);
            }
          }),
        )
        .pipe(Effect.mapError((cause) => storageError("create", cause, input.id)));

      return yield* requireExisting(input.id);
    },
  );

  const update: MetaProjectStoreShape["update"] = Effect.fn("MetaProjectStore.update")(
    function* (input) {
      const existing = yield* requireExisting(input.metaProjectId);
      const now = input.now ?? (yield* currentIsoNow);

      const nextTitle = input.title !== undefined ? input.title.trim() : existing.title;
      const nextDescription =
        input.description !== undefined ? input.description : (existing.description ?? null);
      const nextInstructions =
        input.instructionsMd !== undefined ? input.instructionsMd : existing.instructionsMd;
      const nextPinnedAt =
        input.pinned === undefined
          ? (existing.pinnedAt ?? null)
          : input.pinned
            ? (existing.pinnedAt ?? now)
            : null;
      const nextArchivedAt =
        input.archived === undefined
          ? (existing.archivedAt ?? null)
          : input.archived
            ? (existing.archivedAt ?? now)
            : null;

      yield* sql`
        UPDATE meta_projects
        SET
          title = ${nextTitle},
          description = ${nextDescription},
          instructions_md = ${nextInstructions},
          pinned_at = ${nextPinnedAt},
          archived_at = ${nextArchivedAt},
          updated_at = ${now}
        WHERE id = ${input.metaProjectId}
      `.pipe(Effect.mapError((cause) => storageError("update", cause, input.metaProjectId)));

      return yield* requireExisting(input.metaProjectId);
    },
  );

  const remove: MetaProjectStoreShape["delete"] = Effect.fn("MetaProjectStore.delete")(
    function* (metaProjectId, options) {
      const existing = yield* get(metaProjectId);
      if (Option.isNone(existing)) return false;

      const now = options?.now ?? (yield* currentIsoNow);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM meta_project_members WHERE meta_project_id = ${metaProjectId}`;
            yield* sql`DELETE FROM meta_project_threads WHERE meta_project_id = ${metaProjectId}`;
            if (options?.hard) {
              yield* sql`DELETE FROM meta_projects WHERE id = ${metaProjectId}`;
            } else {
              yield* sql`
                UPDATE meta_projects
                SET deleted_at = ${now}, updated_at = ${now}
                WHERE id = ${metaProjectId}
              `;
            }
          }),
        )
        .pipe(Effect.mapError((cause) => storageError("delete", cause, metaProjectId)));

      return true;
    },
  );

  const addMember: MetaProjectStoreShape["addMember"] = Effect.fn("MetaProjectStore.addMember")(
    function* (input) {
      const existing = yield* requireExisting(input.metaProjectId);
      const duplicate = existing.members.some(
        (m) =>
          m.environmentId === input.member.environmentId && m.projectId === input.member.projectId,
      );
      if (duplicate) {
        return yield* new MetaProjectError({
          reason: "duplicate_member",
          message: `Project '${input.member.projectId}' in environment '${input.member.environmentId}' is already a member.`,
          metaProjectId: input.metaProjectId,
        });
      }

      const now = input.now ?? (yield* currentIsoNow);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* insertMemberRow(input.metaProjectId, input.member, existing.members.length, now);
            yield* sql`UPDATE meta_projects SET updated_at = ${now} WHERE id = ${input.metaProjectId}`;
          }),
        )
        .pipe(Effect.mapError((cause) => storageError("addMember", cause, input.metaProjectId)));

      return yield* requireExisting(input.metaProjectId);
    },
  );

  const updateMember: MetaProjectStoreShape["updateMember"] = Effect.fn(
    "MetaProjectStore.updateMember",
  )(function* (input) {
    const existing = yield* requireExisting(input.metaProjectId);
    const currentMember = existing.members.find(
      (m) =>
        m.environmentId === input.member.environmentId && m.projectId === input.member.projectId,
    );
    if (currentMember === undefined) {
      return yield* new MetaProjectError({
        reason: "member_not_found",
        message: `Member '${input.member.projectId}' in environment '${input.member.environmentId}' was not found.`,
        metaProjectId: input.metaProjectId,
      });
    }

    const now = input.now ?? (yield* currentIsoNow);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE meta_project_members
            SET
              role = ${input.member.role},
              label = ${input.member.label ?? null},
              description = ${input.member.description ?? null},
              sort_order = ${input.member.sortOrder ?? currentMember.sortOrder ?? 0}
            WHERE meta_project_id = ${input.metaProjectId}
              AND environment_id = ${input.member.environmentId}
              AND project_id = ${input.member.projectId}
          `;
          yield* sql`UPDATE meta_projects SET updated_at = ${now} WHERE id = ${input.metaProjectId}`;
        }),
      )
      .pipe(Effect.mapError((cause) => storageError("updateMember", cause, input.metaProjectId)));

    return yield* requireExisting(input.metaProjectId);
  });

  const removeMember: MetaProjectStoreShape["removeMember"] = Effect.fn(
    "MetaProjectStore.removeMember",
  )(function* (input) {
    const existing = yield* requireExisting(input.metaProjectId);
    const hasMember = existing.members.some(
      (m) => m.environmentId === input.environmentId && m.projectId === input.projectId,
    );
    if (!hasMember) {
      return { metaProject: existing, removed: false };
    }

    const now = input.now ?? (yield* currentIsoNow);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM meta_project_members
            WHERE meta_project_id = ${input.metaProjectId}
              AND environment_id = ${input.environmentId}
              AND project_id = ${input.projectId}
          `;
          yield* sql`UPDATE meta_projects SET updated_at = ${now} WHERE id = ${input.metaProjectId}`;
        }),
      )
      .pipe(Effect.mapError((cause) => storageError("removeMember", cause, input.metaProjectId)));

    return {
      metaProject: yield* requireExisting(input.metaProjectId),
      removed: true,
    };
  });

  const listMembers: MetaProjectStoreShape["listMembers"] = Effect.fn(
    "MetaProjectStore.listMembers",
  )(function* (metaProjectId) {
    const meta = yield* requireExisting(metaProjectId);
    return meta.members;
  });

  const linkThread: MetaProjectStoreShape["linkThread"] = Effect.fn("MetaProjectStore.linkThread")(
    function* (input) {
      yield* requireExisting(input.metaProjectId);
      const now = input.now ?? (yield* currentIsoNow);

      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO meta_project_threads (
                meta_project_id, environment_id, thread_id, role,
                project_id, title, linked_at
              ) VALUES (
                ${input.metaProjectId}, ${input.threadLink.environmentId}, ${input.threadLink.threadId},
                ${input.threadLink.role}, ${input.threadLink.projectId ?? null},
                ${input.threadLink.title ?? null}, ${input.threadLink.linkedAt ?? now}
              )
              ON CONFLICT (meta_project_id, environment_id, thread_id) DO UPDATE SET
                role = excluded.role,
                project_id = COALESCE(excluded.project_id, meta_project_threads.project_id),
                title = COALESCE(excluded.title, meta_project_threads.title),
                linked_at = excluded.linked_at
            `;
            yield* sql`UPDATE meta_projects SET updated_at = ${now} WHERE id = ${input.metaProjectId}`;
          }),
        )
        .pipe(Effect.mapError((cause) => storageError("linkThread", cause, input.metaProjectId)));

      return yield* requireExisting(input.metaProjectId);
    },
  );

  const unlinkThread: MetaProjectStoreShape["unlinkThread"] = Effect.fn(
    "MetaProjectStore.unlinkThread",
  )(function* (input) {
    const existing = yield* requireExisting(input.metaProjectId);
    const hasLink = existing.threadLinks.some(
      (l) => l.environmentId === input.environmentId && l.threadId === input.threadId,
    );
    if (!hasLink) {
      return { metaProject: existing, unlinked: false };
    }

    const now = input.now ?? (yield* currentIsoNow);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM meta_project_threads
            WHERE meta_project_id = ${input.metaProjectId}
              AND environment_id = ${input.environmentId}
              AND thread_id = ${input.threadId}
          `;
          yield* sql`UPDATE meta_projects SET updated_at = ${now} WHERE id = ${input.metaProjectId}`;
        }),
      )
      .pipe(Effect.mapError((cause) => storageError("unlinkThread", cause, input.metaProjectId)));

    return {
      metaProject: yield* requireExisting(input.metaProjectId),
      unlinked: true,
    };
  });

  const listThreadLinks: MetaProjectStoreShape["listThreadLinks"] = Effect.fn(
    "MetaProjectStore.listThreadLinks",
  )(function* (metaProjectId) {
    const meta = yield* requireExisting(metaProjectId);
    return meta.threadLinks;
  });

  const findByMemberProject: MetaProjectStoreShape["findByMemberProject"] = Effect.fn(
    "MetaProjectStore.findByMemberProject",
  )(function* (input) {
    const all = yield* list({ includeArchived: false, includeDeleted: false });
    return all.filter((mp) =>
      mp.members.some(
        (m) => m.environmentId === input.environmentId && m.projectId === input.projectId,
      ),
    );
  });

  const replaceMembersAndThreads: MetaProjectStoreShape["replaceMembersAndThreads"] = Effect.fn(
    "MetaProjectStore.replaceMembersAndThreads",
  )(function* (input) {
    yield* requireExisting(input.metaProjectId);
    const now = input.now ?? (yield* currentIsoNow);

    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM meta_project_members WHERE meta_project_id = ${input.metaProjectId}`;
          yield* sql`DELETE FROM meta_project_threads WHERE meta_project_id = ${input.metaProjectId}`;

          for (const [index, member] of input.members.entries()) {
            yield* insertMemberRow(input.metaProjectId, member, index, now);
          }

          for (const link of input.threadLinks) {
            yield* insertThreadRow(input.metaProjectId, link, now);
          }

          yield* sql`UPDATE meta_projects SET updated_at = ${now} WHERE id = ${input.metaProjectId}`;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          storageError("replaceMembersAndThreads", cause, input.metaProjectId),
        ),
      );

    return yield* requireExisting(input.metaProjectId);
  });

  return MetaProjectStore.of({
    list,
    get,
    create,
    update,
    delete: remove,
    addMember,
    updateMember,
    removeMember,
    listMembers,
    linkThread,
    unlinkThread,
    listThreadLinks,
    findByMemberProject,
    replaceMembersAndThreads,
  });
});

export const layer = Layer.effect(MetaProjectStore, make);

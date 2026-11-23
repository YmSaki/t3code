import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  isRuntimeModeAbove,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  UnifiedAgentSessionError,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProjectService from "../ProjectService.ts";
import type { ScannedUnifiedThread } from "./ExtendedAgentSessionScanner.ts";

const isThreadNotFound = Schema.is(ProjectionStore.ProjectionStoreThreadNotFoundError);

const IMPORT_EVENT_PREFIX = "unified-session-import:v1";

interface UnifiedImportTarget {
  readonly projectId: ProjectId;
  readonly runtimeMode: RuntimeMode;
}

/** Saves scanned sessions as T3 threads. `UnifiedImportService` fails imports when it is absent. */
export class UnifiedImportThreadPersister extends Context.Service<
  UnifiedImportThreadPersister,
  {
    readonly resolveTarget: (input: {
      readonly projectId?: ProjectId | undefined;
      readonly workspaceRoot: string;
    }) => Effect.Effect<UnifiedImportTarget, UnifiedAgentSessionError>;
    /** The live thread already holding this session, from this importer or the recent-session one. */
    readonly findImportedThreadId: (
      thread: ScannedUnifiedThread,
    ) => Effect.Effect<ThreadId | null, UnifiedAgentSessionError>;
    readonly persistThread: (input: {
      readonly target: UnifiedImportTarget;
      readonly thread: ScannedUnifiedThread;
      readonly handoffSummary: string | null;
    }) => Effect.Effect<ThreadId, UnifiedAgentSessionError>;
  }
>()("t3/project/importers/UnifiedImportThreadPersister") {}

const importFailed = (detail: string) => (cause: unknown) =>
  new UnifiedAgentSessionError({ operation: "import", detail, cause });

function unifiedImportThreadId(
  thread: Pick<ScannedUnifiedThread, "source" | "sessionId">,
  attempt = 1,
): ThreadId {
  const base = `import-unified:${thread.source}:${thread.sessionId}`;
  return ThreadId.make(attempt === 1 ? base : `${base}:${attempt}`);
}

function turnItemBase(threadId: ThreadId, suffix: string, ordinal: number, at: DateTime.Utc) {
  return {
    id: TurnItemId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${threadId}:${suffix}`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
}

// Mirrors AgentSessionImporter's run-less history events so imported threads read the same.
function historyEvents(
  threadId: ThreadId,
  thread: ScannedUnifiedThread,
  handoffSummary: string | null,
  createdAt: DateTime.Utc,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const handoff: ReadonlyArray<OrchestrationV2DomainEvent> =
    handoffSummary === null
      ? []
      : [
          {
            id: EventId.make(`${IMPORT_EVENT_PREFIX}:handoff:${threadId}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: createdAt,
            payload: {
              ...turnItemBase(threadId, "handoff", 0, createdAt),
              type: "system_notice",
              message: handoffSummary,
            },
          },
        ];
  const messages = thread.messages.flatMap((message, index): OrchestrationV2DomainEvent[] => {
    const suffix = String(index).padStart(6, "0");
    const messageId = MessageId.make(`${threadId}:${suffix}`);
    const at = DateTime.makeUnsafe(message.createdAt);
    const base = turnItemBase(threadId, suffix, index + 1, at);
    const turnItem: OrchestrationV2TurnItem =
      message.role === "user"
        ? {
            ...base,
            createdBy: "user",
            creationSource: "server",
            type: "user_message",
            messageId,
            inputIntent: "turn_start",
            text: message.text,
            attachments: [],
          }
        : { ...base, type: "assistant_message", messageId, text: message.text, streaming: false };
    return [
      {
        id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${threadId}:${suffix}`),
        type: "message.updated",
        threadId,
        occurredAt: at,
        payload: {
          createdBy: message.role === "user" ? "user" : "agent",
          creationSource: "server",
          id: messageId,
          threadId,
          runId: null,
          nodeId: null,
          role: message.role,
          text: message.text,
          attachments: [],
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      },
      {
        id: EventId.make(base.id),
        type: "turn-item.updated",
        threadId,
        occurredAt: at,
        payload: turnItem,
      },
    ];
  });
  return [...handoff, ...messages];
}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const projects = yield* ProjectService.ProjectService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const ceiling = settingsService.managedPolicy?.limits?.maxRuntimeMode;

  const findThread = (threadId: ThreadId) =>
    orchestrator.getThreadRecords(threadId, []).pipe(
      Effect.map(({ thread }): OrchestrationV2AppThread | null => thread),
      Effect.catch((error) =>
        isThreadNotFound(error.cause)
          ? Effect.succeed(null)
          : Effect.fail(importFailed(`Could not read thread ${threadId}.`)(error)),
      ),
    );

  const resolveTarget: UnifiedImportThreadPersister["Service"]["resolveTarget"] = Effect.fn(
    "UnifiedImportThreadPersister.resolveTarget",
  )(function* (input) {
    const found = yield* (
      input.projectId === undefined
        ? projects.getByWorkspaceRoot(input.workspaceRoot)
        : projects.getById(input.projectId)
    ).pipe(Effect.mapError(importFailed("Could not read projects.")));
    if (Option.isNone(found)) {
      return yield* new UnifiedAgentSessionError({
        operation: "import",
        detail: `Add ${input.workspaceRoot} as a project before importing its sessions.`,
      });
    }
    const project = found.value;
    if (
      normalizeProjectPathForComparison(project.workspaceRoot) !==
      normalizeProjectPathForComparison(input.workspaceRoot)
    ) {
      return yield* new UnifiedAgentSessionError({
        operation: "import",
        detail: `Project ${project.id} is not rooted at ${input.workspaceRoot}.`,
      });
    }
    // Same rule as AgentSessionImporter: full access unless a policy ceiling caps the project default.
    const runtimeMode =
      ceiling === undefined
        ? DEFAULT_RUNTIME_MODE
        : yield* settingsService.getSettings.pipe(
            Effect.mapError(importFailed("Could not read settings.")),
            Effect.map((settings) => {
              const mode = resolveProjectSettings(settings, project.id, project).settings
                .defaultRuntimeMode;
              return isRuntimeModeAbove(mode, ceiling) ? ceiling : mode;
            }),
          );
    return { projectId: project.id, runtimeMode };
  });

  const findImportedThreadId: UnifiedImportThreadPersister["Service"]["findImportedThreadId"] =
    Effect.fn("UnifiedImportThreadPersister.findImportedThreadId")(function* (thread) {
      const candidates = [unifiedImportThreadId(thread)];
      // The recent-session importer names threads after the default provider instance.
      if (thread.source === "claudeAgent" || thread.source === "codex" || thread.source === "pi") {
        candidates.push(ThreadId.make(`import:${thread.source}:${thread.sessionId}`));
      }
      for (const threadId of candidates) {
        const existing = yield* findThread(threadId);
        if (existing !== null && existing.deletedAt == null) return threadId;
      }
      return null;
    });

  const persistThread: UnifiedImportThreadPersister["Service"]["persistThread"] = Effect.fn(
    "UnifiedImportThreadPersister.persistThread",
  )(function* ({ target, thread, handoffSummary }) {
    // A forced or post-delete re-import takes the next free id: event ids are derived from it.
    let attempt = 1;
    while ((yield* findThread(unifiedImportThreadId(thread, attempt))) !== null) attempt += 1;
    const threadId = unifiedImportThreadId(thread, attempt);

    const driver = ProviderDriverKind.make(thread.source);
    const providerInstanceId = ProviderInstanceId.make(thread.source);
    const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
    const createdAt = DateTime.makeUnsafe(thread.createdAt);
    const updatedAt = DateTime.makeUnsafe(thread.updatedAt);
    const appThread: OrchestrationV2AppThread = {
      createdBy: "system",
      creationSource: "server",
      id: threadId,
      projectId: target.projectId,
      title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model },
      runtimeMode: target.runtimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      linkedPullRequest: null,
      branchPullRequest: null,
      // No native session binding: the next turn starts a fresh provider conversation.
      activeProviderThreadId: null,
      historyOrigin: "v1_import",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt,
      updatedAt,
      archivedAt: null,
      settledOverride: "settled",
      settledAt: updatedAt,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    yield* eventSink
      .write({
        events: [
          {
            id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
            type: "thread.created",
            threadId,
            providerInstanceId,
            occurredAt: createdAt,
            payload: appThread,
          },
          ...historyEvents(threadId, thread, handoffSummary, createdAt),
        ],
      })
      .pipe(Effect.mapError(importFailed(`Could not save imported session ${thread.sessionId}.`)));
    return threadId;
  });

  return UnifiedImportThreadPersister.of({ resolveTarget, findImportedThreadId, persistThread });
});

export const layer = Layer.effect(UnifiedImportThreadPersister, make);

import {
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2TurnItem,
  THREAD_HANDOFF_DEFAULT_MAX_BYTES,
  ThreadHandoffError,
  type ThreadHandoffInput,
  type ThreadHandoffResult,
  ThreadHandoffSourceNotFoundError,
} from "@t3tools/contracts";
import {
  buildThreadHandoffContext,
  type ThreadHandoffEntry,
} from "@t3tools/shared/threadHandoff.core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

interface ThreadHandoffServiceInput extends ThreadHandoffInput {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export class ThreadHandoffService extends Context.Service<
  ThreadHandoffService,
  {
    /** Starts a new thread on another model whose first message is the source thread's transcript. */
    readonly handoff: (
      input: ThreadHandoffServiceInput,
    ) => Effect.Effect<ThreadHandoffResult, ThreadHandoffSourceNotFoundError | ThreadHandoffError>;
  }
>()("t3/orchestration-v2/ThreadHandoffService") {}

function handoffEntry(item: OrchestrationV2TurnItem): ReadonlyArray<ThreadHandoffEntry> {
  switch (item.type) {
    case "user_message":
    case "assistant_message": {
      const context = item.type === "user_message" ? item.context : undefined;
      const text = [
        item.text,
        ...(context === undefined
          ? []
          : [`[Message context]\n${JSON.stringify(context, null, 2)}`]),
        ...(item.attachments ?? []).map(
          (attachment) =>
            `[Attachment: ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes, id: ${attachment.id})]`,
        ),
      ].join("\n\n");
      return [{ kind: item.type === "user_message" ? "user" : "assistant", text }];
    }
    case "proposed_plan":
      return [{ kind: "assistant", text: `Proposed plan:\n${item.markdown}` }];
    case "command_execution":
      return [{ kind: "tool", label: item.input, output: item.output, exitCode: item.exitCode }];
    case "file_change":
      return [
        {
          kind: "tool",
          label: `edit ${item.fileName} (+${item.additions ?? 0} -${item.deletions ?? 0})`,
        },
      ];
    case "error":
      return [{ kind: "error", message: item.failure.message }];
    default:
      return [];
  }
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;

  const handoff = Effect.fn("ThreadHandoffService.handoff")(function* (
    input: ThreadHandoffServiceInput,
  ) {
    const sourceThreadId = input.threadId;
    const readError = (cause: { readonly _tag: string; readonly message: string }) =>
      new ThreadHandoffError({
        sourceThreadId,
        operation: "read-source",
        detail:
          cause._tag === "ThreadTranscriptTooLargeError"
            ? cause.message
            : "Could not read the source thread.",
        cause,
      });
    const thread = yield* threads.getThreadShell(sourceThreadId).pipe(Effect.mapError(readError));
    if (thread === null) {
      return yield* new ThreadHandoffSourceNotFoundError({ threadId: sourceThreadId });
    }
    // The transcript read hydrates imported history, refuses oversized threads and limits concurrent exports.
    const transcript = yield* threads
      .getThreadTranscript(sourceThreadId)
      .pipe(
        Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, environment),
        Effect.mapError(readError),
      );
    const workspaceRoot =
      thread.worktreePath ??
      Option.match(yield* projects.getById(thread.projectId).pipe(Effect.mapError(readError)), {
        onNone: () => null,
        onSome: (project) => project.workspaceRoot,
      });
    const items = transcript.items.map(({ item }) => item);
    const mode = input.mode ?? "raw";
    const maxBytes = input.maxBytes ?? THREAD_HANDOFF_DEFAULT_MAX_BYTES;
    const context = buildThreadHandoffContext({
      source: {
        threadId: thread.id,
        title: thread.title,
        model: `${thread.modelSelection.instanceId} / ${thread.modelSelection.model}`,
        branch: thread.branch,
        workspaceRoot,
        changedFiles: [
          ...new Set(items.flatMap((item) => (item.type === "file_change" ? [item.fileName] : []))),
        ],
      },
      entries: items.flatMap(handoffEntry),
      mode,
      maxBytes,
    });
    if (context.turnCount === 0) {
      return yield* new ThreadHandoffError({
        sourceThreadId,
        operation: "build-context",
        detail: "The source thread has no messages to hand off.",
      });
    }
    if (context.overBudget) {
      return yield* new ThreadHandoffError({
        sourceThreadId,
        operation: "build-context",
        detail: `The newest turn alone needs ${context.bytes} bytes, over the ${maxBytes}-byte budget. Use compact mode or a larger budget.`,
      });
    }
    const launched = yield* threadLaunch
      .launch({
        commandId: input.commandId,
        projectId: thread.projectId,
        title: `${thread.title} (handoff)`,
        titleRenamed: true,
        modelSelection: input.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        workspaceStrategy:
          thread.worktreePath === null
            ? { type: "root" }
            : {
                type: "existing_worktree",
                worktreePath: thread.worktreePath,
                branch: thread.branch ?? undefined,
              },
        initialMessage: { text: context.text, attachments: [] },
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadHandoffError({
              sourceThreadId,
              operation: "launch",
              detail: cause.message,
              cause,
            }),
        ),
      );
    return {
      sourceThreadId,
      threadId: launched.threadId,
      mode,
      bytes: context.bytes,
      turnCount: context.turnCount,
      omittedTurnCount: context.omittedTurnCount,
      truncatedToolOutputCount: context.truncatedToolOutputCount,
    };
  });

  return ThreadHandoffService.of({ handoff });
});

export const layer = Layer.effect(ThreadHandoffService, make);

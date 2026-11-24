import * as Schema from "effect/Schema";

import { CommandId, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2CreationSource } from "./orchestrationV2.ts";

/** Matches the in-thread context handoff byte cap. */
export const THREAD_HANDOFF_DEFAULT_MAX_BYTES = 64_000;

export const ThreadHandoffMode = Schema.Literals(["raw", "compact"]).annotate({
  description:
    "raw keeps truncated tool output; compact drops tool output. Messages are verbatim in both, never summarized.",
});
export type ThreadHandoffMode = typeof ThreadHandoffMode.Type;

export const ThreadHandoffInput = Schema.Struct({
  commandId: CommandId,
  creationSource: Schema.optional(OrchestrationV2CreationSource),
  threadId: ThreadId,
  modelSelection: ModelSelection,
  mode: Schema.optional(ThreadHandoffMode),
  // UTF-8 bytes never undercount UTF-16 units, so this also keeps the first message under the send cap.
  maxBytes: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)).annotate({
      description:
        "Oldest turns are dropped to fit. The handoff is refused when the newest turn alone does not fit.",
    }),
  ),
});
export type ThreadHandoffInput = typeof ThreadHandoffInput.Type;

export const ThreadHandoffResult = Schema.Struct({
  sourceThreadId: ThreadId,
  threadId: ThreadId,
  mode: ThreadHandoffMode,
  bytes: NonNegativeInt,
  turnCount: NonNegativeInt,
  omittedTurnCount: NonNegativeInt,
  truncatedToolOutputCount: NonNegativeInt,
});
export type ThreadHandoffResult = typeof ThreadHandoffResult.Type;

export class ThreadHandoffSourceNotFoundError extends Schema.TaggedError<ThreadHandoffSourceNotFoundError>()(
  "ThreadHandoffSourceNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found, so it cannot be handed off.`;
  }
}

export class ThreadHandoffError extends Schema.TaggedError<ThreadHandoffError>()(
  "ThreadHandoffError",
  {
    sourceThreadId: ThreadId,
    operation: Schema.Literals(["read-source", "build-context", "launch"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Handing off thread ${this.sourceThreadId} failed during ${this.operation}: ${this.detail}`;
  }
}

import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { WebPushEventInput } from "./WebPushService.ts";
import * as WebPushService from "./WebPushService.ts";

/** Enough to absorb repeats of one request or run without growing for the server's lifetime. */
const SEEN_LIMIT = 1024;
const STREAM_RETRY_DELAY = Duration.seconds(5);

/**
 * The push a domain event stands for, or null. Pending approvals and questions
 * ask for the user; a failed run tells them work stopped.
 */
export function toPushCandidate(event: OrchestrationV2DomainEvent): WebPushEventInput | null {
  const occurredAt = DateTime.toEpochMillis(event.occurredAt);
  switch (event.type) {
    case "runtime-request.updated": {
      const request = event.payload;
      if (request.status !== "pending") return null;
      if (request.kind === "dynamic_tool_call" || request.kind === "auth_refresh") return null;
      return {
        kind: request.kind === "user_input" ? "question_requested" : "approval_requested",
        occurredAt,
        threadId: event.threadId,
        runId: event.runId ?? null,
        requestId: request.id,
        ...(request.kind === "user_input" ? {} : { commandOrToolName: request.kind }),
        ...(event.driver === undefined ? {} : { provider: event.driver }),
      };
    }
    case "run.updated":
      return event.payload.status === "failed"
        ? {
            kind: "run_failed",
            occurredAt,
            threadId: event.threadId,
            runId: event.payload.id,
            ...(event.driver === undefined ? {} : { provider: event.driver }),
          }
        : null;
    default:
      return null;
  }
}

/** Sends a push for every attention-worthy domain event; runs as long as the event stream does. */
export const runWebPushNotifications = Effect.fn("WebPushRuntimeWiring.run")(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const push = yield* WebPushService.WebPushService;
  // The policy only debounces within its window; a run updated again after failing must not re-notify.
  const seen = new Set<string>();

  // Untraced: it runs for every domain event, and the stream run already carries the span.
  const handle = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    const candidate = toPushCandidate(event);
    if (candidate === null) return;
    const key = `${candidate.kind}:${candidate.requestId ?? candidate.runId ?? event.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
    const threadTitle = yield* orchestrator.getThreadTitles([event.threadId]).pipe(
      Effect.map((titles) => titles[event.threadId]),
      Effect.orElseSucceed(() => undefined),
    );
    yield* push
      .notifyEvent(threadTitle === undefined ? candidate : { ...candidate, threadTitle })
      .pipe(
        Effect.catchTags({
          WebPushError: (error) =>
            Effect.logWarning("sending a web push failed", { threadId: event.threadId, error }),
        }),
      );
  });

  // Resubscribe after a stream failure; otherwise one error silences pushes until restart.
  yield* Stream.runForEach(orchestrator.streamDomainEvents, handle).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("web push domain event stream failed; resubscribing", { error }),
    ),
    Effect.retry(Schedule.spaced(STREAM_RETRY_DELAY)),
  );
});

/** Mount point for the server: pushes until the enclosing scope closes. */
export const startWebPushNotifications = () => Effect.forkScoped(runWebPushNotifications());

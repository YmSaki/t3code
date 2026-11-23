import { expect, it } from "@effect/vitest";
import { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as WebPushRuntimeWiring from "./WebPushRuntimeWiring.ts";
import * as WebPushService from "./WebPushService.ts";

const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);

const OCCURRED_AT = "2026-11-22T14:00:00.000Z";
const at = DateTime.makeUnsafe(OCCURRED_AT);
const base = { threadId: "thread-1", runId: "run-1", driver: "codex", occurredAt: at };

const runUpdated = (id: string, status: string) =>
  decodeEvent({
    ...base,
    id,
    type: "run.updated",
    payload: {
      id: "run-1",
      threadId: "thread-1",
      ordinal: 1,
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      providerThreadId: null,
      userMessageId: "message-1",
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: at,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });

const requestUpdated = (id: string, kind: string, status: string) =>
  decodeEvent({
    ...base,
    id,
    type: "runtime-request.updated",
    payload: {
      id: `request-${kind}`,
      nodeId: "node-1",
      providerTurnId: null,
      nativeRequestRef: null,
      kind,
      status,
      responseCapability: { type: "message" },
      createdAt: at,
      resolvedAt: null,
    },
  });

it("maps attention-worthy domain events to push candidates", () => {
  const occurredAt = DateTime.toEpochMillis(at);
  const cases = [
    {
      event: requestUpdated("e1", "command", "pending"),
      expected: {
        kind: "approval_requested",
        occurredAt,
        threadId: "thread-1",
        runId: "run-1",
        requestId: "request-command",
        commandOrToolName: "command",
        provider: "codex",
      },
    },
    {
      event: requestUpdated("e2", "user_input", "pending"),
      expected: {
        kind: "question_requested",
        occurredAt,
        threadId: "thread-1",
        runId: "run-1",
        requestId: "request-user_input",
        provider: "codex",
      },
    },
    { event: requestUpdated("e3", "command", "resolved"), expected: null },
    { event: requestUpdated("e4", "auth_refresh", "pending"), expected: null },
    {
      event: runUpdated("e5", "failed"),
      expected: {
        kind: "run_failed",
        occurredAt,
        threadId: "thread-1",
        runId: "run-1",
        provider: "codex",
      },
    },
    { event: runUpdated("e6", "completed"), expected: null },
  ];
  for (const { event, expected } of cases) {
    expect(WebPushRuntimeWiring.toPushCandidate(event)).toEqual(expected);
  }
});

it.effect("notifies once per request or run, with the thread title", () =>
  Effect.gen(function* () {
    const sent: Array<WebPushService.WebPushEventInput> = [];
    const layer = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.fromIterable([
          requestUpdated("e1", "command", "pending"),
          runUpdated("e2", "running"),
          runUpdated("e3", "failed"),
          runUpdated("e4", "failed"),
          requestUpdated("e5", "command", "pending"),
        ]),
        getThreadTitles: (threadIds) =>
          Effect.succeed(Object.fromEntries(threadIds.map((id) => [id, "Refactor auth"]))),
      }),
      Layer.mock(WebPushService.WebPushService)({
        notifyEvent: (event) =>
          Effect.sync(() => {
            sent.push(event);
            return {
              decision: {
                shouldSend: false,
                reason: "disabled_globally",
                dedupeKey: "-",
                title: "",
                body: "",
                priority: "normal",
              },
              deliveredCount: 0,
              failedCount: 0,
              prunedSubscriptionIds: [],
            } as const;
          }),
      }),
    );

    yield* WebPushRuntimeWiring.runWebPushNotifications().pipe(Effect.provide(layer));

    expect(sent.map((event) => [event.kind, event.threadTitle])).toEqual([
      ["approval_requested", "Refactor auth"],
      ["run_failed", "Refactor auth"],
    ]);
  }),
);

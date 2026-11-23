import { expect, it } from "@effect/vitest";
import {
  type Artifact,
  ArtifactId,
  type ArtifactUserAction,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeArtifactTurnStarter } from "./ArtifactRuntimeWiring.ts";

const artifact = {
  id: ArtifactId.make("art-1"),
  projectId: ProjectId.make("project:default"),
  threadId: ThreadId.make("thread-1"),
} as Artifact;
// WebSocket-created artifacts carry a placeholder project; the send must use the thread's.
const threadProjectId = ProjectId.make("proj-thread");
const action: ArtifactUserAction = { actionName: "approve", payload: {}, promptText: "Go" };

it.effect("counts only a send that began a turn as started", () =>
  Effect.gen(function* () {
    const sends: Array<ThreadManagement.ThreadManagementSendInput> = [];
    const deliveries: Array<ThreadManagement.ThreadManagementSendResult["delivery"]> = [
      "started",
      "restarted",
      "steered",
      "queued",
    ];
    const start = makeArtifactTurnStarter({
      getThreadShell: () =>
        Effect.succeed({ projectId: threadProjectId } as OrchestrationV2ThreadShell),
      sendToThread: (input) =>
        Effect.sync(() => {
          sends.push(input);
          return {
            delivery: deliveries[sends.length - 1],
          } as ThreadManagement.ThreadManagementSendResult;
        }),
    });

    const started: Array<boolean> = [];
    for (const _ of deliveries) {
      started.push((yield* start({ artifact, action, prompt: "PROMPT" })).started);
    }
    expect(started).toEqual([true, true, false, false]);
    expect(sends[0]).toMatchObject({
      projectId: threadProjectId,
      threadId: artifact.threadId,
      text: "PROMPT",
      mode: "auto",
    });
    expect(new Set(sends.map((send) => send.commandId)).size).toBe(sends.length);
  }),
);

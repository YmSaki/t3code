import { CommandId, MessageId } from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ArtifactService from "./ArtifactService.ts";

/** Steered and queued sends reach the agent later or inside another turn, so they did not start one. */
const STARTED_DELIVERIES: ReadonlySet<ThreadManagement.ThreadManagementSendResult["delivery"]> =
  new Set(["started", "restarted"]);

export const makeArtifactTurnStarter =
  (
    threads: Pick<ThreadManagement.ThreadManagementServiceShape, "sendToThread" | "getThreadShell">,
  ): ArtifactService.ArtifactTurnStarter =>
  ({ artifact, prompt }) =>
    Effect.gen(function* () {
      const toStartError = (cause: unknown) =>
        new ArtifactService.ArtifactTurnStartError({ artifactId: artifact.id, cause });
      // Artifacts created over WebSocket carry a placeholder project, so the thread names the real one.
      const shell = yield* threads
        .getThreadShell(artifact.threadId)
        .pipe(Effect.mapError(toStartError));
      if (shell === null) {
        return yield* toStartError(`Thread ${artifact.threadId} was not found.`);
      }
      const uuid = yield* randomUuidV4;
      const sent = yield* threads
        .sendToThread({
          projectId: shell.projectId,
          commandId: CommandId.make(`command:artifact-action:${uuid}`),
          threadId: artifact.threadId,
          messageId: MessageId.make(`message:artifact-action:${uuid}`),
          text: prompt,
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.mapError(toStartError));
      return { started: STARTED_DELIVERIES.has(sent.delivery) };
    });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return ArtifactService.makeLayer({ turnStarter: makeArtifactTurnStarter(threads) });
  }),
);

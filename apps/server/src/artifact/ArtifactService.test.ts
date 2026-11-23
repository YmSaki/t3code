import { expect, it } from "@effect/vitest";
import {
  ARTIFACT_STATE_MAX_BYTES,
  ArtifactId,
  ArtifactInvalidStateError,
  ArtifactStateConflictError,
  ArtifactStateTooLargeError,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  buildArtifactBridgeSendActionRequest,
  buildArtifactRelayEnvelope,
} from "@t3tools/shared/artifactBridge.core";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import migration108 from "../persistence/Migrations/108_Artifacts.ts";
import * as ArtifactService from "./ArtifactService.ts";
import * as ArtifactStore from "./ArtifactStore.ts";

const environmentId = EnvironmentId.make("env-service");
const projectId = ProjectId.make("project-service");
const threadId = ThreadId.make("thread-service");

const testLayer = it.layer(
  ArtifactService.layer.pipe(
    Layer.provideMerge(ArtifactStore.layer),
    Layer.provideMerge(
      Layer.effectDiscard(migration108).pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  ),
);

testLayer("ArtifactService", (it) => {
  it.effect(
    "patches state within the 16KB budget, enforces optimistic concurrency, and formats state envelopes",
    () =>
      Effect.gen(function* () {
        const service = yield* ArtifactService.ArtifactService;

        const created = yield* service.create({
          id: ArtifactId.make("art-state"),
          environmentId,
          projectId,
          threadId,
          kind: "html",
          title: "Metrics Dashboard",
          content: "<!doctype html><html><head></head><body><h1>Metrics</h1></body></html>",
          initialState: { period: "24h", keep: true },
        });

        const patched1 = yield* service.patchState({
          artifactId: created.artifact.id,
          patch: { period: "7d", keep: null, added: [1, 2, 3] },
          expectedVersion: 0,
        });
        expect(patched1.artifact.stateVersion).toBe(1);
        expect(patched1.artifact.state).toEqual({ period: "7d", added: [1, 2, 3] });

        const conflict = yield* service
          .patchState({
            artifactId: created.artifact.id,
            patch: { period: "30d" },
            expectedVersion: 0,
          })
          .pipe(Effect.flip);
        expect(conflict).toBeInstanceOf(ArtifactStateConflictError);

        const oversized = yield* service
          .patchState({
            artifactId: created.artifact.id,
            patch: { huge: "x".repeat(ARTIFACT_STATE_MAX_BYTES) },
            expectedVersion: 1,
          })
          .pipe(Effect.flip);
        expect(oversized).toBeInstanceOf(ArtifactStateTooLargeError);

        const polluted = yield* service
          .patchState({
            artifactId: created.artifact.id,
            patch: JSON.parse('{"__proto__": {"polluted": true}}'),
            expectedVersion: 1,
          })
          .pipe(Effect.flip);
        expect(polluted).toBeInstanceOf(ArtifactInvalidStateError);

        const envelopes = yield* service.formatThreadStateEnvelopes(threadId);
        expect(envelopes).toContain('<t3_artifact_state artifact_id="art-state"');
        expect(envelopes).toContain('"period":"7d"');
      }),
  );

  it.effect(
    "verifies bridge messages on submitUserAction and exports standalone sandboxed HTML",
    () =>
      Effect.gen(function* () {
        const service = yield* ArtifactService.ArtifactService;
        const id = ArtifactId.make("art-bridge");

        yield* service.create({
          id,
          environmentId,
          projectId,
          threadId,
          kind: "html",
          title: "Approval Widget",
          content:
            "<html><head><title>Widget</title></head><body><button>Go</button></body></html>",
          initialState: { selectedId: 42 },
        });

        const actionRequest = buildArtifactBridgeSendActionRequest("req-1", {
          actionName: "approve_item",
          payload: { itemId: 42 },
          promptText: "Proceed with item 42",
        });

        const badSecret = yield* service
          .submitUserAction({
            artifactId: id,
            bridgeMessage: buildArtifactRelayEnvelope("wrong-secret", true, actionRequest),
            securityContext: { expectedSecret: "correct-secret" },
          })
          .pipe(Effect.flip);
        expect(badSecret).toBeInstanceOf(ArtifactInvalidStateError);
        expect(badSecret.message).toContain("invalid_secret");

        const inactive = yield* service
          .submitUserAction({
            artifactId: id,
            bridgeMessage: buildArtifactRelayEnvelope("correct-secret", false, actionRequest),
            securityContext: { expectedSecret: "correct-secret" },
          })
          .pipe(Effect.flip);
        expect(inactive).toBeInstanceOf(ArtifactInvalidStateError);
        expect(inactive.message).toContain("user_activation_required");

        const accepted = yield* service.submitUserAction({
          artifactId: id,
          bridgeMessage: buildArtifactRelayEnvelope("correct-secret", true, actionRequest),
          securityContext: { expectedSecret: "correct-secret", frameFocused: true },
        });
        expect(accepted.accepted).toBe(true);
        expect(accepted.startedTurn).toBe(true);
        expect(accepted.prompt).toContain("approve_item");
        expect(accepted.prompt).toContain("<t3_artifact_state");

        const exported = yield* service.exportStandalone({
          artifactId: id,
          secret: "correct-secret",
        });
        expect(exported.fileName).toBe("Approval Widget.html");
        expect(exported.mimeType).toBe("text/html; charset=utf-8");
        expect(exported.csp).toContain("default-src 'none'");
        expect(exported.csp).toContain("connect-src 'none'");
        expect(exported.headers["Content-Security-Policy"]).toBe(exported.csp);
        expect(exported.headers["X-Content-Type-Options"]).toBe("nosniff");
        expect(exported.content).toContain("t3Artifact");
        expect(exported.content).toContain('"selectedId":42');
      }),
  );

  it.effect("toggles markdown checkboxes, builds revision prompts, and diffs versions", () =>
    Effect.gen(function* () {
      const service = yield* ArtifactService.ArtifactService;
      const id = ArtifactId.make("art-md");

      yield* service.create({
        id,
        environmentId,
        projectId,
        threadId,
        kind: "markdown",
        title: "Design Doc",
        content: "# Tasks\n- [ ] Write core\n- [ ] Write shell\n",
      });

      const toggled = yield* service.toggleMarkdownCheckbox({
        artifactId: id,
        index: 0,
      });
      expect(toggled.version.version).toBe(2);
      expect(toggled.version.content).toContain("- [x] Write core");

      const diff = yield* service.diffVersions({
        artifactId: id,
        fromVersion: 1,
        toVersion: 2,
      });
      expect(diff).toContain("--- v1");
      expect(diff).toContain("+++ v2");
      expect(diff).toContain("-- [ ] Write core");
      expect(diff).toContain("+- [x] Write core");

      const prompt = yield* service.buildRevisionPrompt({
        artifactId: id,
        comments: [{ startLine: 3, endLine: 3, comment: "Split into store and service" }],
      });
      expect(prompt).toContain("Split into store and service");
    }),
  );
});

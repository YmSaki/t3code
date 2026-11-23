import { expect, it } from "@effect/vitest";
import {
  ARTIFACT_STATE_MAX_BYTES,
  ArtifactInvalidStateError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  buildArtifactBridgeSendActionRequest,
  buildArtifactBridgeSendMessageRequest,
  buildArtifactRelayEnvelope,
} from "@t3tools/shared/artifactBridge.core";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

import * as ArtifactService from "../../../artifact/ArtifactService.ts";
import * as ArtifactStore from "../../../artifact/ArtifactStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import migration108 from "../../../persistence/Migrations/108_Artifacts.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ArtifactHandlers from "./handlers.ts";
import { ArtifactToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:artifact-test");
const threadId = ThreadId.make("thread:artifact-test");

const baseStorageLayer = ArtifactService.layer.pipe(
  Layer.provideMerge(ArtifactStore.layer),
  Layer.provideMerge(
    Layer.effectDiscard(migration108).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
);

const threadManagementLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (requestedThreadId) => Effect.succeed(liveThreadShell(requestedThreadId)),
});

const makeContextLayer = (options?: { readonly readOnlyClient?: boolean }) =>
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId,
    requestNamespace: "provider:artifact",
    thread: {
      threadId,
      providerSessionId: "provider:artifact",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client:
      options?.readOnlyClient === true
        ? {
            sessionId: "client-ro",
            label: "Read-only test client",
            access: "read-only" as const,
          }
        : undefined,
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  });

it("exports concise provider-compatible object schemas for all artifact tools", () => {
  for (const tool of Object.values(ArtifactToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect((tool.description ?? "").length).toBeLessThanOrEqual(120);
  }
});

it.effect(
  "runs artifact_create, artifact_revise, artifact_get, artifact_patch_state, and artifact_list end-to-end",
  () =>
    Effect.gen(function* () {
      const runtimeLayer = McpToolAccess.HandlersLayer.layer(ArtifactHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(baseStorageLayer, threadManagementLayer, makeContextLayer()),
        ),
      );

      yield* Effect.gen(function* () {
        const toolkit = yield* ArtifactToolkit;
        const call = <Name extends keyof typeof ArtifactToolkit.tools>(
          name: Name,
          params: Parameters<typeof toolkit.handle<Name>>[1],
        ) =>
          toolkit.handle(name, params).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((parts) => parts.at(-1)?.result),
          );

        const created = yield* call("artifact_create", {
          kind: "html",
          title: "Interactive Counter",
          content: "<!doctype html><html><body><div id='app'>0</div></body></html>",
          initialState: { count: 0 },
        });
        expect(created).toMatchObject({
          artifact: {
            threadId,
            kind: "html",
            title: "Interactive Counter",
            currentVersion: 1,
            stateVersion: 0,
            state: { count: 0 },
          },
          version: {
            version: 1,
            author: "agent",
          },
        });
        if (!created || typeof created !== "object" || !("artifact" in created)) return;

        const artifactId = created.artifact.id;

        const patched = yield* call("artifact_patch_state", {
          artifactId,
          patch: { count: 5, extra: "ok" },
          expectedVersion: 0,
        });
        expect(patched).toMatchObject({
          artifact: {
            id: artifactId,
            stateVersion: 1,
            state: { count: 5, extra: "ok" },
          },
        });

        const conflict = yield* call("artifact_patch_state", {
          artifactId,
          patch: { count: 6 },
          expectedVersion: 0,
        });
        expect(conflict).toMatchObject({
          code: "invalid_request",
        });

        const revised = yield* call("artifact_revise", {
          artifactId,
          content: "<!doctype html><html><body><div id='app'>v2</div></body></html>",
          summary: "Updated layout",
        });
        expect(revised).toMatchObject({
          artifact: {
            id: artifactId,
            currentVersion: 2,
          },
          version: {
            version: 2,
            summary: "Updated layout",
          },
        });

        const fetchedV1 = yield* call("artifact_get", {
          artifactId,
          version: 1,
        });
        expect(fetchedV1).toMatchObject({
          version: {
            version: 1,
            content: "<!doctype html><html><body><div id='app'>0</div></body></html>",
          },
        });

        const listed = yield* call("artifact_list", {});
        expect(listed).toMatchObject({
          artifacts: [{ id: artifactId, currentVersion: 2, stateVersion: 1 }],
        });
      }).pipe(Effect.provide(runtimeLayer));
    }),
);

it.effect(
  "enforces sandbox CSP headers and rejects malformed bridge messages, oversized state patches, and read-only MCP callers (WBS 4.2.4)",
  () =>
    Effect.gen(function* () {
      const readOnlyLayer = McpToolAccess.HandlersLayer.layer(ArtifactHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            baseStorageLayer,
            threadManagementLayer,
            makeContextLayer({ readOnlyClient: true }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const toolkit = yield* ArtifactToolkit;
        const service = yield* ArtifactService.ArtifactService;
        const call = <Name extends keyof typeof ArtifactToolkit.tools>(
          name: Name,
          params: Parameters<typeof toolkit.handle<Name>>[1],
        ) =>
          toolkit.handle(name, params).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((parts) => parts.at(-1)?.result),
          );

        const created = yield* service.create({
          environmentId,
          threadId,
          kind: "html",
          title: "Security Sandbox Target",
          content: "<html><head></head><body><button>Act</button></body></html>",
          initialState: { ready: true },
        });
        const artifactId = created.artifact.id;

        const createDenied = yield* call("artifact_create", {
          kind: "markdown",
          title: "Blocked",
          content: "# Blocked",
        });
        expect(createDenied).toMatchObject({
          code: "capability_denied",
        });

        const reviseDenied = yield* call("artifact_revise", {
          artifactId,
          content: "<html><body>Tampered</body></html>",
        });
        expect(reviseDenied).toMatchObject({
          code: "capability_denied",
        });

        const patchDenied = yield* call("artifact_patch_state", {
          artifactId,
          patch: { ready: false },
        });
        expect(patchDenied).toMatchObject({
          code: "capability_denied",
        });

        const readAllowed = yield* call("artifact_get", { artifactId });
        expect(readAllowed).toMatchObject({
          artifact: { id: artifactId, title: "Security Sandbox Target" },
        });

        const exported = yield* service.exportStandalone({
          artifactId,
          secret: "bridge-secret-xyz",
        });
        expect(exported.headers["Content-Security-Policy"]).toContain("default-src 'none'");
        expect(exported.headers["Content-Security-Policy"]).toContain("connect-src 'none'");
        expect(exported.headers["Content-Security-Policy"]).toContain("frame-src 'none'");
        expect(exported.headers["Content-Security-Policy"]).toContain("worker-src 'none'");
        expect(exported.headers["Content-Security-Policy"]).toContain("object-src 'none'");
        expect(exported.headers["Content-Security-Policy"]).toContain("form-action 'none'");
        expect(exported.headers["Content-Security-Policy"]).not.toMatch(/https?:|wss?:/i);

        const oversizedPatch = yield* service
          .patchState({
            artifactId,
            patch: { payload: "z".repeat(ARTIFACT_STATE_MAX_BYTES) },
          })
          .pipe(Effect.flip);
        expect(oversizedPatch._tag).toBe("ArtifactStateTooLargeError");

        const wrongSecretAction = yield* service
          .submitUserAction({
            artifactId,
            bridgeMessage: buildArtifactRelayEnvelope(
              "forged-secret",
              true,
              buildArtifactBridgeSendActionRequest("1", { actionName: "delete_all" }),
            ),
            securityContext: { expectedSecret: "bridge-secret-xyz" },
          })
          .pipe(Effect.flip);
        expect(wrongSecretAction).toBeInstanceOf(ArtifactInvalidStateError);
        expect(wrongSecretAction.message).toContain("invalid_secret");

        const noActivationMessage = yield* service
          .submitUserAction({
            artifactId,
            bridgeMessage: buildArtifactRelayEnvelope(
              "bridge-secret-xyz",
              false,
              buildArtifactBridgeSendMessageRequest("2", "Spoofed prompt without click"),
            ),
            securityContext: { expectedSecret: "bridge-secret-xyz" },
          })
          .pipe(Effect.flip);
        expect(noActivationMessage).toBeInstanceOf(ArtifactInvalidStateError);
        expect(noActivationMessage.message).toContain("user_activation_required");

        const malformedBridgeJson = yield* service
          .submitUserAction({
            artifactId,
            bridgeMessage: "{broken-json",
            securityContext: { expectedSecret: "bridge-secret-xyz" },
          })
          .pipe(Effect.flip);
        expect(malformedBridgeJson).toBeInstanceOf(ArtifactInvalidStateError);
        expect(malformedBridgeJson.message).toContain("parse_error");
      }).pipe(Effect.provide(readOnlyLayer));
    }),
);

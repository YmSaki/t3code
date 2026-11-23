import {
  buildArtifactBridgeSendActionRequest,
  buildArtifactBridgeSetStateRequest,
  verifyArtifactBridgeMessage,
} from "@t3tools/shared/artifactBridge.core";
import { describe, expect, it } from "vite-plus/test";

import { artifactFrameUrl } from "./artifactBridge.logic";

const artifact = {
  id: "artifact-1",
  environmentId: "env-1",
  projectId: "project-1",
  threadId: "thread-1",
  kind: "html",
  title: "Board",
  currentVersion: 1,
  stateVersion: 3,
  state: { count: 1 },
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
  archivedAt: null,
} as unknown as Parameters<typeof artifactFrameUrl>[0];

// What the outer relay posts to React Native for a message the frame sent.
const relayed = (secret: string, active: boolean, message: unknown) =>
  JSON.stringify({ secret, active, message });

describe("artifact bridge relay", () => {
  it("injects the bootstrap without a frame-held secret", () => {
    const html = decodeURIComponent(
      artifactFrameUrl(artifact, "<p>hi</p>").slice("data:text/html;charset=utf-8,".length),
    );
    expect(html).toContain("secret=null");
    expect(html).toContain("stateVersion=3");
  });

  it("accepts relayed requests and rejects a wrong secret or an inactive action", () => {
    const setState = buildArtifactBridgeSetStateRequest("1", { count: 2 }, 3);
    expect(
      verifyArtifactBridgeMessage(relayed("s", false, setState), { expectedSecret: "s" }),
    ).toMatchObject({ ok: true, request: { kind: "setState", expectedVersion: 3 } });
    expect(
      verifyArtifactBridgeMessage(relayed("other", true, setState), { expectedSecret: "s" }),
    ).toMatchObject({ ok: false, reason: "invalid_secret" });
    const action = buildArtifactBridgeSendActionRequest("2", { actionName: "approve" });
    expect(
      verifyArtifactBridgeMessage(relayed("s", false, action), { expectedSecret: "s" }),
    ).toMatchObject({ ok: false, reason: "user_activation_required", id: "2" });
  });

  it("refuses a message the frame wrapped with its own secret", () => {
    const setState = buildArtifactBridgeSetStateRequest("1", { count: 2 });
    const frameEnvelope = { secret: "s", active: true, message: setState };
    expect(
      verifyArtifactBridgeMessage(relayed("s", true, frameEnvelope), { expectedSecret: "s" }).ok,
    ).toBe(false);
  });
});

import type { Artifact } from "@t3tools/contracts";
import {
  buildArtifactBridgeUpdateNotification,
  buildArtifactOuterDocument,
  injectArtifactBootstrap,
} from "@t3tools/shared/artifactBridge.core";

const DATA_URL_PREFIX = "data:text/html;charset=utf-8,";

/**
 * The sandboxed frame's document. The secret stays out of it: the outer relay attaches the secret
 * and attests activation, and a frame-held secret would be wrapped a second time by that relay.
 */
export function artifactFrameUrl(artifact: Artifact, content: string): string {
  return `${DATA_URL_PREFIX}${encodeURIComponent(
    injectArtifactBootstrap(content, {
      artifactId: artifact.id,
      initialState: artifact.state,
      initialStateVersion: artifact.stateVersion,
    }),
  )}`;
}

export function artifactOuterHtml(frameUrl: string, secret: string): string {
  return buildArtifactOuterDocument({ src: frameUrl, secret });
}

export function artifactReceiveScript(message: unknown): string {
  return `window.__t3ArtifactReceive&&window.__t3ArtifactReceive(${JSON.stringify(message)});true;`;
}

export function artifactStateUpdate(artifact: Artifact) {
  return buildArtifactBridgeUpdateNotification({
    state: artifact.state,
    stateVersion: artifact.stateVersion,
    version: artifact.currentVersion,
  });
}

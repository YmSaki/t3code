import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ARTIFACT_STATE_MAX_BYTES,
  Artifact,
  ArtifactCreateInput,
  ArtifactError,
  ArtifactNotFoundError,
  ArtifactPatchStateInput,
  ArtifactState,
  ArtifactStateConflictError,
  ArtifactStatePatch,
  ArtifactSwitchVersionInput,
  ArtifactUserAction,
  ArtifactVersion,
} from "./artifact.ts";

const at = "2026-10-05T00:00:00.000Z";
const decodeArtifact = Schema.decodeUnknownSync(Artifact);
const decodeArtifactState = Schema.decodeUnknownSync(ArtifactState);
const decodeArtifactVersion = Schema.decodeUnknownSync(ArtifactVersion);
const decodeArtifactCreateInput = Schema.decodeUnknownSync(ArtifactCreateInput);
const decodeArtifactStatePatch = Schema.decodeUnknownSync(ArtifactStatePatch);
const decodeArtifactPatchStateInput = Schema.decodeUnknownSync(ArtifactPatchStateInput);
const decodeArtifactSwitchVersionInput = Schema.decodeUnknownSync(ArtifactSwitchVersionInput);
const decodeArtifactUserAction = Schema.decodeUnknownSync(ArtifactUserAction);
const decodeArtifactId = Schema.decodeUnknownSync(ArtifactNotFoundError.fields.artifactId);
const decodeArtifactError = Schema.decodeUnknownSync(ArtifactError);
const encodeArtifactError = Schema.encodeSync(ArtifactError);

describe("Artifact", () => {
  const artifact = {
    id: "artifact-1",
    environmentId: "env-1",
    projectId: "project-1",
    threadId: "thread-1",
    kind: "html",
    title: "  Dashboard  ",
    currentVersion: 1,
    stateVersion: 0,
    state: {},
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
  };

  it("decodes and trims the title", () => {
    expect(decodeArtifact(artifact).title).toBe("Dashboard");
  });

  it("rejects unknown kinds and zero versions", () => {
    expect(() => decodeArtifact({ ...artifact, kind: "pdf" })).toThrow();
    expect(() => decodeArtifact({ ...artifact, currentVersion: 0 })).toThrow();
  });

  it("rejects state above the byte budget, counting UTF-8 bytes", () => {
    const ascii = { text: "a".repeat(ARTIFACT_STATE_MAX_BYTES) };
    const multibyte = { text: "あ".repeat(Math.ceil(ARTIFACT_STATE_MAX_BYTES / 3)) };
    expect(() => decodeArtifactState(ascii)).toThrow();
    expect(() => decodeArtifactState(multibyte)).toThrow();
    expect(decodeArtifactState({ text: "a".repeat(100) })).toEqual({ text: "a".repeat(100) });
  });
});

describe("ArtifactVersion", () => {
  it("requires an author", () => {
    const version = {
      artifactId: "artifact-1",
      version: 2,
      content: "<p>x</p>",
      createdAt: at,
    };
    expect(() => decodeArtifactVersion(version)).toThrow();
    expect(decodeArtifactVersion({ ...version, author: "user" }).author).toBe("user");
  });
});

describe("artifact inputs", () => {
  it("accepts a create input without author", () => {
    const input = decodeArtifactCreateInput({
      threadId: "thread-1",
      kind: "markdown",
      title: "Plan",
      content: "- [ ] a",
    });
    expect(input.kind).toBe("markdown");
    expect(input.author).toBeUndefined();
  });

  it("keeps the patch shape shared with the state patch input", () => {
    const patch = { patch: { done: true, stale: null }, expectedVersion: 3 };
    expect(decodeArtifactStatePatch(patch)).toEqual(patch);
    expect(decodeArtifactPatchStateInput({ artifactId: "artifact-1", ...patch })).toEqual({
      artifactId: "artifact-1",
      ...patch,
    });
    expect(() => decodeArtifactStatePatch({ patch: [], expectedVersion: -1 })).toThrow();
  });

  it("rejects switching to version zero", () => {
    expect(() =>
      decodeArtifactSwitchVersionInput({ artifactId: "artifact-1", version: 0 }),
    ).toThrow();
  });

  it("requires an action name and keeps the optional prompt text", () => {
    expect(
      decodeArtifactUserAction({
        actionName: " approve ",
        payload: { id: 1 },
        promptText: "Approved",
      }),
    ).toEqual({ actionName: "approve", payload: { id: 1 }, promptText: "Approved" });
    expect(() => decodeArtifactUserAction({ actionName: " ", payload: {} })).toThrow();
    expect(() => decodeArtifactUserAction({ actionName: "a".repeat(129), payload: {} })).toThrow();
  });
});

describe("artifact errors", () => {
  it("round-trips tagged errors through the error union", () => {
    const error = new ArtifactStateConflictError({
      artifactId: decodeArtifactId("artifact-1"),
      expectedVersion: 1,
      actualVersion: 4,
    });
    const encoded = encodeArtifactError(error);
    const decoded = decodeArtifactError(encoded);
    expect(decoded).toBeInstanceOf(ArtifactStateConflictError);
    expect(decoded.message).toContain("version 4");
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  ARTIFACT_BRIDGE_ACTION_NAME_MAX_LENGTH,
  ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
  ARTIFACT_BRIDGE_ERROR_INVALID_REQUEST,
  ARTIFACT_BRIDGE_ERROR_METHOD_NOT_FOUND,
  ARTIFACT_BRIDGE_ERROR_PARSE,
  ARTIFACT_BRIDGE_ERROR_UNAUTHORIZED,
  ARTIFACT_BRIDGE_ERROR_USER_ACTIVATION_REQUIRED,
  ARTIFACT_BRIDGE_GET_STATE_METHOD,
  ARTIFACT_BRIDGE_PROMPT_TEXT_MAX_LENGTH,
  ARTIFACT_BRIDGE_SEND_ACTION_METHOD,
  ARTIFACT_BRIDGE_SEND_MESSAGE_METHOD,
  ARTIFACT_BRIDGE_SET_STATE_METHOD,
  ARTIFACT_BRIDGE_UPDATE_METHOD,
  artifactBridgeMethodRequiresActivation,
  buildArtifactBootstrapScript,
  buildArtifactBridgeErrorResponse,
  buildArtifactBridgeGetStateRequest,
  buildArtifactBridgeSendActionRequest,
  buildArtifactBridgeSendMessageRequest,
  buildArtifactBridgeSetStateRequest,
  buildArtifactBridgeSuccessResponse,
  buildArtifactBridgeUpdateNotification,
  buildArtifactOuterDocument,
  buildArtifactRelayEnvelope,
  buildArtifactSandboxCsp,
  injectArtifactBootstrap,
  parseArtifactBridgeRequest,
  parseArtifactBridgeResponse,
  parseArtifactBridgeUpdateNotification,
  verifyArtifactBridgeActivation,
  verifyArtifactBridgeMessage,
} from "./artifactBridge.core.ts";

describe("JSON-RPC 2.0 builders and parsers", () => {
  it("builds and parses getState, setState, sendAction, and sendMessage requests", () => {
    const getReq = buildArtifactBridgeGetStateRequest("req-1");
    expect(parseArtifactBridgeRequest(getReq)).toEqual({
      ok: true,
      request: {
        kind: "getState",
        id: "req-1",
        method: ARTIFACT_BRIDGE_GET_STATE_METHOD,
      },
    });

    const setReq = buildArtifactBridgeSetStateRequest(2, { count: 5, removed: null }, 3);
    expect(parseArtifactBridgeRequest(JSON.stringify(setReq))).toEqual({
      ok: true,
      request: {
        kind: "setState",
        id: 2,
        method: ARTIFACT_BRIDGE_SET_STATE_METHOD,
        patch: { count: 5, removed: null },
        expectedVersion: 3,
      },
    });

    const actionReq = buildArtifactBridgeSendActionRequest("req-3", {
      actionName: "  submit_form  ",
      payload: { approved: true },
      promptText: "  Please apply the form values. ",
    });
    expect(parseArtifactBridgeRequest(actionReq)).toEqual({
      ok: true,
      request: {
        kind: "sendAction",
        id: "req-3",
        method: ARTIFACT_BRIDGE_SEND_ACTION_METHOD,
        actionName: "submit_form",
        payload: { approved: true },
        promptText: "Please apply the form values.",
      },
    });

    const msgReq = buildArtifactBridgeSendMessageRequest("req-4", "  Refine section 2  ");
    expect(parseArtifactBridgeRequest(msgReq)).toEqual({
      ok: true,
      request: {
        kind: "sendMessage",
        id: "req-4",
        method: ARTIFACT_BRIDGE_SEND_MESSAGE_METHOD,
        text: "Refine section 2",
      },
    });
  });

  it("accepts short method names and bare patch objects in setState", () => {
    expect(
      parseArtifactBridgeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "setState",
        params: { theme: "dark" },
      }),
    ).toEqual({
      ok: true,
      request: {
        kind: "setState",
        id: 1,
        method: ARTIFACT_BRIDGE_SET_STATE_METHOD,
        patch: { theme: "dark" },
      },
    });
  });

  it("rejects malformed JSON, invalid envelopes, unknown methods, and invalid params", () => {
    expect(parseArtifactBridgeRequest("{bad json")).toMatchObject({
      ok: false,
      reason: "parse_error",
      code: ARTIFACT_BRIDGE_ERROR_PARSE,
    });
    expect(parseArtifactBridgeRequest(null)).toMatchObject({
      ok: false,
      reason: "invalid_request",
      code: ARTIFACT_BRIDGE_ERROR_INVALID_REQUEST,
    });
    expect(parseArtifactBridgeRequest({ jsonrpc: "1.0", id: 1, method: "getState" })).toMatchObject(
      {
        ok: false,
        reason: "invalid_request",
        code: ARTIFACT_BRIDGE_ERROR_INVALID_REQUEST,
      },
    );
    expect(
      parseArtifactBridgeRequest({ jsonrpc: "2.0", id: "1", method: "t3/artifact/unknown" }),
    ).toMatchObject({
      ok: false,
      reason: "method_not_found",
      id: "1",
      code: ARTIFACT_BRIDGE_ERROR_METHOD_NOT_FOUND,
    });
    expect(
      parseArtifactBridgeRequest({
        jsonrpc: "2.0",
        id: "2",
        method: ARTIFACT_BRIDGE_SET_STATE_METHOD,
        params: { patch: [1, 2], expectedVersion: 0 },
      }),
    ).toMatchObject({
      ok: false,
      reason: "invalid_params",
      id: "2",
      code: ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
    });
    expect(
      parseArtifactBridgeRequest({
        jsonrpc: "2.0",
        id: "3",
        method: ARTIFACT_BRIDGE_SET_STATE_METHOD,
        params: { patch: { a: 1 }, expectedVersion: -1 },
      }),
    ).toMatchObject({
      ok: false,
      reason: "invalid_params",
      code: ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
    });
    expect(
      parseArtifactBridgeRequest({
        jsonrpc: "2.0",
        id: "4",
        method: ARTIFACT_BRIDGE_SEND_ACTION_METHOD,
        params: { actionName: "   " },
      }),
    ).toMatchObject({
      ok: false,
      reason: "invalid_params",
      code: ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
    });
    expect(
      parseArtifactBridgeRequest({
        jsonrpc: "2.0",
        id: "5",
        method: ARTIFACT_BRIDGE_SEND_ACTION_METHOD,
        params: {
          actionName: "a".repeat(ARTIFACT_BRIDGE_ACTION_NAME_MAX_LENGTH + 1),
          payload: {},
        },
      }),
    ).toMatchObject({
      ok: false,
      reason: "invalid_params",
      code: ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
    });
    expect(
      parseArtifactBridgeRequest({
        jsonrpc: "2.0",
        id: "6",
        method: ARTIFACT_BRIDGE_SEND_MESSAGE_METHOD,
        params: { text: "x".repeat(ARTIFACT_BRIDGE_PROMPT_TEXT_MAX_LENGTH + 1) },
      }),
    ).toMatchObject({
      ok: false,
      reason: "invalid_params",
      code: ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
    });
  });

  it("builds and parses onUpdate notifications and JSON-RPC responses", () => {
    const notification = buildArtifactBridgeUpdateNotification({
      state: { step: 2 },
      stateVersion: 4,
      version: 2,
      theme: "dark",
    });
    expect(notification.method).toBe(ARTIFACT_BRIDGE_UPDATE_METHOD);
    expect(parseArtifactBridgeUpdateNotification(JSON.stringify(notification))).toEqual({
      state: { step: 2 },
      stateVersion: 4,
      version: 2,
      theme: "dark",
    });
    expect(
      parseArtifactBridgeUpdateNotification({
        jsonrpc: "2.0",
        method: ARTIFACT_BRIDGE_UPDATE_METHOD,
        params: { state: [], stateVersion: 1 },
      }),
    ).toBeNull();

    const okRes = buildArtifactBridgeSuccessResponse("req-1", { state: { a: 1 }, stateVersion: 1 });
    expect(parseArtifactBridgeResponse(JSON.stringify(okRes))).toEqual(okRes);

    const errRes = buildArtifactBridgeErrorResponse("req-2", -32001, "Denied", { detail: "focus" });
    expect(parseArtifactBridgeResponse(errRes)).toEqual(errRes);
  });
});

describe("secret and userActivation verification", () => {
  it("requires userActivation only for sendAction and sendMessage", () => {
    expect(artifactBridgeMethodRequiresActivation("getState")).toBe(false);
    expect(artifactBridgeMethodRequiresActivation("setState")).toBe(false);
    expect(artifactBridgeMethodRequiresActivation("sendAction")).toBe(true);
    expect(artifactBridgeMethodRequiresActivation("sendMessage")).toBe(true);
  });

  it("allows getState and setState without user activation when secret matches", () => {
    const envelope = buildArtifactRelayEnvelope(
      "secret-123",
      false,
      buildArtifactBridgeSetStateRequest("s-1", { draft: "hello" }),
    );
    const verified = verifyArtifactBridgeMessage(JSON.stringify(envelope), {
      expectedSecret: "secret-123",
    });
    expect(verified).toEqual({
      ok: true,
      active: false,
      request: {
        kind: "setState",
        id: "s-1",
        method: ARTIFACT_BRIDGE_SET_STATE_METHOD,
        patch: { draft: "hello" },
      },
    });
  });

  it("blocks sendAction and sendMessage unless active is true and frame is focused", () => {
    const actionMsg = buildArtifactBridgeSendActionRequest("a-1", {
      actionName: "run",
      payload: { id: 10 },
    });
    const inactiveEnvelope = buildArtifactRelayEnvelope("secret-123", false, actionMsg);
    expect(verifyArtifactBridgeMessage(inactiveEnvelope, { expectedSecret: "secret-123" })).toEqual(
      {
        ok: false,
        reason: "user_activation_required",
        id: "a-1",
        code: ARTIFACT_BRIDGE_ERROR_USER_ACTIVATION_REQUIRED,
        message: "sendAction requires an active user gesture in the artifact frame.",
      },
    );

    const activeEnvelope = buildArtifactRelayEnvelope("secret-123", true, actionMsg);
    expect(
      verifyArtifactBridgeMessage(activeEnvelope, {
        expectedSecret: "secret-123",
        frameFocused: false,
      }),
    ).toMatchObject({
      ok: false,
      reason: "user_activation_required",
      id: "a-1",
      code: ARTIFACT_BRIDGE_ERROR_USER_ACTIVATION_REQUIRED,
    });

    expect(
      verifyArtifactBridgeMessage(activeEnvelope, {
        expectedSecret: "secret-123",
        frameFocused: true,
      }),
    ).toEqual({
      ok: true,
      active: true,
      request: {
        kind: "sendAction",
        id: "a-1",
        method: ARTIFACT_BRIDGE_SEND_ACTION_METHOD,
        actionName: "run",
        payload: { id: 10 },
      },
    });
  });

  it("rejects mismatched secrets and detects frame navigation sentinels", () => {
    const msg = buildArtifactBridgeGetStateRequest("g-1");
    expect(
      verifyArtifactBridgeMessage(buildArtifactRelayEnvelope("wrong-secret", true, msg), {
        expectedSecret: "secret-123",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid_secret",
      id: null,
      code: ARTIFACT_BRIDGE_ERROR_UNAUTHORIZED,
      message: "Bridge secret mismatch.",
    });

    expect(
      verifyArtifactBridgeActivation("getState", {
        expectedSecret: "secret-123",
        secret: "wrong",
        active: true,
      }),
    ).toEqual({
      ok: false,
      reason: "invalid_secret",
    });

    expect(
      verifyArtifactBridgeMessage(
        buildArtifactRelayEnvelope("secret-123", false, { t3: "navigated" }),
        { expectedSecret: "secret-123" },
      ),
    ).toEqual({
      ok: false,
      reason: "navigated",
      id: null,
      code: ARTIFACT_BRIDGE_ERROR_UNAUTHORIZED,
      message: "Artifact frame navigated away.",
    });
  });
});

describe("sandbox CSP and bootstrap injection", () => {
  it("constructs a strict CSP that blocks all external network connections", () => {
    const csp = buildArtifactSandboxCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toMatch(/https?:|wss?:/i);

    expect(buildArtifactSandboxCsp({ allowBlobFrames: true })).toContain("frame-src blob:");
  });

  it("generates a bootstrap script that exposes window.t3Artifact and escapes script boundaries", () => {
    const script = buildArtifactBootstrapScript({
      artifactId: "artifact-1",
      initialState: { xss: "</script><script>alert(1)</script>" },
      initialStateVersion: 2,
      secret: "sec</script>",
    });
    expect(script).toContain('"t3Artifact"');
    expect(script).toContain("getState:function()");
    expect(script).toContain("setState:function(");
    expect(script).toContain("sendAction:function(");
    expect(script).toContain("sendMessage:function(");
    expect(script).toContain("onUpdate:function(");
    expect(script).not.toContain("</script>");
    expect(script).toContain("\\u003c/script\\u003e");
  });

  it("injects CSP and bootstrap script into the real <head>, ignoring comments and templates", () => {
    const html = [
      "<!doctype html>",
      "<!-- <head><title>fake</title></head> -->",
      "<html>",
      "<template><head></head></template>",
      "<head><title>Real</title></head>",
      "<body><h1>Hello</h1></body>",
      "</html>",
    ].join("");
    const injected = injectArtifactBootstrap(html, { artifactId: "art-1" });
    const realHeadIndex = injected.indexOf("<head><meta");
    expect(realHeadIndex).toBeGreaterThan(injected.indexOf("<template><head></head></template>"));
    expect(injected).toContain('http-equiv="Content-Security-Policy"');
    expect(injected).toContain("t3Artifact");
  });

  it("builds an McpAppWebView-compatible outer relay document", () => {
    const outer = buildArtifactOuterDocument({
      src: "https://example.invalid/artifact?x=1&y=2",
      secret: "sec-1",
    });
    expect(outer).toContain('sandbox="allow-scripts"');
    expect(outer).toContain("window.ReactNativeWebView.postMessage");
    expect(outer).toContain("window.__t3ArtifactReceive");
    expect(outer).toContain('{t3:"navigated"}');
  });
});

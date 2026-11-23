const ARTIFACT_BRIDGE_GLOBAL_NAME = "t3Artifact";

export const ARTIFACT_BRIDGE_GET_STATE_METHOD = "t3/artifact/getState";
export const ARTIFACT_BRIDGE_SET_STATE_METHOD = "t3/artifact/setState";
export const ARTIFACT_BRIDGE_SEND_ACTION_METHOD = "t3/artifact/sendAction";
export const ARTIFACT_BRIDGE_SEND_MESSAGE_METHOD = "t3/artifact/sendMessage";
export const ARTIFACT_BRIDGE_UPDATE_METHOD = "t3/artifact/onUpdate";

export const ARTIFACT_BRIDGE_ACTION_NAME_MAX_LENGTH = 128;
export const ARTIFACT_BRIDGE_PROMPT_TEXT_MAX_LENGTH = 8_000;

export const ARTIFACT_BRIDGE_ERROR_PARSE = -32700;
export const ARTIFACT_BRIDGE_ERROR_INVALID_REQUEST = -32600;
export const ARTIFACT_BRIDGE_ERROR_METHOD_NOT_FOUND = -32601;
export const ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS = -32602;
export const ARTIFACT_BRIDGE_ERROR_USER_ACTIVATION_REQUIRED = -32001;
export const ARTIFACT_BRIDGE_ERROR_UNAUTHORIZED = -32002;

export type JsonRpcId = string | number;

export type ArtifactBridgeMethod = "getState" | "setState" | "sendAction" | "sendMessage";

export type ArtifactBridgeRequest =
  | {
      readonly kind: "getState";
      readonly id: JsonRpcId;
      readonly method: typeof ARTIFACT_BRIDGE_GET_STATE_METHOD;
    }
  | {
      readonly kind: "setState";
      readonly id: JsonRpcId;
      readonly method: typeof ARTIFACT_BRIDGE_SET_STATE_METHOD;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly expectedVersion?: number;
    }
  | {
      readonly kind: "sendAction";
      readonly id: JsonRpcId;
      readonly method: typeof ARTIFACT_BRIDGE_SEND_ACTION_METHOD;
      readonly actionName: string;
      readonly payload: Readonly<Record<string, unknown>>;
      readonly promptText?: string;
    }
  | {
      readonly kind: "sendMessage";
      readonly id: JsonRpcId;
      readonly method: typeof ARTIFACT_BRIDGE_SEND_MESSAGE_METHOD;
      readonly text: string;
    };

export interface ArtifactBridgeUpdatePayload {
  readonly state: Readonly<Record<string, unknown>>;
  readonly stateVersion: number;
  readonly version?: number;
  readonly theme?: "light" | "dark";
}

export interface ArtifactBridgeSuccessResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface ArtifactBridgeErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type ArtifactBridgeResponse = ArtifactBridgeSuccessResponse | ArtifactBridgeErrorResponse;

export type ArtifactBridgeParseFailureReason =
  | "parse_error"
  | "invalid_request"
  | "method_not_found"
  | "invalid_params";

export type ArtifactBridgeParseFailure = {
  readonly ok: false;
  readonly reason: ArtifactBridgeParseFailureReason;
  readonly id: JsonRpcId | null;
  readonly code: number;
  readonly message: string;
};

export type ArtifactBridgeParseResult =
  | {
      readonly ok: true;
      readonly request: ArtifactBridgeRequest;
    }
  | ArtifactBridgeParseFailure;

export interface ArtifactBridgeSecurityContext {
  readonly expectedSecret?: string;
  readonly secret?: string;
  readonly active?: boolean;
  readonly frameFocused?: boolean;
}

export type ArtifactBridgeVerificationFailureReason =
  | ArtifactBridgeParseFailureReason
  | "invalid_secret"
  | "navigated"
  | "user_activation_required";

export type ArtifactBridgeVerificationResult =
  | {
      readonly ok: true;
      readonly request: ArtifactBridgeRequest;
      readonly active: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: ArtifactBridgeVerificationFailureReason;
      readonly id: JsonRpcId | null;
      readonly code: number;
      readonly message: string;
    };

export interface ArtifactSandboxCspOptions {
  readonly allowBlobFrames?: boolean;
}

export interface ArtifactBootstrapOptions {
  readonly artifactId?: string;
  readonly initialState?: Readonly<Record<string, unknown>>;
  readonly initialStateVersion?: number;
  readonly secret?: string;
  readonly csp?: ArtifactSandboxCspOptions;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    (typeof value === "string" && value.length > 0 && value.length <= 256) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function resolveBridgeMethod(method: string): ArtifactBridgeMethod | null {
  switch (method) {
    case ARTIFACT_BRIDGE_GET_STATE_METHOD:
    case "getState":
      return "getState";
    case ARTIFACT_BRIDGE_SET_STATE_METHOD:
    case "setState":
      return "setState";
    case ARTIFACT_BRIDGE_SEND_ACTION_METHOD:
    case "sendAction":
      return "sendAction";
    case ARTIFACT_BRIDGE_SEND_MESSAGE_METHOD:
    case "sendMessage":
      return "sendMessage";
    default:
      return null;
  }
}

export function artifactBridgeMethodRequiresActivation(method: ArtifactBridgeMethod): boolean {
  return method === "sendAction" || method === "sendMessage";
}

export function buildArtifactBridgeGetStateRequest(id: JsonRpcId) {
  return {
    jsonrpc: "2.0",
    id,
    method: ARTIFACT_BRIDGE_GET_STATE_METHOD,
    params: {},
  } as const;
}

export function buildArtifactBridgeSetStateRequest(
  id: JsonRpcId,
  patch: Readonly<Record<string, unknown>>,
  expectedVersion?: number,
) {
  return {
    jsonrpc: "2.0",
    id,
    method: ARTIFACT_BRIDGE_SET_STATE_METHOD,
    params: {
      patch,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    },
  } as const;
}

export function buildArtifactBridgeSendActionRequest(
  id: JsonRpcId,
  input: {
    readonly actionName: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly promptText?: string;
  },
) {
  return {
    jsonrpc: "2.0",
    id,
    method: ARTIFACT_BRIDGE_SEND_ACTION_METHOD,
    params: {
      actionName: input.actionName,
      payload: input.payload ?? {},
      ...(input.promptText === undefined ? {} : { promptText: input.promptText }),
    },
  } as const;
}

export function buildArtifactBridgeSendMessageRequest(id: JsonRpcId, text: string) {
  return {
    jsonrpc: "2.0",
    id,
    method: ARTIFACT_BRIDGE_SEND_MESSAGE_METHOD,
    params: { text },
  } as const;
}

export function buildArtifactBridgeUpdateNotification(payload: ArtifactBridgeUpdatePayload) {
  return {
    jsonrpc: "2.0",
    method: ARTIFACT_BRIDGE_UPDATE_METHOD,
    params: payload,
  } as const;
}

export function buildArtifactBridgeSuccessResponse(
  id: JsonRpcId,
  result: unknown,
): ArtifactBridgeSuccessResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

export function buildArtifactBridgeErrorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): ArtifactBridgeErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

export function buildArtifactRelayEnvelope(secret: string, active: boolean, message: unknown) {
  return {
    secret,
    active,
    message,
  } as const;
}

function decodeRawJson(
  raw: unknown,
): { readonly ok: true; readonly value: unknown } | ArtifactBridgeParseFailure {
  if (typeof raw !== "string") return { ok: true, value: raw };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return {
      ok: false,
      reason: "parse_error",
      id: null,
      code: ARTIFACT_BRIDGE_ERROR_PARSE,
      message: "Invalid JSON payload.",
    };
  }
}

export function parseArtifactBridgeRequest(raw: unknown): ArtifactBridgeParseResult {
  const decoded = decodeRawJson(raw);
  if (!decoded.ok) return decoded;
  const candidate = decoded.value;
  if (!isPlainObject(candidate)) {
    return {
      ok: false,
      reason: "invalid_request",
      id: null,
      code: ARTIFACT_BRIDGE_ERROR_INVALID_REQUEST,
      message: "JSON-RPC request must be an object.",
    };
  }
  const id = isJsonRpcId(candidate.id) ? candidate.id : null;
  if (candidate.jsonrpc !== "2.0" || id === null || typeof candidate.method !== "string") {
    return {
      ok: false,
      reason: "invalid_request",
      id,
      code: ARTIFACT_BRIDGE_ERROR_INVALID_REQUEST,
      message: "JSON-RPC 2.0 request requires jsonrpc, id, and method.",
    };
  }

  const kind = resolveBridgeMethod(candidate.method);
  if (kind === null) {
    return {
      ok: false,
      reason: "method_not_found",
      id,
      code: ARTIFACT_BRIDGE_ERROR_METHOD_NOT_FOUND,
      message: `Unsupported artifact bridge method: ${candidate.method}`,
    };
  }

  const params = candidate.params;
  if (params !== undefined && !isPlainObject(params)) {
    return {
      ok: false,
      reason: "invalid_params",
      id,
      code: ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
      message: "JSON-RPC params must be an object when present.",
    };
  }

  switch (kind) {
    case "getState":
      return {
        ok: true,
        request: {
          kind: "getState",
          id,
          method: ARTIFACT_BRIDGE_GET_STATE_METHOD,
        },
      };

    case "setState": {
      if (params === undefined) {
        return {
          ok: false,
          reason: "invalid_params",
          id,
          code: ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
          message: "setState requires a patch object.",
        };
      }
      const hasWrappedPatch = Object.hasOwn(params, "patch");
      const patch = hasWrappedPatch ? params.patch : params;
      if (!isPlainObject(patch)) {
        return {
          ok: false,
          reason: "invalid_params",
          id,
          code: ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
          message: "setState patch must be a plain JSON object.",
        };
      }
      const expectedVersion = hasWrappedPatch ? params.expectedVersion : undefined;
      if (expectedVersion !== undefined && !isNonNegativeInt(expectedVersion)) {
        return {
          ok: false,
          reason: "invalid_params",
          id,
          code: ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
          message: "expectedVersion must be a non-negative integer.",
        };
      }
      return {
        ok: true,
        request: {
          kind: "setState",
          id,
          method: ARTIFACT_BRIDGE_SET_STATE_METHOD,
          patch,
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        },
      };
    }

    case "sendAction": {
      if (params === undefined || typeof params.actionName !== "string") {
        return {
          ok: false,
          reason: "invalid_params",
          id,
          code: ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
          message: "sendAction requires a non-empty actionName.",
        };
      }
      const actionName = params.actionName.trim();
      if (actionName.length === 0 || actionName.length > ARTIFACT_BRIDGE_ACTION_NAME_MAX_LENGTH) {
        return {
          ok: false,
          reason: "invalid_params",
          id,
          code: ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
          message: `actionName must be 1..${ARTIFACT_BRIDGE_ACTION_NAME_MAX_LENGTH} characters.`,
        };
      }
      const payload = params.payload === undefined ? {} : params.payload;
      if (!isPlainObject(payload)) {
        return {
          ok: false,
          reason: "invalid_params",
          id,
          code: ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
          message: "sendAction payload must be a plain JSON object.",
        };
      }
      let promptText: string | undefined;
      if (params.promptText !== undefined) {
        if (typeof params.promptText !== "string") {
          return {
            ok: false,
            reason: "invalid_params",
            id,
            code: ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
            message: "promptText must be a string.",
          };
        }
        const trimmedPrompt = params.promptText.trim();
        if (
          trimmedPrompt.length === 0 ||
          trimmedPrompt.length > ARTIFACT_BRIDGE_PROMPT_TEXT_MAX_LENGTH
        ) {
          return {
            ok: false,
            reason: "invalid_params",
            id,
            code: ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
            message: `promptText must be 1..${ARTIFACT_BRIDGE_PROMPT_TEXT_MAX_LENGTH} characters.`,
          };
        }
        promptText = trimmedPrompt;
      }
      return {
        ok: true,
        request: {
          kind: "sendAction",
          id,
          method: ARTIFACT_BRIDGE_SEND_ACTION_METHOD,
          actionName,
          payload,
          ...(promptText === undefined ? {} : { promptText }),
        },
      };
    }

    case "sendMessage": {
      const rawText = params?.text ?? params?.promptText ?? params?.message;
      if (typeof rawText !== "string") {
        return {
          ok: false,
          reason: "invalid_params",
          id,
          code: ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
          message: "sendMessage requires a text string.",
        };
      }
      const text = rawText.trim();
      if (text.length === 0 || text.length > ARTIFACT_BRIDGE_PROMPT_TEXT_MAX_LENGTH) {
        return {
          ok: false,
          reason: "invalid_params",
          id,
          code: ARTIFACT_BRIDGE_ERROR_INVALID_PARAMS,
          message: `sendMessage text must be 1..${ARTIFACT_BRIDGE_PROMPT_TEXT_MAX_LENGTH} characters.`,
        };
      }
      return {
        ok: true,
        request: {
          kind: "sendMessage",
          id,
          method: ARTIFACT_BRIDGE_SEND_MESSAGE_METHOD,
          text,
        },
      };
    }
  }
}

export function parseArtifactBridgeUpdateNotification(
  raw: unknown,
): ArtifactBridgeUpdatePayload | null {
  const decoded = decodeRawJson(raw);
  if (!decoded.ok || !isPlainObject(decoded.value)) return null;
  const { jsonrpc, method, params } = decoded.value;
  if (
    jsonrpc !== "2.0" ||
    (method !== ARTIFACT_BRIDGE_UPDATE_METHOD && method !== "onUpdate") ||
    !isPlainObject(params)
  ) {
    return null;
  }
  if (!isPlainObject(params.state) || !isNonNegativeInt(params.stateVersion)) return null;
  const version = params.version;
  if (version !== undefined && (!isNonNegativeInt(version) || version < 1)) return null;
  const theme = params.theme;
  if (theme !== undefined && theme !== "light" && theme !== "dark") return null;
  return {
    state: params.state,
    stateVersion: params.stateVersion,
    ...(version === undefined ? {} : { version }),
    ...(theme === undefined ? {} : { theme }),
  };
}

export function parseArtifactBridgeResponse(raw: unknown): ArtifactBridgeResponse | null {
  const decoded = decodeRawJson(raw);
  if (!decoded.ok || !isPlainObject(decoded.value)) return null;
  const candidate = decoded.value;
  if (candidate.jsonrpc !== "2.0") return null;
  const id = candidate.id === null ? null : isJsonRpcId(candidate.id) ? candidate.id : undefined;
  if (id === undefined) return null;
  if (Object.hasOwn(candidate, "error")) {
    const error = candidate.error;
    if (
      !isPlainObject(error) ||
      typeof error.code !== "number" ||
      !Number.isInteger(error.code) ||
      typeof error.message !== "string"
    ) {
      return null;
    }
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: error.code,
        message: error.message,
        ...(error.data === undefined ? {} : { data: error.data }),
      },
    };
  }
  if (id !== null && Object.hasOwn(candidate, "result")) {
    return {
      jsonrpc: "2.0",
      id,
      result: candidate.result,
    };
  }
  return null;
}

export function verifyArtifactBridgeActivation(
  method: ArtifactBridgeMethod,
  context: ArtifactBridgeSecurityContext,
):
  | { readonly ok: true; readonly active: boolean }
  | { readonly ok: false; readonly reason: "invalid_secret" | "user_activation_required" } {
  if (context.expectedSecret !== undefined) {
    if (
      context.expectedSecret.length === 0 ||
      typeof context.secret !== "string" ||
      context.secret !== context.expectedSecret
    ) {
      return { ok: false, reason: "invalid_secret" };
    }
  }
  const active = context.active === true && (context.frameFocused ?? true);
  if (artifactBridgeMethodRequiresActivation(method) && !active) {
    return { ok: false, reason: "user_activation_required" };
  }
  return { ok: true, active };
}

/**
 * Verifies an incoming message from a sandboxed artifact frame or a `McpAppWebView`-style
 * relay envelope (`{ secret, active, message }`), enforcing secret matching and requiring
 * `active === true` for user-triggered actions (`sendAction`, `sendMessage`).
 */
export function verifyArtifactBridgeMessage(
  raw: unknown,
  context: ArtifactBridgeSecurityContext = {},
): ArtifactBridgeVerificationResult {
  const decoded = decodeRawJson(raw);
  if (!decoded.ok) return decoded;
  const value = decoded.value;
  if (!isPlainObject(value)) {
    return {
      ok: false,
      reason: "invalid_request",
      id: null,
      code: ARTIFACT_BRIDGE_ERROR_INVALID_REQUEST,
      message: "Bridge message must be an object.",
    };
  }

  const isRelayEnvelope = Object.hasOwn(value, "message") && !Object.hasOwn(value, "jsonrpc");
  const secret =
    typeof value.secret === "string"
      ? value.secret
      : typeof context.secret === "string"
        ? context.secret
        : undefined;
  const activeFromEnvelope =
    typeof value.active === "boolean" ? value.active : context.active === true;
  const innerMessage = isRelayEnvelope ? value.message : value;

  if (context.expectedSecret !== undefined) {
    if (
      context.expectedSecret.length === 0 ||
      secret === undefined ||
      secret !== context.expectedSecret
    ) {
      return {
        ok: false,
        reason: "invalid_secret",
        id: null,
        code: ARTIFACT_BRIDGE_ERROR_UNAUTHORIZED,
        message: "Bridge secret mismatch.",
      };
    }
  }

  if (isPlainObject(innerMessage) && innerMessage.t3 === "navigated") {
    return {
      ok: false,
      reason: "navigated",
      id: null,
      code: ARTIFACT_BRIDGE_ERROR_UNAUTHORIZED,
      message: "Artifact frame navigated away.",
    };
  }

  const parsed = parseArtifactBridgeRequest(innerMessage);
  if (!parsed.ok) return parsed;

  const activation = verifyArtifactBridgeActivation(parsed.request.kind, {
    active: activeFromEnvelope,
    ...(context.frameFocused === undefined ? {} : { frameFocused: context.frameFocused }),
  });
  if (!activation.ok) {
    return {
      ok: false,
      reason: "user_activation_required",
      id: parsed.request.id,
      code: ARTIFACT_BRIDGE_ERROR_USER_ACTIVATION_REQUIRED,
      message: `${parsed.request.kind} requires an active user gesture in the artifact frame.`,
    };
  }

  return {
    ok: true,
    request: parsed.request,
    active: activation.active,
  };
}

/**
 * Blocks all external network access (`default-src 'none'`, `connect-src 'none'`,
 * `form-action 'none'`, `base-uri 'none'`, `object-src 'none'`, `worker-src 'none'`).
 * Only inline scripts/styles and `data:` / `blob:` media are permitted inside the sandbox.
 */
export function buildArtifactSandboxCsp(options: ArtifactSandboxCspOptions = {}): string {
  const frameSrc = options.allowBlobFrames === true ? "blob:" : "'none'";
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    `frame-src ${frameSrc}`,
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Purely generates the inline JavaScript that installs `window.t3Artifact`
 * (`getState`, `setState`, `sendAction`, `sendMessage`, `onUpdate`) and disables
 * ambient network primitives inside the sandboxed frame.
 */
export function buildArtifactBootstrapScript(options: ArtifactBootstrapOptions = {}): string {
  const initialStateJson = escapeScriptJson(options.initialState ?? {});
  const initialStateVersion =
    options.initialStateVersion !== undefined && isNonNegativeInt(options.initialStateVersion)
      ? options.initialStateVersion
      : 0;
  const secretJson = options.secret === undefined ? "null" : escapeScriptJson(options.secret);
  const artifactIdJson =
    options.artifactId === undefined ? "null" : escapeScriptJson(options.artifactId);

  return [
    "(function(){",
    `var state=${initialStateJson},stateVersion=${initialStateVersion},secret=${secretJson},artifactId=${artifactIdJson},seq=0,pending=Object.create(null),listeners=[];`,
    'var deny=function(){throw new Error("External network access is disabled in T3 artifacts.");};',
    'try{window.fetch=function(){return Promise.reject(new Error("External network access is disabled in T3 artifacts."));};window.XMLHttpRequest=function(){throw new Error("External network access is disabled in T3 artifacts.");};window.WebSocket=function(){deny();};window.EventSource=function(){deny();};if(navigator&&navigator.sendBeacon)navigator.sendBeacon=function(){return false;};window.open=function(){return null;};}catch(e){}',
    'var post=function(msg){if(window.parent===window)return;var u=navigator.userActivation,active=!!(u&&u.isActive);var payload=secret===null?msg:{secret:secret,active:active,message:msg};window.parent.postMessage(payload,"*");};',
    'var call=function(method,params){return new Promise(function(resolve,reject){var id="t3-artifact-"+(++seq);pending[id]={resolve:resolve,reject:reject};post({jsonrpc:"2.0",id:id,method:method,params:params});});};',
    'window.addEventListener("message",function(e){if(e.source!==window.parent)return;var d=e.data;if(!d||d.jsonrpc!=="2.0")return;if(d.method==="t3/artifact/onUpdate"&&d.params&&typeof d.params==="object"){if(d.params.state&&typeof d.params.state==="object")state=d.params.state;if(typeof d.params.stateVersion==="number")stateVersion=d.params.stateVersion;var copy=listeners.slice();for(var i=0;i<copy.length;i++){try{copy[i](d.params);}catch(err){}}return;}if(d.id!==undefined&&pending[d.id]){var entry=pending[d.id];delete pending[d.id];if(d.error){var err=new Error(d.error.message||"Artifact bridge error");err.code=d.error.code;entry.reject(err);}else{entry.resolve(d.result);}}});',
    "var api=Object.freeze({",
    "artifactId:artifactId,",
    `getState:function(){return call(${JSON.stringify(ARTIFACT_BRIDGE_GET_STATE_METHOD)},{});},`,
    `setState:function(patch,expectedVersion){var p={patch:patch};if(typeof expectedVersion==="number")p.expectedVersion=expectedVersion;return call(${JSON.stringify(ARTIFACT_BRIDGE_SET_STATE_METHOD)},p);},`,
    `sendAction:function(actionName,payload,promptText){var p={actionName:actionName,payload:payload||{}};if(typeof promptText==="string")p.promptText=promptText;return call(${JSON.stringify(ARTIFACT_BRIDGE_SEND_ACTION_METHOD)},p);},`,
    `sendMessage:function(text){return call(${JSON.stringify(ARTIFACT_BRIDGE_SEND_MESSAGE_METHOD)},{text:text});},`,
    'onUpdate:function(fn){if(typeof fn!=="function")return function(){};listeners.push(fn);return function(){var idx=listeners.indexOf(fn);if(idx!==-1)listeners.splice(idx,1);};}',
    "});",
    `Object.defineProperty(window,${JSON.stringify(ARTIFACT_BRIDGE_GLOBAL_NAME)},{value:api,configurable:false,enumerable:true,writable:false});`,
    "})();",
  ].join("");
}

function blankNonMarkup(html: string): string {
  return html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => " ".repeat(match.length),
  );
}

export function injectArtifactBootstrap(
  html: string,
  options: ArtifactBootstrapOptions = {},
): string {
  const scan = blankNonMarkup(html);
  const csp = buildArtifactSandboxCsp(options.csp);
  const markup = [
    /<meta\s[^>]*charset/i.test(scan.slice(0, 4096)) ? "" : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(scan)
      ? ""
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">`,
    `<script>${buildArtifactBootstrapScript(options)}</script>`,
  ].join("");

  const headOpen = /<head(?:\s(?:[^"'>]|"[^"]*"|'[^']*')*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return `${html.slice(0, at)}${markup}${html.slice(at)}`;
  }
  const htmlOpen = /<html(?:\s(?:[^"'>]|"[^"]*"|'[^']*')*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}

/**
 * Builds the `McpAppWebView`-compatible outer relay HTML document for mobile WebViews,
 * wrapping messages with `{ secret, active, message }` and halting on second frame loads.
 */
export function buildArtifactOuterDocument(options: {
  readonly src: string;
  readonly secret: string;
  readonly allow?: string;
}): string {
  const allow = escapeHtmlAttribute(options.allow ?? "");
  const secretJson = escapeScriptJson(options.secret);
  const srcJson = escapeScriptJson(options.src);
  return [
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">',
    "<style>html,body{margin:0;height:100%;background:transparent}iframe{border:0;display:block;width:100%;height:100%}</style></head>",
    `<body><iframe id="artifact" sandbox="allow-scripts" allow="${allow}"></iframe>`,
    `<script>(function(){var frame=document.getElementById("artifact"),secret=${secretJson},loads=0,live=true;`,
    "var send=function(m){var u=navigator.userActivation;window.ReactNativeWebView.postMessage(JSON.stringify({secret:secret,active:!!(u&&u.isActive)&&document.activeElement===frame,message:m}));};",
    'frame.addEventListener("load",function(){loads+=1;if(loads>1&&live){live=false;send({t3:"navigated"});}});',
    'window.addEventListener("message",function(e){if(live&&e.source===frame.contentWindow)send(e.data);});',
    'window.__t3ArtifactReceive=function(m){live&&frame.contentWindow&&frame.contentWindow.postMessage(m,"*");};',
    `frame.src=${srcJson};})();</script></body></html>`,
  ].join("\n");
}

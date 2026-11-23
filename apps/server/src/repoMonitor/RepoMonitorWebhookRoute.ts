import { ProjectId } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { handleRepoMonitorWebhook } from "./RepoMonitorRuntimeWiring.ts";

const REPO_MONITOR_WEBHOOK_PREFIX = "/api/repo-monitor/webhook";
const REPO_MONITOR_WEBHOOK_ROUTE = "/api/repo-monitor/webhook/:projectId";
const WEBHOOK_SECRET_ENV = "T3CODE_REPO_MONITOR_WEBHOOK_SECRET";

function extractProjectId(url: string): ProjectId | null {
  const pathPart = url.split("?", 2)[0] ?? "";
  let pathname = pathPart;
  if (pathPart.startsWith("http://") || pathPart.startsWith("https://")) {
    try {
      pathname = new URL(pathPart).pathname;
    } catch {
      return null;
    }
  }
  const prefix = `${REPO_MONITOR_WEBHOOK_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return null;
  const rawSegment = pathname.slice(prefix.length);
  if (rawSegment.length === 0 || rawSegment.includes("/")) return null;
  try {
    const decoded = decodeURIComponent(rawSegment).trim();
    return decoded.length > 0 ? ProjectId.make(decoded) : null;
  } catch {
    return null;
  }
}

function normalizeHeaders(
  headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      out[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && typeof value[0] === "string") {
      out[key.toLowerCase()] = value[0];
    }
  }
  return out;
}

export const makeRepoMonitorWebhookHandler = Effect.fn("RepoMonitorWebhookRoute.handle")(function* (
  resolveSecret?: () => string | undefined,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const projectId = extractProjectId(request.url);
  if (projectId === null) {
    return yield* HttpServerResponse.json({ error: "Invalid projectId" }, { status: 400 });
  }
  const secret = (
    resolveSecret?.() ?? (yield* Config.String(WEBHOOK_SECRET_ENV).pipe(Config.withDefault("")))
  ).trim();
  if (!secret) {
    return yield* HttpServerResponse.json(
      { error: "Webhook secret not configured" },
      { status: 503 },
    );
  }
  const body = new Uint8Array(yield* request.arrayBuffer);
  const headers = normalizeHeaders(request.headers);
  const outcome = yield* handleRepoMonitorWebhook({
    projectId,
    secret,
    headers,
    body,
  });
  switch (outcome.status) {
    case "unauthorized":
      return yield* HttpServerResponse.json({ error: "Unauthorized" }, { status: 401 });
    case "ignored":
      return yield* HttpServerResponse.json({ accepted: false, ignored: true }, { status: 202 });
    case "accepted":
      return yield* HttpServerResponse.json(
        { accepted: true, eventCount: outcome.events.length },
        { status: 200 },
      );
  }
});

export const layer = HttpRouter.add(
  "POST",
  REPO_MONITOR_WEBHOOK_ROUTE,
  makeRepoMonitorWebhookHandler().pipe(Effect.orDie),
);

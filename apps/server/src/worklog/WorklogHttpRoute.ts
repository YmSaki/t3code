import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { WorklogService } from "./WorklogService.ts";

export const WORKLOG_ICAL_ROUTE_PREFIX = "/api/worklog/ical";
export const WORKLOG_ICAL_ROUTE = "/api/worklog/ical/:token";

const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

const notFoundResponse = HttpServerResponse.text("Not Found", {
  status: 404,
  headers: NO_STORE_HEADERS,
});

function extractTokenSegment(url: string): string | null {
  const pathPart = url.split("?", 2)[0] ?? "";
  let pathname = pathPart;
  if (pathPart.startsWith("http://") || pathPart.startsWith("https://")) {
    try {
      pathname = new URL(pathPart).pathname;
    } catch {
      return null;
    }
  }

  const prefix = `${WORKLOG_ICAL_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const rawSegment = pathname.slice(prefix.length);
  if (rawSegment.length === 0 || rawSegment.includes("/")) {
    return null;
  }

  try {
    return decodeURIComponent(rawSegment);
  } catch {
    return null;
  }
}

function stripWeakEtagPrefix(tag: string): string {
  return tag.trim().replace(/^W\//i, "");
}

export function matchesIfNoneMatch(
  ifNoneMatchHeader: string | undefined,
  currentEtag: string,
): boolean {
  if (ifNoneMatchHeader === undefined || ifNoneMatchHeader.trim().length === 0) {
    return false;
  }
  const normalizedTarget = stripWeakEtagPrefix(currentEtag);
  return ifNoneMatchHeader.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === "*" || stripWeakEtagPrefix(trimmed) === normalizedTarget;
  });
}

export const handleWorklogIcalRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const tokenSegment = extractTokenSegment(request.url);
  if (tokenSegment === null || tokenSegment.trim().length === 0) {
    return notFoundResponse;
  }

  const worklogService = yield* WorklogService;
  return yield* worklogService.renderIcalFeedByToken(tokenSegment).pipe(
    Effect.map((rendered) => {
      const cacheHeaders = {
        etag: rendered.etag,
        "cache-control": "private, no-cache",
        "x-content-type-options": "nosniff",
      };

      if (matchesIfNoneMatch(request.headers["if-none-match"], rendered.etag)) {
        return HttpServerResponse.empty({
          status: 304,
          headers: cacheHeaders,
        });
      }

      return HttpServerResponse.text(rendered.icsText, {
        status: 200,
        contentType: "text/calendar; charset=utf-8",
        headers: {
          ...cacheHeaders,
          "content-type": "text/calendar; charset=utf-8",
        },
      });
    }),
    Effect.catchTags({
      WorklogError: () => Effect.succeed(notFoundResponse),
    }),
  );
});

export const layer = HttpRouter.add("GET", WORKLOG_ICAL_ROUTE, handleWorklogIcalRequest, {
  redactedParams: ["*"],
});

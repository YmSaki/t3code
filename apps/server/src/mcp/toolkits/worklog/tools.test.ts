import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type WorklogFilter,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

import * as WorklogService from "../../../worklog/WorklogService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as WorklogHandlers from "./handlers.ts";
import { WorklogToolkit } from "./tools.ts";

it("exports provider-compatible object schemas for all Worklog tools", () => {
  for (const tool of Object.values(WorklogToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
  }
});

it.effect("worklog_query_local forces includePeers: false", () =>
  Effect.gen(function* () {
    const seenFilters: Array<WorklogFilter | undefined> = [];
    const callerThreadId = ThreadId.make("thread:worklog-caller");

    const mockWorklog = WorklogService.WorklogService.of({
      queryWorklog: (filter?: WorklogFilter) =>
        Effect.sync(() => {
          seenFilters.push(filter);
          return { entries: [], nextCursor: null, totalCount: 0 };
        }),
    } as unknown as WorklogService.WorklogService["Service"]);

    const layer = McpToolAccess.HandlersLayer.layer(WorklogHandlers.layer).pipe(
      Layer.provideMerge(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("env:worklog"),
          requestNamespace: `provider:${callerThreadId}`,
          thread: {
            threadId: callerThreadId,
            providerSessionId: `provider:${callerThreadId}`,
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
      ),
      Layer.provideMerge(Layer.succeed(WorklogService.WorklogService, mockWorklog)),
    );

    const result = yield* Effect.gen(function* () {
      const toolkit = yield* WorklogToolkit;
      return yield* toolkit
        .handle("worklog_query_local", { filter: { includePeers: true, limit: 10 } })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
        );
    }).pipe(Effect.provide(layer));

    expect(result).toEqual({ entries: [] });
    expect(seenFilters).toEqual([{ includePeers: false }]);
  }),
);

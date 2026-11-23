import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import Migration0109 from "../../../persistence/Migrations/109_RepoMonitors.ts";
import * as RepoMonitorService from "../../../repoMonitor/RepoMonitorService.ts";
import * as RepoMonitorStore from "../../../repoMonitor/RepoMonitorStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { layer as repoMonitorHandlersLayer } from "./handlers.ts";
import { RepoMonitorToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("proj-mcp-1");
const ENV_ID = EnvironmentId.make("env-local");

const mockInvocationLayer = Layer.succeed(McpInvocationContext.McpInvocationContext, {
  environmentId: ENV_ID,
  requestNamespace: "test-ns",
  issuedAt: 0,
  thread: undefined,
  capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
  client: {
    sessionId: "test-session",
    label: "test-client",
    access: "full-access",
    linked: false,
  },
});

const mockThreadManagementLayer = Layer.succeed(
  ThreadManagementService.ThreadManagementService,
  ThreadManagementService.ThreadManagementService.of({
    getThreadShell: () => Effect.succeed(null),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
);

const storeLayer = RepoMonitorStore.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const serviceLayer = RepoMonitorService.layer({
  snapshotProvider: (projectId) =>
    Effect.succeed({
      projectId,
      observedAt: "2026-11-22T12:00:00Z",
      branches: [{ name: "main", headSha: "sha-main-99" }],
      pullRequests: [],
      issues: [
        {
          key: "55",
          title: "New bug report",
          body: "Details for issue 55",
          stateCategory: "open",
          authorLogin: "user-1",
          labels: ["bug"],
          createdAt: "2026-11-22T11:59:00Z",
          updatedAt: "2026-11-22T11:59:00Z",
        },
      ],
    }),
}).pipe(Layer.provideMerge(storeLayer), Layer.provideMerge(NodeCrypto.layer));

const testLayer = McpToolAccess.HandlersLayer.layer(repoMonitorHandlersLayer).pipe(
  Layer.provideMerge(serviceLayer),
  Layer.provideMerge(mockInvocationLayer),
  Layer.provideMerge(mockThreadManagementLayer),
);

describe("RepoMonitorToolkit MCP tools", () => {
  it("exports concise provider-compatible schemas for all repo monitor tools", () => {
    for (const tool of Object.values(RepoMonitorToolkit.tools)) {
      const schema = Tool.getJsonSchema(tool) as {
        readonly type?: unknown;
        readonly anyOf?: unknown;
        readonly oneOf?: unknown;
      };
      assert.strictEqual(schema.type, "object");
      assert.isUndefined(schema.anyOf);
      assert.isUndefined(schema.oneOf);
      assert.isAtMost((tool.description ?? "").length, 100);
    }
  });

  it.effect("lists presets, rules, dry-run results, and events through MCP handlers", () =>
    Effect.gen(function* () {
      yield* Migration0109;
      const service = yield* RepoMonitorService.RepoMonitorService;
      const rule = yield* service.upsertRule({
        projectId: PROJECT_ID,
        name: TrimmedNonEmptyString.make("Notify PM on new issue"),
        enabled: true,
        eventKinds: ["issue_opened"],
        filter: { excludeBots: true },
        actionKind: "notify_pm",
        promptTemplate: TrimmedNonEmptyString.make("New issue #{{issue.key}}: {{title}}"),
        cooldownSec: NonNegativeInt.make(0),
        maxTriggersPerHour: PositiveInt.make(20),
      });

      const toolkit = yield* RepoMonitorToolkit;
      const callTool = <Name extends keyof typeof RepoMonitorToolkit.tools>(
        name: Name,
        params: Parameters<typeof toolkit.handle<Name>>[1],
      ) =>
        toolkit.handle(name, params).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
        );

      const presetsOut = yield* callTool("repo_monitor_list_presets", {});
      assert.isTrue(presetsOut !== undefined && "presets" in presetsOut);
      if (presetsOut && "presets" in presetsOut) {
        assert.strictEqual(presetsOut.presets.length, 4);
      }

      const rulesOut = yield* callTool("repo_monitor_list_rules", {
        projectId: PROJECT_ID,
      });
      assert.isTrue(rulesOut !== undefined && "rules" in rulesOut);
      if (rulesOut && "rules" in rulesOut) {
        assert.strictEqual(rulesOut.rules.length, 1);
        assert.strictEqual(rulesOut.rules[0]!.id, rule.id);
      }

      const dryRunOut = yield* callTool("repo_monitor_dry_run", {
        projectId: PROJECT_ID,
        ruleId: rule.id,
      });
      assert.isTrue(dryRunOut !== undefined && "results" in dryRunOut);
      if (dryRunOut && "results" in dryRunOut) {
        assert.strictEqual(dryRunOut.results.length, 1);
        assert.strictEqual(dryRunOut.results[0]!.matchedEvents.length, 1);
      }

      yield* service.pollProject({
        projectId: PROJECT_ID,
        emitOnInitialCursor: true,
      });

      const eventsOut = yield* callTool("repo_monitor_list_events", {
        projectId: PROJECT_ID,
      });
      assert.isTrue(eventsOut !== undefined && "events" in eventsOut);
      if (eventsOut && "events" in eventsOut) {
        assert.strictEqual(eventsOut.events.length, 1);
        assert.strictEqual(eventsOut.events[0]!.outcome, "triggered");
      }
    }).pipe(Effect.provide(testLayer)),
  );
});

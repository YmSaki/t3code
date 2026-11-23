import { assert, describe, it } from "@effect/vitest";
import {
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RepoMonitorEventId,
  type RepoMonitorEventRecord,
  type RepoMonitorRule,
  RepoMonitorRuleId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import Migration0109 from "../persistence/Migrations/109_RepoMonitors.ts";
import { RepoMonitorStore, layer as repoMonitorStoreLayer } from "./RepoMonitorStore.ts";

const testLayer = repoMonitorStoreLayer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const PROJECT_ID = ProjectId.make("proj-1");
const RULE_ID = RepoMonitorRuleId.make("rule-1");

const sampleRule: RepoMonitorRule = {
  id: RULE_ID,
  projectId: PROJECT_ID,
  name: TrimmedNonEmptyString.make("Watch PR comments"),
  description: "Auto reply to PR review comments",
  enabled: true,
  eventKinds: ["pr_comment"],
  filter: {
    branchGlobs: [TrimmedNonEmptyString.make("feature/**")],
    excludeBots: true,
  },
  actionKind: "launch_thread",
  targetThreadId: null,
  runtimeMode: "auto-accept-edits",
  promptTemplate: TrimmedNonEmptyString.make("Review {{body}}"),
  cooldownSec: NonNegativeInt.make(60),
  maxTriggersPerHour: PositiveInt.make(10),
  presetId: TrimmedNonEmptyString.make("pr_review_comment_autofix"),
  createdAt: "2026-11-22T10:00:00Z",
  updatedAt: "2026-11-22T10:00:00Z",
};

describe("RepoMonitorStore", () => {
  it.effect("manages rules and cursors in SQLite", () =>
    Effect.gen(function* () {
      yield* Migration0109;
      const store = yield* RepoMonitorStore;

      yield* store.putRule(sampleRule);
      const fetched = yield* store.getRule(RULE_ID);
      assert.deepStrictEqual(fetched, sampleRule);

      const list = yield* store.listRules(PROJECT_ID);
      assert.strictEqual(list.length, 1);

      const updatedRule: RepoMonitorRule = {
        ...sampleRule,
        enabled: false,
        updatedAt: "2026-11-22T10:05:00Z",
      };
      yield* store.putRule(updatedRule);
      assert.strictEqual((yield* store.getRule(RULE_ID))?.enabled, false);

      const cursor = {
        projectId: PROJECT_ID,
        branchHeads: {
          [TrimmedNonEmptyString.make("main")]: TrimmedNonEmptyString.make("sha-1"),
        },
        knownPullRequestNumbers: [PositiveInt.make(10)],
        mergedPullRequestNumbers: [],
        knownPullRequestCommentIds: [TrimmedNonEmptyString.make("c-1")],
        knownIssueKeys: [TrimmedNonEmptyString.make("100")],
        knownIssueCommentIds: [],
        updatedAt: "2026-11-22T10:05:00Z",
      };
      yield* store.putCursor(cursor);
      assert.deepStrictEqual(yield* store.getCursor(PROJECT_ID), cursor);

      assert.isTrue(yield* store.deleteRule(RULE_ID));
      assert.isNull(yield* store.getRule(RULE_ID));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "deduplicates events by (rule_id, dedupe_key) and aggregates trigger window stats",
    () =>
      Effect.gen(function* () {
        yield* Migration0109;
        const store = yield* RepoMonitorStore;

        const event1: RepoMonitorEventRecord = {
          id: RepoMonitorEventId.make("evt-1"),
          ruleId: RULE_ID,
          projectId: PROJECT_ID,
          eventKind: "pr_comment",
          dedupeKey: TrimmedNonEmptyString.make("proj-1:rule-1:pr_comment:10:c-2"),
          summary: TrimmedNonEmptyString.make("Comment on PR #10"),
          authorLogin: TrimmedNonEmptyString.make("alice"),
          isBot: false,
          branch: TrimmedNonEmptyString.make("feature/a"),
          commitSha: null,
          pullRequestNumber: PositiveInt.make(10),
          issueKey: null,
          commentId: TrimmedNonEmptyString.make("c-2"),
          url: TrimmedNonEmptyString.make("https://github.com/org/repo/pull/10"),
          outcome: "triggered",
          dispatchedThreadId: null,
          renderedPrompt: "Rendered prompt",
          occurredAt: "2026-11-22T10:10:00Z",
        };

        const firstRecord = yield* store.recordEvent(event1);
        assert.isTrue(firstRecord.inserted);
        assert.isTrue(yield* store.hasDedupeKey(RULE_ID, event1.dedupeKey));

        const duplicateRecord = yield* store.recordEvent({
          ...event1,
          id: RepoMonitorEventId.make("evt-2"),
        });
        assert.isFalse(duplicateRecord.inserted);
        assert.strictEqual(duplicateRecord.event.id, event1.id);

        const event2: RepoMonitorEventRecord = {
          ...event1,
          id: RepoMonitorEventId.make("evt-3"),
          dedupeKey: TrimmedNonEmptyString.make("proj-1:rule-1:pr_comment:10:c-3"),
          occurredAt: "2026-11-22T10:30:00Z",
        };
        yield* store.recordEvent(event2);

        const stats = yield* store.getTriggerWindowStats({
          ruleId: RULE_ID,
          sinceIso: "2026-11-22T10:15:00Z",
        });
        assert.strictEqual(stats.lastTriggeredAt, "2026-11-22T10:30:00Z");
        assert.strictEqual(stats.countInWindow, 1);
        assert.deepStrictEqual(stats.recentTriggeredAt, ["2026-11-22T10:30:00Z"]);
      }).pipe(Effect.provide(testLayer)),
  );
});

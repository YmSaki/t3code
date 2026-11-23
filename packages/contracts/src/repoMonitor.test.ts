import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  RepoMonitorActionKind,
  RepoMonitorCursor,
  RepoMonitorDryRunResult,
  RepoMonitorError,
  RepoMonitorEventKind,
  RepoMonitorEventRecord,
  RepoMonitorFilter,
  RepoMonitorRule,
  RepoMonitorRuleId,
} from "./repoMonitor.ts";

const decodeRule = Schema.decodeUnknownSync(RepoMonitorRule);
const decodeCursor = Schema.decodeUnknownSync(RepoMonitorCursor);
const decodeEventRecord = Schema.decodeUnknownSync(RepoMonitorEventRecord);
const decodeDryRunResult = Schema.decodeUnknownSync(RepoMonitorDryRunResult);
const decodeFilter = Schema.decodeUnknownSync(RepoMonitorFilter);
const decodeEventKind = Schema.decodeUnknownSync(RepoMonitorEventKind);
const decodeActionKind = Schema.decodeUnknownSync(RepoMonitorActionKind);
const decodeRuleId = Schema.decodeSync(RepoMonitorRuleId);

describe("repoMonitor contracts", () => {
  it("validates event kinds and action kinds", () => {
    for (const kind of [
      "branch_push",
      "pr_opened",
      "pr_merged",
      "pr_comment",
      "issue_opened",
      "issue_comment",
    ]) {
      expect(decodeEventKind(kind)).toBe(kind);
    }
    expect(() => decodeEventKind("pr_closed")).toThrow();

    for (const action of ["notify_pm", "launch_thread", "send_to_thread"]) {
      expect(decodeActionKind(action)).toBe(action);
    }
    expect(() => decodeActionKind("delete_branch")).toThrow();
  });

  it("decodes RepoMonitorFilter and rejects blank entries", () => {
    expect(
      decodeFilter({
        branchGlobs: [" main ", "feature/*"],
        requiredLabels: ["bug"],
        excludedLabels: ["wontfix"],
        allowedAuthors: ["alice"],
        excludedAuthors: ["evil-bot"],
        excludeBots: true,
        keywords: ["urgent"],
      }),
    ).toEqual({
      branchGlobs: ["main", "feature/*"],
      requiredLabels: ["bug"],
      excludedLabels: ["wontfix"],
      allowedAuthors: ["alice"],
      excludedAuthors: ["evil-bot"],
      excludeBots: true,
      keywords: ["urgent"],
    });

    expect(() => decodeFilter({ branchGlobs: ["   "] })).toThrow();
  });

  it("decodes RepoMonitorRule and enforces non-empty eventKinds and positive rate limits", () => {
    const validRule = {
      id: "rule-1",
      projectId: "proj-1",
      environmentId: "env-1",
      name: "Auto respond to PR review comments",
      enabled: true,
      eventKinds: ["pr_comment"],
      filter: {
        branchGlobs: ["feature/**"],
        excludeBots: true,
      },
      actionKind: "launch_thread",
      targetThreadId: null,
      runtimeMode: "auto-accept-edits",
      promptTemplate: "Handle review comment on PR #{{pr.number}}: {{body}}",
      cooldownSec: 60,
      maxTriggersPerHour: 10,
      presetId: "pr_review_comment_autofix",
      createdAt: "2026-11-22T10:00:00Z",
      updatedAt: "2026-11-22T10:00:00Z",
    };

    const decoded = decodeRule(validRule);
    expect(decoded.id).toBe(decodeRuleId("rule-1"));
    expect(decoded.cooldownSec).toBe(60);
    expect(decoded.maxTriggersPerHour).toBe(10);

    expect(() => decodeRule({ ...validRule, eventKinds: [] })).toThrow();
    expect(() => decodeRule({ ...validRule, cooldownSec: -1 })).toThrow();
    expect(() => decodeRule({ ...validRule, maxTriggersPerHour: 0 })).toThrow();
    expect(() => decodeRule({ ...validRule, name: "   " })).toThrow();
  });

  it("decodes RepoMonitorCursor, RepoMonitorEventRecord, and RepoMonitorDryRunResult", () => {
    const cursor = decodeCursor({
      projectId: "proj-1",
      branchHeads: { main: "abc1234" },
      knownPullRequestNumbers: [1, 2],
      mergedPullRequestNumbers: [1],
      knownPullRequestCommentIds: ["c-10"],
      knownIssueKeys: ["42"],
      knownIssueCommentIds: ["ic-99"],
      updatedAt: "2026-11-22T10:05:00Z",
    });
    expect(cursor.branchHeads.main).toBe("abc1234");
    expect(() =>
      decodeCursor({
        ...cursor,
        knownPullRequestNumbers: [0],
      }),
    ).toThrow();

    const record = decodeEventRecord({
      id: "evt-1",
      ruleId: "rule-1",
      projectId: "proj-1",
      eventKind: "pr_comment",
      dedupeKey: "proj-1:rule-1:pr_comment:2:c-11",
      summary: "New review comment on PR #2",
      authorLogin: "reviewer",
      isBot: false,
      branch: "feature/auth",
      pullRequestNumber: 2,
      commentId: "c-11",
      url: "https://github.com/org/repo/pull/2#discussion_r11",
      outcome: "dry_run",
      renderedPrompt: "Prompt body",
      occurredAt: "2026-11-22T10:06:00Z",
    });
    expect(record.outcome).toBe("dry_run");

    const dryRun = decodeDryRunResult({
      ruleId: "rule-1",
      projectId: "proj-1",
      evaluatedAt: "2026-11-22T10:06:00Z",
      matchedEvents: [record],
      nextCursor: cursor,
      renderedPrompts: ["Prompt body"],
      skippedCount: 2,
    });
    expect(dryRun.matchedEvents).toHaveLength(1);
    expect(dryRun.skippedCount).toBe(2);

    const err = new RepoMonitorError({
      message: "Failed to poll repository",
      ruleId: decodeRuleId("rule-1"),
    });
    expect(err._tag).toBe("RepoMonitorError");
  });
});

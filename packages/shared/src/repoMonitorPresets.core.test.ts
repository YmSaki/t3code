import { describe, expect, it } from "vite-plus/test";
import type { ProjectId, ThreadId } from "@t3tools/contracts";

import { renderRepoMonitorPrompt } from "./repoMonitorPrompt.core.ts";
import {
  createRepoMonitorRuleFromPreset,
  getRepoMonitorPreset,
  listRepoMonitorPresets,
} from "./repoMonitorPresets.core.ts";

const PROJECT_ID = "proj-1" as ProjectId;
const THREAD_ID = "thread-pm-1" as ThreadId;

describe("repoMonitorPresets", () => {
  it("exposes all four built-in presets with expected eventKinds and actionKinds", () => {
    const presets = listRepoMonitorPresets();
    expect(presets.map((p) => p.id)).toEqual([
      "pr_review_comment_autofix",
      "new_issue_notify_pm",
      "main_merge_verification",
      "branch_push_review",
    ]);

    expect(getRepoMonitorPreset("pr_review_comment_autofix")?.eventKinds).toEqual(["pr_comment"]);
    expect(getRepoMonitorPreset("new_issue_notify_pm")?.actionKind).toBe("notify_pm");
    expect(getRepoMonitorPreset("main_merge_verification")?.defaultFilter.branchGlobs).toEqual([
      "main",
    ]);
    expect(getRepoMonitorPreset("branch_push_review")?.defaultFilter.branchGlobs).toEqual([
      "feature/**",
      "fix/**",
    ]);
    expect(getRepoMonitorPreset("non_existent")).toBeUndefined();
  });

  it("creates rules from presets, applies overrides, and isolates filter arrays", () => {
    const rule = createRepoMonitorRuleFromPreset({
      presetId: "new_issue_notify_pm",
      id: "rule-issue-1",
      projectId: PROJECT_ID,
      createdAt: "2026-11-22T10:00:00Z",
      overrides: {
        targetThreadId: THREAD_ID,
        filter: {
          requiredLabels: ["bug"],
        },
        cooldownSec: 30,
      },
    });

    expect(rule).toMatchObject({
      id: "rule-issue-1",
      projectId: PROJECT_ID,
      name: "新規IssueをPMへ起票通知",
      enabled: true,
      eventKinds: ["issue_opened"],
      actionKind: "notify_pm",
      targetThreadId: THREAD_ID,
      cooldownSec: 30,
      maxTriggersPerHour: 30,
      presetId: "new_issue_notify_pm",
      filter: {
        excludeBots: true,
        requiredLabels: ["bug"],
      },
    });

    const rendered = renderRepoMonitorPrompt(
      rule.promptTemplate,
      {
        kind: "issue_opened",
        issueKey: "123",
        title: "Login button broken",
        authorLogin: "alice",
        labels: ["bug"],
        url: "https://github.com/org/repo/issues/123",
        body: "Clicking login throws error",
      },
      "f1",
    );
    expect(rendered.missing).toEqual([]);
    expect(rendered.prompt).toContain("<monitor-data-f1>123</monitor-data-f1>");
  });
});

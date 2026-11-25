import { describe, expect, it } from "vite-plus/test";

import {
  ONE_HOUR_MS,
  buildRepoMonitorDedupeKey,
  detectRepoMonitorAgentLoop,
  evaluateRepoMonitorCooldown,
  evaluateRepoMonitorGuard,
  evaluateRepoMonitorHourlyRateLimit,
  type RepoMonitorGuardEventInput,
} from "./repoMonitorGuard.core.ts";

const NOW_MS = 1_700_000_000_000;

const baseEvent: RepoMonitorGuardEventInput = {
  projectId: "proj-1",
  ruleId: "rule-1",
  kind: "pr_comment",
  pullRequestNumber: 42,
  commentId: "c-100",
  authorLogin: "reviewer-alice",
  title: "Add input validation",
  body: "Please check bounds on line 50.",
};

describe("buildRepoMonitorDedupeKey", () => {
  it("generates deterministic keys per event kind", () => {
    expect(buildRepoMonitorDedupeKey(baseEvent)).toBe("proj-1:rule-1:pr_comment:42:c-100");
    expect(
      buildRepoMonitorDedupeKey({
        projectId: "proj-1",
        ruleId: "rule-1",
        kind: "branch_push",
        branch: "feature/auth",
        commitSha: "abc1234",
      }),
    ).toBe("proj-1:rule-1:branch_push:feature/auth:abc1234");
    expect(
      buildRepoMonitorDedupeKey({
        projectId: "proj-1",
        ruleId: "rule-1",
        kind: "issue_opened",
        issueKey: "ENG-99",
      }),
    ).toBe("proj-1:rule-1:issue_opened:ENG-99");
  });
});

describe("detectRepoMonitorAgentLoop", () => {
  it("blocks events from self account, T3 managed agents, or agent loop markers", () => {
    expect(
      detectRepoMonitorAgentLoop({
        authorLogin: "My-Own-User",
        selfAccountLogins: ["my-own-user"],
      }),
    ).toEqual({ isLoop: true, reason: "self_account" });

    expect(
      detectRepoMonitorAgentLoop({
        authorLogin: "t3-worker-bot",
        managedAgentLogins: ["T3-Worker-Bot"],
      }),
    ).toEqual({ isLoop: true, reason: "t3_managed_agent" });

    expect(
      detectRepoMonitorAgentLoop({
        authorLogin: "someone",
        originatedByT3Agent: true,
      }),
    ).toEqual({ isLoop: true, reason: "t3_managed_agent" });

    expect(
      detectRepoMonitorAgentLoop({
        authorLogin: "external-user",
        body: "Automated reply\n<!-- t3-repo-monitor -->",
      }),
    ).toEqual({ isLoop: true, reason: "agent_marker" });

    expect(
      detectRepoMonitorAgentLoop({
        authorLogin: "external-user",
        body: "Normal review comment",
        selfAccountLogins: ["my-own-user"],
        managedAgentLogins: ["t3-worker-bot"],
      }),
    ).toEqual({ isLoop: false, reason: null });

    expect(detectRepoMonitorAgentLoop({ authorLogin: "anyone", selfAccountLogins: null })).toEqual({
      isLoop: true,
      reason: "self_account_unknown",
    });

    expect(detectRepoMonitorAgentLoop({ authorLogin: null, selfAccountLogins: null })).toEqual({
      isLoop: false,
      reason: null,
    });
  });
});

describe("evaluateRepoMonitorCooldown & evaluateRepoMonitorHourlyRateLimit", () => {
  it("computes remaining cooldown accurately from nowMs", () => {
    expect(
      evaluateRepoMonitorCooldown({
        lastTriggeredAtMs: NOW_MS - 20_000,
        cooldownSec: 60,
        nowMs: NOW_MS,
      }),
    ).toEqual({ active: true, remainingMs: 40_000 });

    expect(
      evaluateRepoMonitorCooldown({
        lastTriggeredAtMs: NOW_MS - 60_000,
        cooldownSec: 60,
        nowMs: NOW_MS,
      }),
    ).toEqual({ active: false, remainingMs: 0 });
  });

  it("counts only triggers within the trailing 1-hour window", () => {
    const timestamps = [
      NOW_MS - ONE_HOUR_MS - 1,
      NOW_MS - ONE_HOUR_MS,
      NOW_MS - 30 * 60_000,
      NOW_MS - 5 * 60_000,
      NOW_MS,
    ];

    expect(
      evaluateRepoMonitorHourlyRateLimit({
        recentTriggerTimestampsMs: timestamps,
        maxTriggersPerHour: 3,
        nowMs: NOW_MS,
      }),
    ).toEqual({
      exceeded: true,
      triggersInWindow: 3,
      maxTriggersPerHour: 3,
    });

    expect(
      evaluateRepoMonitorHourlyRateLimit({
        recentTriggerTimestampsMs: timestamps,
        maxTriggersPerHour: 4,
        nowMs: NOW_MS,
      }),
    ).toEqual({
      exceeded: false,
      triggersInWindow: 3,
      maxTriggersPerHour: 4,
    });
  });
});

describe("evaluateRepoMonitorGuard", () => {
  it("enforces kill switch, rule enabled, loop exclusion, dedupe, cooldown, and hourly rate limit", () => {
    const baseGuardInput = {
      globalKillSwitch: false,
      ruleEnabled: true,
      event: baseEvent,
      selfAccountLogins: ["self-user"],
      managedAgentLogins: ["t3-bot"],
      cooldownSec: 60,
      maxTriggersPerHour: 5,
      nowMs: NOW_MS,
    };

    expect(evaluateRepoMonitorGuard(baseGuardInput)).toEqual({
      allowed: true,
      outcome: "triggered",
      dedupeKey: "proj-1:rule-1:pr_comment:42:c-100",
      loopReason: null,
      remainingCooldownMs: 0,
      triggersInLastHour: 0,
    });

    expect(
      evaluateRepoMonitorGuard({
        ...baseGuardInput,
        globalKillSwitch: true,
      }).outcome,
    ).toBe("skipped_kill_switch");

    expect(
      evaluateRepoMonitorGuard({
        ...baseGuardInput,
        ruleEnabled: false,
      }).outcome,
    ).toBe("skipped_disabled");

    expect(
      evaluateRepoMonitorGuard({
        ...baseGuardInput,
        event: { ...baseEvent, authorLogin: "self-user" },
      }).outcome,
    ).toBe("skipped_loop_guard");

    expect(evaluateRepoMonitorGuard({ ...baseGuardInput, selfAccountLogins: null })).toMatchObject({
      allowed: false,
      loopReason: "self_account_unknown",
    });

    expect(
      evaluateRepoMonitorGuard({
        ...baseGuardInput,
        seenDedupeKeys: new Set(["proj-1:rule-1:pr_comment:42:c-100"]),
      }).outcome,
    ).toBe("skipped_dedupe");

    expect(
      evaluateRepoMonitorGuard({
        ...baseGuardInput,
        lastTriggeredAtMs: NOW_MS - 15_000,
      }),
    ).toMatchObject({
      allowed: false,
      outcome: "skipped_cooldown",
      remainingCooldownMs: 45_000,
    });

    expect(
      evaluateRepoMonitorGuard({
        ...baseGuardInput,
        maxTriggersPerHour: 2,
        recentTriggerTimestampsMs: [NOW_MS - 120_000, NOW_MS - 90_000],
      }),
    ).toMatchObject({
      allowed: false,
      outcome: "skipped_rate_limit",
      triggersInLastHour: 2,
    });
  });
});

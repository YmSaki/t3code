import { describe, expect, it } from "vite-plus/test";

import {
  buildPushNotificationDedupeKey,
  evaluatePushNotificationPolicy,
  isWithinQuietHours,
} from "./pushNotificationPolicy.core.ts";

describe("pushNotificationPolicy.core", () => {
  it("evaluatesapproval, question, PM completion, and RepoMonitor events with formatted titles and bodies", () => {
    const approvalDecision = evaluatePushNotificationPolicy({
      event: {
        kind: "approval_requested",
        occurredAt: "2026-11-22T05:00:00.000Z",
        environmentId: "env-1",
        projectId: "proj-1",
        projectTitle: "T3 Code",
        threadId: "thread-1",
        threadTitle: "Refactor DB",
        requestId: "req-42",
        provider: "codex",
        commandOrToolName: "bash: rm -rf dist",
        summary: "Allow deleting dist folder before build?",
      },
      settings: {
        enabled: true,
      },
    });

    expect(approvalDecision.shouldSend).toBe(true);
    expect(approvalDecision.reason).toBe("allowed");
    expect(approvalDecision.priority).toBe("high");
    expect(approvalDecision.title).toBe("[cx] T3 Code: Approval Required (bash: rm -rf dist)");
    expect(approvalDecision.body).toBe("Allow deleting dist folder before build?");
    expect(approvalDecision.dedupeKey).toBe(
      "push:approval_requested:env-1:proj-1:thread-1:req-42",
    );

    const questionDecision = evaluatePushNotificationPolicy({
      event: {
        kind: "question_requested",
        occurredAt: "2026-11-22T05:05:00.000Z",
        projectTitle: "T3 Code",
        threadId: "thread-2",
        requestId: "q-1",
        provider: "claudeAgent",
        questionText: "Which database migration strategy should we use?",
      },
      settings: { enabled: true },
    });
    expect(questionDecision.shouldSend).toBe(true);
    expect(questionDecision.title).toBe("[cl] T3 Code: Question from Agent");
    expect(questionDecision.body).toBe("Which database migration strategy should we use?");

    const pmDecision = evaluatePushNotificationPolicy({
      event: {
        kind: "pm_completed",
        occurredAt: "2026-11-22T06:00:00.000Z",
        projectTitle: "T3 Code",
        threadId: "thread-pm",
        runId: "run-pm-1",
        provider: "codex",
        summary: "All 5 worker tasks completed and verified.",
      },
      settings: { enabled: true },
    });
    expect(pmDecision.shouldSend).toBe(true);
    expect(pmDecision.priority).toBe("normal");
    expect(pmDecision.title).toBe("[cx] T3 Code: PM Task Completed");

    const monitorDecision = evaluatePushNotificationPolicy({
      event: {
        kind: "repo_monitor_triggered",
        occurredAt: "2026-11-22T06:10:00.000Z",
        projectTitle: "T3 Code",
        monitorRuleName: "PR Review Auto-Triage",
        findingSummary: "New review comment on PR #512",
      },
      settings: { enabled: true },
    });
    expect(monitorDecision.shouldSend).toBe(true);
    expect(monitorDecision.title).toBe("T3 Code: Repo Monitor Triggered: PR Review Auto-Triage");
    expect(monitorDecision.body).toBe("New review comment on PR #512");
  });

  it("blocks notifications when globally disabled or when the event kind is disabled", () => {
    const event = {
      kind: "pm_completed" as const,
      occurredAt: "2026-11-22T06:00:00.000Z",
      threadId: "thread-1",
    };

    expect(
      evaluatePushNotificationPolicy({
        event,
        settings: { enabled: false },
      }).reason,
    ).toBe("disabled_globally");

    expect(
      evaluatePushNotificationPolicy({
        event,
        settings: {
          enabled: true,
          enabledKinds: ["approval_requested", "question_requested"],
        },
      }).reason,
    ).toBe("disabled_kind");

    expect(
      evaluatePushNotificationPolicy({
        event,
        settings: {
          enabled: true,
          enabledKinds: { pm_completed: false },
        },
      }).reason,
    ).toBe("disabled_kind");
  });

  it("handles same-day and cross-midnight quiet hours in the configured timezone", () => {
    // Overnight quiet hours: 22:00 to 07:00 in Asia/Tokyo (UTC+9)
    // 2026-11-22T14:30:00.000Z = 23:30 JST (inside quiet hours)
    // 2026-11-22T21:30:00.000Z = 06:30 JST next day (inside quiet hours)
    // 2026-11-22T23:00:00.000Z = 08:00 JST next day (outside quiet hours)
    const overnightQuiet = {
      enabled: true,
      startTime: "22:00",
      endTime: "07:00",
      timeZone: "Asia/Tokyo",
    };

    expect(isWithinQuietHours("2026-11-22T14:30:00.000Z", overnightQuiet)).toBe(true);
    expect(isWithinQuietHours("2026-11-22T21:30:00.000Z", overnightQuiet)).toBe(true);
    expect(isWithinQuietHours("2026-11-22T23:00:00.000Z", overnightQuiet)).toBe(false);

    const suppressed = evaluatePushNotificationPolicy({
      event: {
        kind: "pm_completed",
        occurredAt: "2026-11-22T14:30:00.000Z",
        threadId: "thread-quiet",
      },
      settings: {
        enabled: true,
        quietHours: overnightQuiet,
      },
    });
    expect(suppressed.shouldSend).toBe(false);
    expect(suppressed.reason).toBe("quiet_hours");
  });

  it("suppresses duplicate notifications within the debounce window using dedupeKey history", () => {
    const event = {
      kind: "approval_requested" as const,
      occurredAt: "2026-11-22T10:01:00.000Z",
      environmentId: "env-1",
      projectId: "proj-1",
      threadId: "thread-1",
      requestId: "req-99",
    };
    const dedupeKey = buildPushNotificationDedupeKey(event);

    const debounced = evaluatePushNotificationPolicy({
      event,
      settings: {
        enabled: true,
        debounceWindowMs: 120_000, // 2 minutes
      },
      history: [
        {
          dedupeKey,
          sentAt: "2026-11-22T10:00:00.000Z", // 60s earlier -> within 120s window
        },
      ],
    });

    expect(debounced.shouldSend).toBe(false);
    expect(debounced.reason).toBe("debounced");

    const allowedAfterWindow = evaluatePushNotificationPolicy({
      event: {
        ...event,
        occurredAt: "2026-11-22T10:03:00.000Z", // 180s later -> outside 120s window
      },
      settings: {
        enabled: true,
        debounceWindowMs: 120_000,
      },
      history: [
        {
          dedupeKey,
          sentAt: "2026-11-22T10:00:00.000Z",
        },
      ],
    });

    expect(allowedAfterWindow.shouldSend).toBe(true);
    expect(allowedAfterWindow.reason).toBe("allowed");
  });
});

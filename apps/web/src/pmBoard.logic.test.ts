import { EnvironmentId, ProjectId, ThreadId, type PmBoardWorkerSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPmPendingInbox,
  classifyPmWorkerBucket,
  formatPmWorkerElapsed,
  groupPmWorkers,
} from "./pmBoard.logic.ts";

const envId = EnvironmentId.make("env-1");
const projId = ProjectId.make("proj-1");

const worker = (
  id: string,
  status: PmBoardWorkerSummary["status"],
  startedAt: string | null = "2026-11-22T10:00:00.000Z",
): PmBoardWorkerSummary => ({
  threadId: ThreadId.make(id),
  environmentId: envId,
  projectId: projId,
  title: `Task ${id}`,
  status,
  targetRepoRole: "frontend",
  providerInstanceId: null,
  turnCount: 1,
  lastMessagePreview: null,
  startedAt,
  updatedAt: "2026-11-22T10:05:00.000Z",
});

describe("classifyPmWorkerBucket and groupPmWorkers", () => {
  it("groups workers into running, waiting, completed, and failed buckets", () => {
    expect(classifyPmWorkerBucket("queued")).toBe("running");
    expect(classifyPmWorkerBucket("waiting_approval")).toBe("waiting");
    expect(classifyPmWorkerBucket("completed")).toBe("completed");
    expect(classifyPmWorkerBucket("interrupted")).toBe("failed");

    const grouped = groupPmWorkers([
      worker("a", "running"),
      worker("b", "waiting_input"),
      worker("c", "completed"),
      worker("d", "cancelled"),
    ]);
    expect(grouped.running.map((item) => item.threadId)).toEqual(["a"]);
    expect(grouped.waiting.map((item) => item.threadId)).toEqual(["b"]);
    expect(grouped.completed.map((item) => item.threadId)).toEqual(["c"]);
    expect(grouped.failed.map((item) => item.threadId)).toEqual(["d"]);
  });
});

describe("formatPmWorkerElapsed", () => {
  it("formats deterministic elapsed durations without wall-clock access", () => {
    const baseMs = Date.parse("2026-11-22T10:00:00.000Z");
    expect(formatPmWorkerElapsed(null, baseMs)).toBeNull();
    expect(formatPmWorkerElapsed("invalid", baseMs)).toBeNull();
    expect(formatPmWorkerElapsed("2026-11-22T10:00:00.000Z", baseMs + 42_000)).toBe("42s");
    expect(formatPmWorkerElapsed("2026-11-22T10:00:00.000Z", baseMs + 195_000)).toBe("3m 15s");
    expect(formatPmWorkerElapsed("2026-11-22T10:00:00.000Z", baseMs + 5_400_000)).toBe("1h 30m");
  });
});

describe("buildPmPendingInbox", () => {
  it("prioritizes waiting_approval over waiting_input and merges workers missing question text", () => {
    const wInput = worker("w-input", "waiting_input");
    const wApproval = worker("w-approval", "waiting_approval");
    const wSilentApproval = worker("w-silent", "waiting_approval");

    const inbox = buildPmPendingInbox(
      [wInput, wApproval, wSilentApproval],
      [
        {
          workerThreadId: wInput.threadId,
          title: wInput.title,
          status: "waiting_input",
          questions: ["Which port?"],
        },
        {
          workerThreadId: wApproval.threadId,
          title: wApproval.title,
          status: "waiting_approval",
          questions: ["Run migration?"],
        },
      ],
    );

    expect(inbox.map((item) => [item.workerThreadId, item.priority])).toEqual([
      ["w-approval", 0],
      ["w-silent", 0],
      ["w-input", 1],
    ]);
    expect(inbox[0]?.questions).toEqual(["Run migration?"]);
    expect(inbox[1]?.questions).toEqual([]);
  });
});

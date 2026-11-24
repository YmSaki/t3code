import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  PM_MAX_DISPATCH_BATCH_ITEMS,
  PmBoardSnapshot,
  PmDispatchBatchInput,
  PmDispatchBatchResult,
  PmDispatchRejectedError,
  PmKillSwitchActiveError,
  PmWorkerPolicy,
  ThreadRole,
  WorkerContextBrief,
} from "./pm.ts";

const decodeBrief = Schema.decodeUnknownSync(WorkerContextBrief);
const decodePolicy = Schema.decodeUnknownSync(PmWorkerPolicy);
const decodeBatchInput = Schema.decodeUnknownSync(PmDispatchBatchInput);
const decodeBatchResult = Schema.decodeUnknownSync(PmDispatchBatchResult);
const decodeSnapshot = Schema.decodeUnknownSync(PmBoardSnapshot);

const brief = {
  objective: "Add the PM board panel",
  background: "",
  constraints: ["Do not touch the server"],
  relatedFiles: [{ path: "apps/web/src/Board.tsx", lineRange: { start: 1, end: 40 } }],
  completionCriteria: ["Panel renders workers"],
  verificationCommands: ["vp test run apps/web/src/Board.test.tsx"],
};

const policy = {
  maxConcurrentWorkers: 3,
  requireWorktreeIsolation: true,
  allowNestedDelegation: false,
  allowedTargets: [{ environmentId: "env-a", projectId: "project-a" }],
  maxDelegatedTurns: 20,
  directEditSuppressedProviders: ["codex"],
};

describe("ThreadRole", () => {
  it("accepts only known roles", () => {
    const decode = Schema.decodeUnknownSync(ThreadRole);
    for (const role of ["standard", "pm", "worker"]) expect(decode(role)).toBe(role);
    expect(() => decode("cross_cutting")).toThrow();
  });
});

describe("WorkerContextBrief", () => {
  it("trims entries and keeps optional file metadata", () => {
    expect(decodeBrief({ ...brief, objective: "  Add the PM board panel  " })).toEqual(brief);
  });

  it("requires at least one completion criterion", () => {
    expect(() => decodeBrief({ ...brief, completionCriteria: [] })).toThrow();
  });

  it("rejects inverted line ranges", () => {
    expect(() =>
      decodeBrief({
        ...brief,
        relatedFiles: [{ path: "a.ts", lineRange: { start: 10, end: 2 } }],
      }),
    ).toThrow();
  });
});

describe("PmWorkerPolicy", () => {
  it("decodes a full policy", () => {
    expect(decodePolicy(policy)).toEqual(policy);
  });

  it.each([
    ["maxConcurrentWorkers", 0],
    ["maxDelegatedTurns", 0],
    ["maxConcurrentWorkers", 1.5],
  ])("rejects %s = %s", (field, value) => {
    expect(() => decodePolicy({ ...policy, [field]: value })).toThrow();
  });
});

describe("PmDispatchBatchInput", () => {
  const item = { clientKey: "k1", title: "Board", targetRepoRole: "frontend", brief };

  it("decodes a batch", () => {
    expect(decodeBatchInput({ pmThreadId: "pm-1", items: [item] }).items).toHaveLength(1);
  });

  it("rejects empty and oversized batches", () => {
    expect(() => decodeBatchInput({ pmThreadId: "pm-1", items: [] })).toThrow();
    expect(() =>
      decodeBatchInput({
        pmThreadId: "pm-1",
        items: Array.from({ length: PM_MAX_DISPATCH_BATCH_ITEMS + 1 }, (_, index) => ({
          ...item,
          clientKey: `k${index}`,
        })),
      }),
    ).toThrow();
  });

  it("rejects unknown runtime modes", () => {
    expect(() =>
      decodeBatchInput({ pmThreadId: "pm-1", items: [{ ...item, runtimeMode: "yolo" }] }),
    ).toThrow();
  });
});

describe("PmDispatchBatchResult", () => {
  it("decodes accepted and rejected items", () => {
    const result = {
      pmThreadId: "pm-1",
      dispatched: [
        {
          clientKey: "k1",
          threadId: "worker-1",
          environmentId: "env-a",
          projectId: "project-a",
          useWorktree: true,
        },
      ],
      rejected: [{ clientKey: "k2", reason: "concurrency_limit", detail: "3 of 3 running" }],
    };
    expect(decodeBatchResult(result)).toEqual(result);
    expect(() =>
      decodeBatchResult({
        ...result,
        rejected: [{ clientKey: "k2", reason: "nope", detail: "" }],
      }),
    ).toThrow();
  });
});

describe("PmBoardSnapshot", () => {
  it("decodes a snapshot with workers", () => {
    const snapshot = {
      pmThreadId: "pm-1",
      role: "pm",
      metaProjectId: null,
      policy,
      killSwitchActive: false,
      delegatedTurnCount: 4,
      workers: [
        {
          threadId: "worker-1",
          environmentId: "env-a",
          projectId: "project-a",
          title: "Board",
          status: "running",
          targetRepoRole: "frontend",
          providerInstanceId: null,
          turnCount: 2,
          lastMessagePreview: null,
          startedAt: "2026-11-22T10:00:00.000Z",
          updatedAt: "2026-11-22T10:05:00.000Z",
        },
      ],
      generatedAt: "2026-11-22T10:06:00.000Z",
    };
    expect(decodeSnapshot(snapshot)).toEqual(snapshot);
    expect(() =>
      decodeSnapshot({ ...snapshot, workers: [{ ...snapshot.workers[0], status: "idle" }] }),
    ).toThrow();
  });
});

describe("PM errors", () => {
  it("describes the failure", () => {
    expect(new PmKillSwitchActiveError({ scope: "global" }).message).toContain("global");
    expect(
      new PmDispatchRejectedError({ reason: "target_ambiguous", detail: "two frontends" }).message,
    ).toBe("PM dispatch rejected (target_ambiguous): two frontends");
  });
});

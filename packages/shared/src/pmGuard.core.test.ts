import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  evaluateConcurrency,
  evaluateDelegatedTurnBudget,
  evaluateDelegationDepth,
  evaluateDispatchBatch,
  evaluateKillSwitch,
  type PmGuardPolicy,
  type PmGuardRepoMember,
  resolveDispatchTarget,
} from "./pmGuard.core.ts";

const envLocal = EnvironmentId.make("env-local");
const envRemote = EnvironmentId.make("env-remote");
const projWeb = ProjectId.make("proj-web");
const projApi = ProjectId.make("proj-api");
const projMobile = ProjectId.make("proj-mobile");
const projOutside = ProjectId.make("proj-outside");
const pmThreadId = ThreadId.make("thread-pm");
const workerThreadId = ThreadId.make("thread-worker");

const members: ReadonlyArray<PmGuardRepoMember> = [
  { environmentId: envLocal, projectId: projWeb, role: "frontend", name: "web" },
  { environmentId: envRemote, projectId: projApi, role: "backend", name: "api" },
  { environmentId: envLocal, projectId: projMobile, role: "frontend", name: "mobile" },
];

const policy: PmGuardPolicy = {
  maxConcurrentWorkers: 2,
  requireWorktreeIsolation: true,
  allowNestedDelegation: false,
  allowedTargets: [],
  maxDelegatedTurns: 5,
};

describe("evaluateKillSwitch", () => {
  it("blocks when the global or thread switch is on", () => {
    expect(evaluateKillSwitch({ global: true, stoppedThreadIds: new Set() }, pmThreadId)).toEqual({
      ok: false,
      reason: "kill_switch_active",
      detail: expect.stringContaining("global"),
    });
    expect(
      evaluateKillSwitch({ global: false, stoppedThreadIds: new Set([pmThreadId]) }, pmThreadId),
    ).toEqual({
      ok: false,
      reason: "kill_switch_active",
      detail: expect.stringContaining(pmThreadId),
    });
    expect(
      evaluateKillSwitch(
        { global: false, stoppedThreadIds: new Set([workerThreadId]) },
        pmThreadId,
      ),
    ).toEqual({ ok: true, value: undefined });
  });
});

describe("evaluateDelegationDepth", () => {
  it("rejects standard threads and nested workers unless enabled within depth", () => {
    expect(
      evaluateDelegationDepth(
        { threadId: pmThreadId, role: "standard", delegationDepth: 0 },
        false,
      ),
    ).toMatchObject({ ok: false, reason: "requester_not_pm" });

    expect(
      evaluateDelegationDepth(
        { threadId: workerThreadId, role: "worker", delegationDepth: 1 },
        false,
      ),
    ).toMatchObject({ ok: false, reason: "nested_delegation_forbidden" });

    expect(
      evaluateDelegationDepth(
        { threadId: workerThreadId, role: "worker", delegationDepth: 1 },
        true,
        2,
      ),
    ).toEqual({ ok: true, value: { childDepth: 2 } });

    expect(
      evaluateDelegationDepth(
        { threadId: workerThreadId, role: "worker", delegationDepth: 2 },
        true,
        2,
      ),
    ).toMatchObject({ ok: false, reason: "delegation_depth_exceeded" });
  });
});

describe("resolveDispatchTarget", () => {
  it("resolves a unique role, disambiguates by name, and rejects unknown or unauthorized targets", () => {
    expect(
      resolveDispatchTarget({
        request: { targetRepoRole: " BACKEND " },
        members,
        allowedTargets: [],
      }),
    ).toEqual({ ok: true, value: { environmentId: envRemote, projectId: projApi } });

    expect(
      resolveDispatchTarget({
        request: { targetRepoRole: "frontend" },
        members,
        allowedTargets: [],
      }),
    ).toMatchObject({ ok: false, reason: "target_ambiguous" });

    expect(
      resolveDispatchTarget({
        request: { targetRepoRole: "frontend", targetRepoName: "mobile" },
        members,
        allowedTargets: [],
      }),
    ).toEqual({ ok: true, value: { environmentId: envLocal, projectId: projMobile } });

    expect(
      resolveDispatchTarget({
        request: { targetRepoRole: "infra" },
        members,
        allowedTargets: [],
      }),
    ).toMatchObject({ ok: false, reason: "target_unresolved" });

    expect(
      resolveDispatchTarget({
        request: { target: { environmentId: envLocal, projectId: projOutside } },
        members,
        allowedTargets: [],
      }),
    ).toMatchObject({ ok: false, reason: "target_not_allowed" });

    expect(
      resolveDispatchTarget({
        request: { targetRepoName: "mobile" },
        members,
        allowedTargets: [{ environmentId: envLocal, projectId: projWeb }],
      }),
    ).toMatchObject({ ok: false, reason: "target_not_allowed" });
  });
});

describe("concurrency and turn budgets", () => {
  it("counts remaining slots and rejects at zero", () => {
    expect(evaluateConcurrency(1, 3)).toEqual({ ok: true, value: { remainingSlots: 2 } });
    expect(evaluateConcurrency(3, 3)).toMatchObject({ ok: false, reason: "concurrency_limit" });
    expect(evaluateDelegatedTurnBudget(4, 5)).toEqual({ ok: true, value: { remainingTurns: 1 } });
    expect(evaluateDelegatedTurnBudget(5, 5)).toMatchObject({
      ok: false,
      reason: "delegated_turn_limit",
    });
  });
});

describe("evaluateDispatchBatch", () => {
  const baseBatch = {
    requester: { threadId: pmThreadId, role: "pm" as const, delegationDepth: 0 },
    killSwitch: { global: false, stoppedThreadIds: new Set<ThreadId>() },
    policy,
    members,
    activeWorkerCount: 1,
    delegatedTurnCount: 3,
  };

  it("rejects the whole batch when a thread-level gate fails", () => {
    const decision = evaluateDispatchBatch({
      ...baseBatch,
      killSwitch: { global: true, stoppedThreadIds: new Set() },
      items: [
        { clientKey: "a", targetRepoRole: "backend" },
        { clientKey: "b", targetRepoName: "web" },
      ],
    });
    expect(decision.accepted).toEqual([]);
    expect(decision.rejected.map((entry) => [entry.clientKey, entry.reason])).toEqual([
      ["a", "kill_switch_active"],
      ["b", "kill_switch_active"],
    ]);
  });

  it("consumes slots across items and surfaces item-specific rejections", () => {
    const decision = evaluateDispatchBatch({
      ...baseBatch,
      items: [
        { clientKey: "dup", targetRepoName: "web", useWorktree: false },
        { clientKey: "dup", targetRepoName: "web" },
        { clientKey: "bad-target", targetRepoRole: "frontend" },
        { clientKey: "ok-1", targetRepoRole: "backend" },
        { clientKey: "over-cap", targetRepoName: "web" },
      ],
    });
    expect(decision.accepted).toEqual([
      {
        clientKey: "ok-1",
        environmentId: envRemote,
        projectId: projApi,
        useWorktree: true,
      },
    ]);
    expect(decision.rejected.map((entry) => [entry.clientKey, entry.reason])).toEqual([
      ["dup", "worktree_required"],
      ["dup", "duplicate_client_key"],
      ["bad-target", "target_ambiguous"],
      ["over-cap", "concurrency_limit"],
    ]);
  });

  it("stops when the delegated turn ceiling is reached before concurrency", () => {
    const decision = evaluateDispatchBatch({
      ...baseBatch,
      activeWorkerCount: 0,
      delegatedTurnCount: 4,
      items: [
        { clientKey: "one", targetRepoName: "web" },
        { clientKey: "two", targetRepoRole: "backend" },
      ],
    });
    expect(decision.accepted.map((entry) => entry.clientKey)).toEqual(["one"]);
    expect(decision.rejected.map((entry) => [entry.clientKey, entry.reason])).toEqual([
      ["two", "delegated_turn_limit"],
    ]);
  });
});

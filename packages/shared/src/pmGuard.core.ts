import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

export type PmThreadRole = "standard" | "pm" | "worker";

export type PmGuardRejectionReason =
  | "requester_not_pm"
  | "kill_switch_active"
  | "nested_delegation_forbidden"
  | "delegation_depth_exceeded"
  | "concurrency_limit"
  | "delegated_turn_limit"
  | "duplicate_client_key"
  | "target_unresolved"
  | "target_ambiguous"
  | "target_not_allowed"
  | "worktree_required";

export interface PmGuardRejection {
  readonly ok: false;
  readonly reason: PmGuardRejectionReason;
  readonly detail: string;
}

export type PmGuardResult<A> = { readonly ok: true; readonly value: A } | PmGuardRejection;

export interface PmGuardTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface PmGuardRepoMember extends PmGuardTarget {
  readonly role: string;
  readonly name: string;
}

export interface PmGuardPolicy {
  readonly maxConcurrentWorkers: number;
  readonly requireWorktreeIsolation: boolean;
  readonly allowNestedDelegation: boolean;
  readonly allowedTargets: ReadonlyArray<PmGuardTarget>;
  readonly maxDelegatedTurns: number;
}

export interface PmKillSwitchState {
  readonly global: boolean;
  readonly stoppedThreadIds: ReadonlySet<ThreadId>;
}

export interface PmRequester {
  readonly threadId: ThreadId;
  readonly role: PmThreadRole;
  readonly delegationDepth: number;
}

export interface PmTargetRequest {
  readonly targetRepoRole?: string | undefined;
  readonly targetRepoName?: string | undefined;
  readonly target?: PmGuardTarget | undefined;
}

export interface PmGuardBatchItem extends PmTargetRequest {
  readonly clientKey: string;
  readonly useWorktree?: boolean | undefined;
}

export interface PmGuardAcceptedItem extends PmGuardTarget {
  readonly clientKey: string;
  readonly useWorktree: boolean;
}

export interface PmGuardRejectedItem {
  readonly clientKey: string;
  readonly reason: PmGuardRejectionReason;
  readonly detail: string;
}

export interface PmGuardBatchDecision {
  readonly accepted: ReadonlyArray<PmGuardAcceptedItem>;
  readonly rejected: ReadonlyArray<PmGuardRejectedItem>;
}

const DEFAULT_PM_MAX_DELEGATION_DEPTH = 2;

const ok = <A>(value: A): PmGuardResult<A> => ({ ok: true, value });
const reject = (reason: PmGuardRejectionReason, detail: string): PmGuardRejection => ({
  ok: false,
  reason,
  detail,
});

const normalizeKey = (value: string): string => value.trim().toLowerCase();

const sameTarget = (left: PmGuardTarget, right: PmGuardTarget): boolean =>
  left.environmentId === right.environmentId && left.projectId === right.projectId;

const describeTarget = (target: PmGuardTarget): string =>
  `${target.environmentId}/${target.projectId}`;

export function evaluateKillSwitch(
  state: PmKillSwitchState,
  threadId: ThreadId,
): PmGuardResult<void> {
  if (state.global) return reject("kill_switch_active", "The global PM kill switch is on.");
  if (state.stoppedThreadIds.has(threadId)) {
    return reject("kill_switch_active", `The kill switch is on for thread ${threadId}.`);
  }
  return ok(undefined);
}

export function evaluateDelegationDepth(
  requester: PmRequester,
  allowNestedDelegation: boolean,
  maxDepth: number = DEFAULT_PM_MAX_DELEGATION_DEPTH,
): PmGuardResult<{ readonly childDepth: number }> {
  if (requester.role === "standard") {
    return reject("requester_not_pm", `Thread ${requester.threadId} is not a PM thread.`);
  }
  if (requester.role === "worker" && !allowNestedDelegation) {
    return reject(
      "nested_delegation_forbidden",
      `Worker thread ${requester.threadId} cannot delegate to further workers.`,
    );
  }
  const childDepth = requester.delegationDepth + 1;
  if (childDepth > maxDepth) {
    return reject(
      "delegation_depth_exceeded",
      `Delegation depth ${childDepth} exceeds the limit of ${maxDepth}.`,
    );
  }
  return ok({ childDepth });
}

function remainingWorkerSlots(activeWorkerCount: number, maxConcurrentWorkers: number) {
  return Math.max(0, maxConcurrentWorkers - activeWorkerCount);
}

export function evaluateConcurrency(
  activeWorkerCount: number,
  maxConcurrentWorkers: number,
): PmGuardResult<{ readonly remainingSlots: number }> {
  const remainingSlots = remainingWorkerSlots(activeWorkerCount, maxConcurrentWorkers);
  if (remainingSlots === 0) {
    return reject(
      "concurrency_limit",
      `${activeWorkerCount} of ${maxConcurrentWorkers} workers are already running.`,
    );
  }
  return ok({ remainingSlots });
}

export function evaluateDelegatedTurnBudget(
  delegatedTurnCount: number,
  maxDelegatedTurns: number,
): PmGuardResult<{ readonly remainingTurns: number }> {
  const remainingTurns = Math.max(0, maxDelegatedTurns - delegatedTurnCount);
  if (remainingTurns === 0) {
    return reject(
      "delegated_turn_limit",
      `${delegatedTurnCount} of ${maxDelegatedTurns} delegated turns are used.`,
    );
  }
  return ok({ remainingTurns });
}

function findMembers(
  members: ReadonlyArray<PmGuardRepoMember>,
  request: PmTargetRequest,
): PmGuardResult<PmGuardTarget> {
  const role = request.targetRepoRole === undefined ? "" : normalizeKey(request.targetRepoRole);
  const name = request.targetRepoName === undefined ? "" : normalizeKey(request.targetRepoName);
  if (role === "" && name === "") {
    return reject("target_unresolved", "Name a target repo role, repo name, or explicit target.");
  }
  const matches = members.filter(
    (member) =>
      (role === "" || normalizeKey(member.role) === role) &&
      (name === "" || normalizeKey(member.name) === name),
  );
  const label = [role && `role "${role}"`, name && `name "${name}"`].filter(Boolean).join(", ");
  const [first, second] = matches;
  if (first === undefined) return reject("target_unresolved", `No repo matches ${label}.`);
  if (second !== undefined) {
    return reject(
      "target_ambiguous",
      `${matches.length} repos match ${label}: ${matches.map((member) => member.name).join(", ")}. Add targetRepoName.`,
    );
  }
  return ok({ environmentId: first.environmentId, projectId: first.projectId });
}

/**
 * An empty allow-list falls back to the MetaProject members rather than "anything",
 * so a missing policy entry never opens delegation to arbitrary environments.
 */
export function resolveDispatchTarget(input: {
  readonly request: PmTargetRequest;
  readonly members: ReadonlyArray<PmGuardRepoMember>;
  readonly allowedTargets: ReadonlyArray<PmGuardTarget>;
}): PmGuardResult<PmGuardTarget> {
  const resolved =
    input.request.target === undefined
      ? findMembers(input.members, input.request)
      : ok(input.request.target);
  if (!resolved.ok) return resolved;
  const allowed = input.allowedTargets.length > 0 ? input.allowedTargets : input.members;
  if (!allowed.some((target) => sameTarget(target, resolved.value))) {
    return reject(
      "target_not_allowed",
      `Target ${describeTarget(resolved.value)} is not an allowed worker target.`,
    );
  }
  return resolved;
}

export function evaluateDispatchBatch(input: {
  readonly requester: PmRequester;
  readonly killSwitch: PmKillSwitchState;
  readonly policy: PmGuardPolicy;
  readonly members: ReadonlyArray<PmGuardRepoMember>;
  readonly activeWorkerCount: number;
  readonly delegatedTurnCount: number;
  readonly items: ReadonlyArray<PmGuardBatchItem>;
  readonly maxDelegationDepth?: number;
}): PmGuardBatchDecision {
  const batchGate = [
    evaluateKillSwitch(input.killSwitch, input.requester.threadId),
    evaluateDelegationDepth(
      input.requester,
      input.policy.allowNestedDelegation,
      input.maxDelegationDepth,
    ),
  ].find((result): result is PmGuardRejection => !result.ok);
  if (batchGate !== undefined) {
    return {
      accepted: [],
      rejected: input.items.map((item) => ({
        clientKey: item.clientKey,
        reason: batchGate.reason,
        detail: batchGate.detail,
      })),
    };
  }

  const accepted: Array<PmGuardAcceptedItem> = [];
  const rejected: Array<PmGuardRejectedItem> = [];
  const seenKeys = new Set<string>();
  let activeWorkers = input.activeWorkerCount;
  let delegatedTurns = input.delegatedTurnCount;

  const evaluateBatchItem = (
    item: PmGuardBatchItem,
    duplicate: boolean,
  ): PmGuardResult<PmGuardAcceptedItem> => {
    if (duplicate) {
      return reject("duplicate_client_key", `clientKey "${item.clientKey}" repeats in the batch.`);
    }
    if (input.policy.requireWorktreeIsolation && item.useWorktree === false) {
      return reject("worktree_required", "This PM's policy requires each worker in a worktree.");
    }
    const target = resolveDispatchTarget({
      request: item,
      members: input.members,
      allowedTargets: input.policy.allowedTargets,
    });
    if (!target.ok) return target;
    const concurrency = evaluateConcurrency(activeWorkers, input.policy.maxConcurrentWorkers);
    if (!concurrency.ok) return concurrency;
    const turns = evaluateDelegatedTurnBudget(delegatedTurns, input.policy.maxDelegatedTurns);
    if (!turns.ok) return turns;
    return ok({
      clientKey: item.clientKey,
      environmentId: target.value.environmentId,
      projectId: target.value.projectId,
      useWorktree: item.useWorktree ?? input.policy.requireWorktreeIsolation,
    });
  };

  for (const item of input.items) {
    const outcome = evaluateBatchItem(item, seenKeys.has(item.clientKey));
    seenKeys.add(item.clientKey);
    if (!outcome.ok) {
      rejected.push({ clientKey: item.clientKey, reason: outcome.reason, detail: outcome.detail });
      continue;
    }
    accepted.push(outcome.value);
    activeWorkers += 1;
    delegatedTurns += 1;
  }
  return { accepted, rejected };
}
